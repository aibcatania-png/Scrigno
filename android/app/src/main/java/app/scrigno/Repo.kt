package app.scrigno

import android.content.Context
import android.util.AtomicFile
import app.scrigno.core.VaultCrypto
import app.scrigno.core.Vault
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/** File dell'app: lo stesso vault usato dall'interfaccia, dalla compilazione automatica e dalle passkey. */
object Repo {
    private val KEY = Regex("^[a-zA-Z0-9_-]{1,40}$")

    private fun file(ctx: Context, key: String): File {
        require(KEY.matches(key)) { "Chiave non valida" }
        val dir = File(ctx.filesDir, "kv").apply { mkdirs() }
        return File(dir, "$key.json")
    }

    @Synchronized fun get(ctx: Context, key: String): String? {
        val f = file(ctx, key)
        return if (f.exists()) AtomicFile(f).readFully().toString(Charsets.UTF_8) else null
    }

    @Synchronized fun set(ctx: Context, key: String, json: String) {
        val af = AtomicFile(file(ctx, key))
        val out = af.startWrite()
        try { out.write(json.toByteArray(Charsets.UTF_8)); af.finishWrite(out) } catch (e: Exception) { af.failWrite(out); throw e }
    }

    @Synchronized fun del(ctx: Context, key: String) { AtomicFile(file(ctx, key)).delete() }

    fun vault(ctx: Context): JSONObject? = get(ctx, "vault")?.let { JSONObject(it) }

    @Synchronized fun items(ctx: Context, dek: ByteArray): List<JSONObject> {
        val f = vault(ctx) ?: return emptyList()
        return Vault.items(VaultCrypto.readItems(f, dek))
    }

    /** Legge, modifica e riscrive il vault in un'unica operazione. */
    @Synchronized fun <T> update(ctx: Context, dek: ByteArray, fn: (JSONArray) -> T): T {
        val f = vault(ctx) ?: throw IllegalStateException("Nessun vault su questo dispositivo")
        val arr = VaultCrypto.readItems(f, dek)
        val r = fn(arr)
        VaultCrypto.writeItems(f, dek, arr)
        set(ctx, "vault", f.toString())
        return r
    }
}

/** Chiave del vault sbloccato, condivisa tra app, compilazione automatica e passkey. Solo in memoria. */
object Session {
    private var dek: ByteArray? = null
    private var expires = 0L

    @Synchronized fun set(ctx: Context, key: ByteArray, ttlMin: Int? = null) {
        val prefs = ctx.getSharedPreferences("session", Context.MODE_PRIVATE)
        val ttl = ttlMin ?: prefs.getInt("ttlMin", 5)
        if (ttlMin != null) prefs.edit().putInt("ttlMin", ttlMin).apply()
        dek = key.copyOf()
        expires = if (ttl > 0) System.currentTimeMillis() + ttl * 60_000L else Long.MAX_VALUE
    }

    @Synchronized fun get(): ByteArray? {
        if (dek != null && System.currentTimeMillis() > expires) clear()
        return dek
    }

    @Synchronized fun clear() { dek?.fill(0); dek = null }
}
