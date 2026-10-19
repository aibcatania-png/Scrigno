package app.scrigno.core

import org.json.JSONArray
import org.json.JSONObject
import java.security.SecureRandom
import java.util.Base64
import javax.crypto.AEADBadTagException
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/** Base64 standard e URL-safe (senza padding), come nella web app. */
object B64 {
    fun enc(b: ByteArray): String = Base64.getEncoder().encodeToString(b)
    fun dec(s: String): ByteArray = Base64.getDecoder().decode(s)
    fun urlEnc(b: ByteArray): String = Base64.getUrlEncoder().withoutPadding().encodeToString(b)
    fun urlDec(s: String): ByteArray = Base64.getUrlDecoder().decode(s.trimEnd('='))
}

class WrongPasswordException : Exception("Password errata")

/**
 * Formato del vault identico alla web app (core.js):
 * PBKDF2-SHA256 → chiave che avvolge la DEK (AES-GCM, senza AAD);
 * la DEK cifra {"items":[...]} con AES-GCM e AAD "scrigno-v1".
 */
object VaultCrypto {
    private val AAD = "scrigno-v1".toByteArray(Charsets.UTF_8)
    private val rnd = SecureRandom()

    fun random(n: Int): ByteArray = ByteArray(n).also { rnd.nextBytes(it) }

    /** PBKDF2-HMAC-SHA256 con un solo blocco (chiave da 32 byte), password in UTF-8. */
    fun pbkdf2(password: String, salt: ByteArray, iterations: Int): ByteArray {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(password.toByteArray(Charsets.UTF_8), "HmacSHA256"))
        mac.update(salt)
        mac.update(byteArrayOf(0, 0, 0, 1))
        var u = mac.doFinal()
        val t = u.copyOf()
        for (i in 1 until iterations) {
            u = mac.doFinal(u)
            for (j in t.indices) t[j] = (t[j].toInt() xor u[j].toInt()).toByte()
        }
        return t
    }

    fun gcmDecrypt(key: ByteArray, iv: ByteArray, ct: ByteArray, aad: ByteArray?): ByteArray {
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, iv))
        if (aad != null) c.updateAAD(aad)
        return c.doFinal(ct)
    }

    fun gcmEncrypt(key: ByteArray, plain: ByteArray, aad: ByteArray?): JSONObject {
        val iv = random(12)
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, iv))
        if (aad != null) c.updateAAD(aad)
        return JSONObject().put("iv", B64.enc(iv)).put("ct", B64.enc(c.doFinal(plain)))
    }

    /** Ricava la DEK dalla master password. */
    fun unlock(file: JSONObject, password: String): ByteArray {
        val kdf = file.getJSONObject("kdf")
        val kek = pbkdf2(password, B64.dec(kdf.getString("salt")), kdf.getInt("iter"))
        val w = file.getJSONObject("keys").getJSONObject("pw")
        try {
            return gcmDecrypt(kek, B64.dec(w.getString("iv")), B64.dec(w.getString("ct")), null)
        } catch (e: AEADBadTagException) {
            throw WrongPasswordException()
        }
    }

    fun readItems(file: JSONObject, dek: ByteArray): JSONArray {
        val data = file.optJSONObject("data") ?: return JSONArray()
        val plain = gcmDecrypt(dek, B64.dec(data.getString("iv")), B64.dec(data.getString("ct")), AAD)
        return JSONObject(String(plain, Charsets.UTF_8)).optJSONArray("items") ?: JSONArray()
    }

    fun writeItems(file: JSONObject, dek: ByteArray, items: JSONArray) {
        val plain = JSONObject().put("items", items).toString().toByteArray(Charsets.UTF_8)
        file.put("data", gcmEncrypt(dek, plain, AAD))
        file.put("updatedAt", System.currentTimeMillis())
    }
}
