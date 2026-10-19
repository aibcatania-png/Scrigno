package app.scrigno.core

import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.math.BigInteger
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.MessageDigest
import java.security.Signature
import java.security.interfaces.ECPrivateKey
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.security.spec.PKCS8EncodedKeySpec

/**
 * Autenticatore WebAuthn software (ES256), stesso formato di passkey.js:
 * PKCS#8 con chiave pubblica, credentialId 16 byte, attestazione "none", contatore 0, flag BE/BS.
 */
object Passkeys {
    private val AAGUID = byteArrayOf(0x5c, 0x7a, 0x3f, 0x20, 0x9b.toByte(), 0x1e, 0x4d, 0x8a.toByte(), 0xa6.toByte(), 0xc3.toByte(), 0x2f, 0x0e, 0x8b.toByte(), 0x4d, 0x1a, 0x77)
    const val UP = 0x01; const val UV = 0x04; const val BE = 0x08; const val BS = 0x10; const val AT = 0x40

    // ------------------------------------------------------------ CBOR minimale
    private fun head(out: ByteArrayOutputStream, major: Int, n: Long) {
        val m = major shl 5
        when {
            n < 24 -> out.write(m or n.toInt())
            n < 0x100 -> { out.write(m or 24); out.write(n.toInt()) }
            n < 0x10000 -> { out.write(m or 25); out.write((n shr 8).toInt() and 255); out.write(n.toInt() and 255) }
            else -> { out.write(m or 26); for (s in intArrayOf(24, 16, 8, 0)) out.write((n shr s).toInt() and 255) }
        }
    }
    fun cbor(v: Any, out: ByteArrayOutputStream = ByteArrayOutputStream()): ByteArray {
        when (v) {
            is Int -> if (v >= 0) head(out, 0, v.toLong()) else head(out, 1, (-1L - v))
            is ByteArray -> { head(out, 2, v.size.toLong()); out.write(v) }
            is String -> { val b = v.toByteArray(Charsets.UTF_8); head(out, 3, b.size.toLong()); out.write(b) }
            is List<*> -> { head(out, 4, v.size.toLong()); v.forEach { cbor(it!!, out) } }
            is Map<*, *> -> { head(out, 5, v.size.toLong()); v.forEach { (k, x) -> cbor(k!!, out); cbor(x!!, out) } }
            else -> throw IllegalArgumentException("CBOR: tipo non supportato")
        }
        return out.toByteArray()
    }

    fun sha256(b: ByteArray): ByteArray = MessageDigest.getInstance("SHA-256").digest(b)
    private fun cat(vararg parts: ByteArray): ByteArray = ByteArrayOutputStream().apply { parts.forEach { write(it) } }.toByteArray()
    private fun fixed32(b: BigInteger): ByteArray {
        val raw = b.toByteArray()
        return when {
            raw.size == 32 -> raw
            raw.size > 32 -> raw.copyOfRange(raw.size - 32, raw.size)
            else -> ByteArray(32 - raw.size) + raw
        }
    }

    /** PKCS#8 per P-256 con chiave pubblica inclusa (come lo esporta WebCrypto). */
    fun pkcs8(d: ByteArray, x: ByteArray, y: ByteArray): ByteArray {
        val prefix = byteArrayOf(0x30, 0x81.toByte(), 0x87.toByte(), 0x02, 0x01, 0x00, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86.toByte(), 0x48, 0xce.toByte(), 0x3d, 0x02, 0x01,
            0x06, 0x08, 0x2a, 0x86.toByte(), 0x48, 0xce.toByte(), 0x3d, 0x03, 0x01, 0x07, 0x04, 0x6d, 0x30, 0x6b, 0x02, 0x01, 0x01, 0x04, 0x20)
        val mid = byteArrayOf(0xa1.toByte(), 0x44, 0x03, 0x42, 0x00, 0x04)
        return cat(prefix, d, mid, x, y)
    }

    private fun authData(rpId: String, flags: Int, attested: ByteArray? = null): ByteArray {
        val base = cat(sha256(rpId.toByteArray(Charsets.UTF_8)), byteArrayOf(flags.toByte()), byteArrayOf(0, 0, 0, 0))
        return if (attested != null) cat(base, attested) else base
    }

    class Created(val fields: JSONObject, val credentialId: ByteArray, val attestationObject: ByteArray, val authenticatorData: ByteArray, val publicKeySpki: ByteArray)

    fun create(rpId: String, userId: String, userName: String, uv: Boolean = true): Created {
        val kpg = KeyPairGenerator.getInstance("EC")
        kpg.initialize(ECGenParameterSpec("secp256r1"))
        val kp = kpg.generateKeyPair()
        val pub = kp.public as ECPublicKey
        val x = fixed32(pub.w.affineX)
        val y = fixed32(pub.w.affineY)
        val d = fixed32((kp.private as ECPrivateKey).s)
        val credId = VaultCrypto.random(16)
        val cose = cbor(linkedMapOf<Any, Any>(1 to 2, 3 to -7, -1 to 1, -2 to x, -3 to y))
        val attested = cat(AAGUID, byteArrayOf((credId.size shr 8).toByte(), (credId.size and 255).toByte()), credId, cose)
        val ad = authData(rpId, UP or (if (uv) UV else 0) or BE or BS or AT, attested)
        val att = cbor(linkedMapOf<Any, Any>("fmt" to "none", "attStmt" to linkedMapOf<Any, Any>(), "authData" to ad))
        val fields = JSONObject().put("rpId", rpId).put("username", userName).put("credentialId", B64.urlEnc(credId))
            .put("userHandle", userId).put("privateKey", B64.enc(pkcs8(d, x, y)))
        return Created(fields, credId, att, ad, pub.encoded)
    }

    /** DER ECDSA: Signature di Java produce già il formato richiesto da WebAuthn. */
    fun assert(privateKeyB64: String, rpId: String, clientDataHash: ByteArray, uv: Boolean = true): Pair<ByteArray, ByteArray> {
        val key = KeyFactory.getInstance("EC").generatePrivate(PKCS8EncodedKeySpec(B64.dec(privateKeyB64)))
        val ad = authData(rpId, UP or (if (uv) UV else 0) or BE or BS)
        val sig = Signature.getInstance("SHA256withECDSA").apply { initSign(key); update(ad); update(clientDataHash) }.sign()
        return ad to sig
    }

    fun clientDataJSON(type: String, challenge: String, origin: String, pkg: String? = null): ByteArray {
        val o = JSONObject().put("type", type).put("challenge", challenge).put("origin", origin).put("crossOrigin", false)
        if (pkg != null) o.put("androidPackageName", pkg)
        return o.toString().replace("\\/", "/").toByteArray(Charsets.UTF_8)
    }

    fun registrationJson(c: Created, clientDataJSON: ByteArray): String {
        val id = B64.urlEnc(c.credentialId)
        val resp = JSONObject().put("clientDataJSON", B64.urlEnc(clientDataJSON)).put("attestationObject", B64.urlEnc(c.attestationObject))
            .put("transports", JSONArray().put("internal").put("hybrid")).put("authenticatorData", B64.urlEnc(c.authenticatorData))
            .put("publicKey", B64.urlEnc(c.publicKeySpki)).put("publicKeyAlgorithm", -7)
        return JSONObject().put("id", id).put("rawId", id).put("type", "public-key").put("authenticatorAttachment", "platform")
            .put("response", resp).put("clientExtensionResults", JSONObject().put("credProps", JSONObject().put("rk", true))).toString()
    }

    fun assertionJson(credentialId: String, clientDataJSON: ByteArray, authData: ByteArray, signature: ByteArray, userHandle: String): String {
        val resp = JSONObject().put("clientDataJSON", B64.urlEnc(clientDataJSON)).put("authenticatorData", B64.urlEnc(authData))
            .put("signature", B64.urlEnc(signature)).put("userHandle", userHandle)
        return JSONObject().put("id", credentialId).put("rawId", credentialId).put("type", "public-key").put("authenticatorAttachment", "platform")
            .put("response", resp).put("clientExtensionResults", JSONObject()).toString()
    }

    /** Verifica (usata nei test). */
    fun verify(spki: ByteArray, data: ByteArray, sig: ByteArray): Boolean {
        val pub = KeyFactory.getInstance("EC").generatePublic(java.security.spec.X509EncodedKeySpec(spki))
        return Signature.getInstance("SHA256withECDSA").apply { initVerify(pub); update(data) }.verify(sig)
    }
}
