package app.scrigno.core

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** Verifica che Kotlin legga e scriva lo stesso formato della web app (fixture creata da tests/core.test.js). */
class CompatTest {
    private fun fixture() = JSONObject(javaClass.classLoader!!.getResourceAsStream("fixture-vault.json")!!.readBytes().toString(Charsets.UTF_8))

    @Test fun unlockAndRead() {
        val fx = fixture()
        val file = fx.getJSONObject("file")
        val dek = VaultCrypto.unlock(file, "fixture-password-123")
        assertEquals(fx.getString("dek"), B64.enc(dek))
        val items = Vault.items(VaultCrypto.readItems(file, dek))
        val login = items.first { it.optString("type") == "login" }
        assertEquals("alice", Vault.field(login, "username"))
        assertEquals("s3cret!", Vault.field(login, "password"))
    }

    @Test fun wrongPassword() {
        var thrown = false
        try { VaultCrypto.unlock(fixture().getJSONObject("file"), "sbagliata") } catch (e: WrongPasswordException) { thrown = true }
        assertTrue(thrown)
    }

    @Test fun writeAndReadBack() {
        val fx = fixture()
        val file = fx.getJSONObject("file")
        val dek = B64.dec(fx.getString("dek"))
        val arr = VaultCrypto.readItems(file, dek)
        Vault.upsertLogin(arr, "accounts.example.org", null, null, "bob", "pw1")
        Vault.upsertLogin(arr, null, "com.example.app", "Esempio", "carla", "pw2")
        Vault.upsertLogin(arr, "www.example.org", null, null, "bob", "pw3")
        VaultCrypto.writeItems(file, dek, arr)
        val again = Vault.items(VaultCrypto.readItems(JSONObject(file.toString()), dek))
        assertEquals(4, again.size)
        assertEquals("pw3", Vault.field(Vault.matchLogins(again, "example.org", null).first { Vault.field(it, "username") == "bob" }, "password"))
        assertEquals("carla", Vault.field(Vault.matchLogins(again, null, "com.example.app").first(), "username"))
        System.getenv("SCRIGNO_KT_OUT")?.let { java.io.File(it, "kt-vault.json").writeText(file.toString()) }
    }

    @Test fun totpRfc6238() {
        val cfg = Totp.Cfg(Totp.base32("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"), 8, 30, "HmacSHA1")
        assertEquals("94287082", Totp.code(cfg, 59_000L))
        assertEquals("07081804", Totp.code(cfg, 1111111109_000L))
        assertEquals("65353130", Totp.code(cfg, 20000000000_000L))
        val p = Totp.parse("otpauth://totp/X:me?secret=JBSWY3DPEHPK3PXP&issuer=X&digits=6&algorithm=SHA256")
        assertEquals(6, p.digits)
        assertEquals("HmacSHA256", p.algorithm)
    }

    @Test fun matching() {
        assertEquals("b.co.uk", Vault.baseDomain("a.b.co.uk"))
        assertEquals("google.com", Vault.baseDomain("www.accounts.google.com"))
        assertTrue(Vault.rpIdAllowed("google.com", "accounts.google.com"))
        assertTrue(!Vault.rpIdAllowed("evil.com", "google.com"))
        assertTrue(!Vault.rpIdAllowed("com", "x.com"))
    }

    @Test fun passkeyFromWebApp() {
        // chiave privata creata da WebCrypto (estensione) usata da Kotlin
        val fx = fixture()
        val file = fx.getJSONObject("file")
        val items = Vault.items(VaultCrypto.readItems(file, B64.dec(fx.getString("dek"))))
        val pk = Vault.passkeysFor(items, "example.com").first()
        val cdh = Passkeys.sha256("{}".toByteArray())
        val (ad, sig) = Passkeys.assert(Vault.field(pk, "privateKey"), "example.com", cdh)
        assertTrue(Passkeys.verify(B64.dec(fx.getString("passkeySpki")), ad + cdh, sig))
        assertEquals(0x1d, ad[32].toInt())
    }

    @Test fun passkeyCreateAndAssert() {
        val c = Passkeys.create("example.com", "dXNlcg", "mario")
        assertEquals(138, B64.dec(c.fields.getString("privateKey")).size)
        val cdj = Passkeys.clientDataJSON("webauthn.get", "abc", "https://example.com")
        val cdh = Passkeys.sha256(cdj)
        val (ad, sig) = Passkeys.assert(c.fields.getString("privateKey"), "example.com", cdh)
        assertTrue(Passkeys.verify(c.publicKeySpki, ad + cdh, sig))
        assertEquals(0xa3, c.attestationObject[0].toInt() and 255)
        val reg = JSONObject(Passkeys.registrationJson(c, cdj))
        assertEquals(c.fields.getString("credentialId"), reg.getString("id"))
        assertTrue(String(cdj).contains("\"origin\":\"https://example.com\""))
        // il file per la web app: scritto qui, verificato da tests/kotlin-compat.test.js
        val out = System.getenv("SCRIGNO_KT_OUT")
        if (out != null) {
            java.io.File(out, "kt-passkey.json").writeText(JSONObject().put("privateKey", c.fields.getString("privateKey")).put("spki", B64.enc(c.publicKeySpki))
                .put("attestationObject", B64.enc(c.attestationObject)).put("credentialId", c.fields.getString("credentialId")).toString())
        }
        JSONArray()
    }
}
