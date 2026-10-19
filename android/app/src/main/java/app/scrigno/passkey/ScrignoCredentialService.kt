package app.scrigno.passkey

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.CancellationSignal
import android.os.OutcomeReceiver
import androidx.annotation.RequiresApi
import androidx.credentials.exceptions.ClearCredentialException
import androidx.credentials.exceptions.CreateCredentialException
import androidx.credentials.exceptions.CreateCredentialUnknownException
import androidx.credentials.exceptions.GetCredentialException
import androidx.credentials.exceptions.GetCredentialUnknownException
import androidx.credentials.provider.AuthenticationAction
import androidx.credentials.provider.BeginCreateCredentialRequest
import androidx.credentials.provider.BeginCreateCredentialResponse
import androidx.credentials.provider.BeginCreatePasswordCredentialRequest
import androidx.credentials.provider.BeginCreatePublicKeyCredentialRequest
import androidx.credentials.provider.BeginGetCredentialRequest
import androidx.credentials.provider.BeginGetCredentialResponse
import androidx.credentials.provider.BeginGetPasswordOption
import androidx.credentials.provider.BeginGetPublicKeyCredentialOption
import androidx.credentials.provider.CallingAppInfo
import androidx.credentials.provider.CreateEntry
import androidx.credentials.provider.CredentialProviderService
import androidx.credentials.provider.PasswordCredentialEntry
import androidx.credentials.provider.ProviderClearCredentialStateRequest
import androidx.credentials.provider.PublicKeyCredentialEntry
import app.scrigno.Repo
import app.scrigno.Session
import app.scrigno.core.B64
import app.scrigno.core.Passkeys
import app.scrigno.core.Vault
import org.json.JSONObject
import java.io.File
import java.net.URL
import java.net.URI

/** Fornitore di credenziali di Android 14+: crea e usa le passkey (e le password) salvate in Scrigno. */
@RequiresApi(34)
class ScrignoCredentialService : CredentialProviderService() {

    override fun onBeginCreateCredentialRequest(
        request: BeginCreateCredentialRequest,
        cancellationSignal: CancellationSignal,
        callback: OutcomeReceiver<BeginCreateCredentialResponse, CreateCredentialException>,
    ) {
        val action = when (request) {
            is BeginCreatePublicKeyCredentialRequest -> PasskeyActivity.ACTION_CREATE
            is BeginCreatePasswordCredentialRequest -> PasskeyActivity.ACTION_CREATE
            else -> { callback.onError(CreateCredentialUnknownException("Tipo non supportato")); return }
        }
        if (Repo.vault(this) == null) { callback.onResult(BeginCreateCredentialResponse.Builder().build()); return }
        val pi = Entries.pending(this, action, null)
        val entry = CreateEntry.Builder("Scrigno", pi).setDescription("Salva nel tuo vault Scrigno").build()
        callback.onResult(BeginCreateCredentialResponse.Builder().addCreateEntry(entry).build())
    }

    override fun onBeginGetCredentialRequest(
        request: BeginGetCredentialRequest,
        cancellationSignal: CancellationSignal,
        callback: OutcomeReceiver<BeginGetCredentialResponse, GetCredentialException>,
    ) {
        try {
            if (Repo.vault(this) == null) { callback.onResult(BeginGetCredentialResponse.Builder().build()); return }
            val dek = Session.get()
            if (dek == null) {
                val pi = Entries.pending(this, PasskeyActivity.ACTION_UNLOCK, null)
                callback.onResult(BeginGetCredentialResponse.Builder().addAuthenticationAction(AuthenticationAction("Sblocca Scrigno", pi)).build())
                return
            }
            callback.onResult(Entries.build(this, request, dek))
        } catch (e: Exception) {
            callback.onError(GetCredentialUnknownException(e.message))
        }
    }

    override fun onClearCredentialStateRequest(
        request: ProviderClearCredentialStateRequest,
        cancellationSignal: CancellationSignal,
        callback: OutcomeReceiver<Void?, ClearCredentialException>,
    ) {
        callback.onResult(null)
    }
}

/** Voci mostrate dal selettore di credenziali di Android. */
@RequiresApi(34)
object Entries {
    private var code = 5000

    fun pending(ctx: Context, action: String, itemId: String?): PendingIntent {
        val i = Intent(ctx, PasskeyActivity::class.java).setAction(action).setPackage(ctx.packageName)
        if (itemId != null) i.putExtra(PasskeyActivity.EXTRA_ITEM, itemId)
        val rc = synchronized(this) { ++code }
        return PendingIntent.getActivity(ctx, rc, i, PendingIntent.FLAG_MUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }

    fun build(ctx: Context, request: BeginGetCredentialRequest, dek: ByteArray): BeginGetCredentialResponse {
        val items = Repo.items(ctx, dek)
        val b = BeginGetCredentialResponse.Builder()
        for (option in request.beginGetCredentialOptions) {
            when (option) {
                is BeginGetPublicKeyCredentialOption -> {
                    val json = JSONObject(option.requestJson)
                    val rpId = json.optString("rpId")
                    val allow = json.optJSONArray("allowCredentials")?.let { a -> (0 until a.length()).map { a.getJSONObject(it).optString("id") }.toSet() } ?: emptySet()
                    Vault.passkeysFor(items, rpId).filter { allow.isEmpty() || Vault.field(it, "credentialId") in allow }.forEach { item ->
                        val user = Vault.field(item, "username").ifEmpty { item.optString("title") }
                        b.addCredentialEntry(
                            PublicKeyCredentialEntry.Builder(ctx, user, pending(ctx, PasskeyActivity.ACTION_GET, item.optString("id")), option)
                                .setDisplayName(item.optString("title")).build(),
                        )
                    }
                }
                is BeginGetPasswordOption -> {
                    val pkg = request.callingAppInfo?.packageName
                    if (pkg != null) {
                        Vault.matchLogins(items, null, pkg).filter { Vault.field(it, "password").isNotEmpty() }.forEach { item ->
                            b.addCredentialEntry(
                                PasswordCredentialEntry.Builder(ctx, Vault.field(item, "username").ifEmpty { item.optString("title") },
                                    pending(ctx, PasskeyActivity.ACTION_GET_PASSWORD, item.optString("id")), option)
                                    .setDisplayName(item.optString("title")).build(),
                            )
                        }
                    }
                }
            }
        }
        return b.build()
    }
}

/** Origine di chi chiede la passkey: sito web (browser riconosciuti da Google) o app Android. */
@RequiresApi(34)
object Origins {
    private const val LIST_URL = "https://www.gstatic.com/gpm-passkeys-privileged-apps/apps.json"

    private fun allowlist(ctx: Context): String? {
        val f = File(ctx.filesDir, "privileged-apps.json")
        val fresh = f.exists() && System.currentTimeMillis() - f.lastModified() < 24 * 3600_000L
        if (!fresh) {
            try {
                val conn = URL(LIST_URL).openConnection().apply { connectTimeout = 5000; readTimeout = 5000 }
                val text = conn.getInputStream().use { it.readBytes().toString(Charsets.UTF_8) }
                JSONObject(text)
                f.writeText(text)
            } catch (_: Exception) { }
        }
        return if (f.exists()) f.readText() else null
    }

    fun appOrigin(info: CallingAppInfo): String {
        val si = info.signingInfo
        val signers = if (si.hasMultipleSigners()) si.apkContentsSigners else si.signingCertificateHistory
        return "android:apk-key-hash:" + B64.urlEnc(Passkeys.sha256(signers[0].toByteArray()))
    }

    /** Ritorna (origine, èBrowser). */
    fun resolve(ctx: Context, info: CallingAppInfo): Pair<String, Boolean> {
        if (info.isOriginPopulated()) {
            val list = allowlist(ctx)
            if (list != null) {
                try { info.getOrigin(list)?.let { return it.trimEnd('/') to true } } catch (_: Exception) { }
            }
            throw SecurityException("Browser non riconosciuto per le passkey")
        }
        return appOrigin(info) to false
    }

    fun hostOf(origin: String): String = try { URI(origin).host ?: "" } catch (_: Exception) { "" }

}
