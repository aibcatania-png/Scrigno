package app.scrigno.passkey

import android.content.Intent
import android.os.Bundle
import androidx.annotation.RequiresApi
import androidx.credentials.CreatePasswordRequest
import androidx.credentials.CreatePasswordResponse
import androidx.credentials.CreatePublicKeyCredentialRequest
import androidx.credentials.CreatePublicKeyCredentialResponse
import androidx.credentials.GetCredentialResponse
import androidx.credentials.GetPasswordOption
import androidx.credentials.GetPublicKeyCredentialOption
import androidx.credentials.PasswordCredential
import androidx.credentials.PublicKeyCredential
import androidx.credentials.exceptions.CreateCredentialCancellationException
import androidx.credentials.exceptions.CreateCredentialUnknownException
import androidx.credentials.exceptions.GetCredentialCancellationException
import androidx.credentials.exceptions.GetCredentialUnknownException
import androidx.credentials.provider.PendingIntentHandler
import androidx.credentials.provider.ProviderCreateCredentialRequest
import androidx.credentials.provider.ProviderGetCredentialRequest
import app.scrigno.Bio
import app.scrigno.Repo
import app.scrigno.UnlockActivity
import app.scrigno.core.Passkeys
import app.scrigno.core.Vault
import app.scrigno.autofill.Fill
import org.json.JSONObject

/** Crea o usa una passkey (o una password) su richiesta di Android. */
@RequiresApi(34)
class PasskeyActivity : UnlockActivity() {
    private var createReq: ProviderCreateCredentialRequest? = null
    private var getReq: ProviderGetCredentialRequest? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        when (intent.action) {
            ACTION_CREATE -> {
                createReq = PendingIntentHandler.retrieveProviderCreateCredentialRequest(intent)
                if (createReq == null) { finish(); return }
                requireUnlock("Sblocca per salvare in Scrigno")
            }
            ACTION_GET, ACTION_GET_PASSWORD -> {
                getReq = PendingIntentHandler.retrieveProviderGetCredentialRequest(intent)
                if (getReq == null) { finish(); return }
                requireUnlock("Sblocca per accedere")
            }
            ACTION_UNLOCK -> requireUnlock("Sblocca per vedere passkey e password")
            else -> finish()
        }
    }

    override fun onUnlocked(dek: ByteArray, userVerified: Boolean) {
        root.removeAllViews()
        title("Scrigno", "Un momento…")
        when (intent.action) {
            ACTION_UNLOCK -> {
                val begin = PendingIntentHandler.retrieveBeginGetCredentialRequest(intent)
                if (begin == null) { finish(); return }
                io.execute {
                    val resp = Entries.build(this, begin, dek)
                    main.post {
                        val result = Intent()
                        PendingIntentHandler.setBeginGetCredentialResponse(result, resp)
                        setResult(RESULT_OK, result)
                        finish()
                    }
                }
            }
            ACTION_CREATE -> withUv(userVerified, "Conferma per creare la passkey") { uv -> create(dek, uv) }
            ACTION_GET -> withUv(userVerified, "Conferma per accedere con la passkey") { uv -> get(dek, uv) }
            ACTION_GET_PASSWORD -> getPassword(dek)
        }
    }

    /** Le passkey richiedono la verifica dell'utente: se non c'è appena stata, si chiede impronta o PIN. */
    private fun withUv(already: Boolean, title: String, then: (Boolean) -> Unit) {
        if (already) { then(true); return }
        Bio.verifyUser(this, title) { ok, uv -> if (ok) then(uv) else cancel() }
    }

    private fun create(dek: ByteArray, uv: Boolean) {
        val req = createReq!!
        val call = req.callingRequest
        io.execute {
            try {
                when (call) {
                    is CreatePublicKeyCredentialRequest -> {
                        val json = JSONObject(call.requestJson)
                        val (origin, browser) = Origins.resolve(this, req.callingAppInfo)
                        val rp = json.getJSONObject("rp")
                        var rpId = rp.optString("id")
                        if (browser) {
                            val host = Origins.hostOf(origin)
                            if (rpId.isEmpty()) rpId = host
                            require(Vault.rpIdAllowed(rpId, host)) { "Il sito non corrisponde alla passkey richiesta" }
                        }
                        require(rpId.isNotEmpty()) { "Sito della passkey mancante" }
                        val params = json.optJSONArray("pubKeyCredParams")
                        val es256 = params == null || (0 until params.length()).any { params.getJSONObject(it).optInt("alg") == -7 }
                        require(es256) { "Algoritmo non supportato" }
                        val exclude = json.optJSONArray("excludeCredentials")?.let { a -> (0 until a.length()).map { a.getJSONObject(it).optString("id") }.toSet() } ?: emptySet()
                        val existing = Vault.passkeysFor(Repo.items(this, dek), rpId)
                        require(existing.none { Vault.field(it, "credentialId") in exclude }) { "Su questo dispositivo esiste già una passkey per questo account" }
                        val user = json.getJSONObject("user")
                        val c = Passkeys.create(rpId, user.getString("id"), user.optString("name", user.optString("displayName")), uv)
                        val cdj = Passkeys.clientDataJSON("webauthn.create", json.getString("challenge"), origin, if (browser) null else req.callingAppInfo.packageName)
                        val title = rp.optString("name").ifEmpty { rpId }
                        Repo.update(this, dek) { arr -> arr.put(Vault.newItem("passkey", title, c.fields)) }
                        val result = Intent()
                        PendingIntentHandler.setCreateCredentialResponse(result, CreatePublicKeyCredentialResponse(Passkeys.registrationJson(c, cdj)))
                        main.post { setResult(RESULT_OK, result); finish() }
                    }
                    is CreatePasswordRequest -> {
                        val pkg = req.callingAppInfo.packageName
                        Repo.update(this, dek) { arr -> Vault.upsertLogin(arr, null, pkg, Fill.appLabel(this, pkg), call.id, call.password) }
                        val result = Intent()
                        PendingIntentHandler.setCreateCredentialResponse(result, CreatePasswordResponse())
                        main.post { setResult(RESULT_OK, result); finish() }
                    }
                    else -> throw IllegalArgumentException("Richiesta non supportata")
                }
            } catch (e: Exception) {
                val result = Intent()
                PendingIntentHandler.setCreateCredentialException(result, CreateCredentialUnknownException(e.message))
                main.post { setResult(RESULT_OK, result); finish() }
            }
        }
    }

    private fun get(dek: ByteArray, uv: Boolean) {
        val req = getReq!!
        val itemId = intent.getStringExtra(EXTRA_ITEM)
        io.execute {
            try {
                val option = req.credentialOptions.filterIsInstance<GetPublicKeyCredentialOption>().first()
                val json = JSONObject(option.requestJson)
                val (origin, browser) = Origins.resolve(this, req.callingAppInfo)
                val item = Repo.items(this, dek).firstOrNull { it.optString("id") == itemId } ?: throw IllegalStateException("Passkey non trovata")
                val rpId = json.optString("rpId").ifEmpty { if (browser) Origins.hostOf(origin) else "" }
                require(Vault.field(item, "rpId") == rpId) { "La passkey non appartiene a questo sito" }
                if (browser) require(Vault.rpIdAllowed(rpId, Origins.hostOf(origin))) { "Il sito non corrisponde alla passkey" }
                val cdj = Passkeys.clientDataJSON("webauthn.get", json.getString("challenge"), origin, if (browser) null else req.callingAppInfo.packageName)
                val cdh = option.clientDataHash ?: Passkeys.sha256(cdj)
                val (ad, sig) = Passkeys.assert(Vault.field(item, "privateKey"), rpId, cdh, uv)
                val resp = Passkeys.assertionJson(Vault.field(item, "credentialId"), cdj, ad, sig, Vault.field(item, "userHandle"))
                val result = Intent()
                PendingIntentHandler.setGetCredentialResponse(result, GetCredentialResponse(PublicKeyCredential(resp)))
                main.post { setResult(RESULT_OK, result); finish() }
            } catch (e: Exception) {
                val result = Intent()
                PendingIntentHandler.setGetCredentialException(result, GetCredentialUnknownException(e.message))
                main.post { setResult(RESULT_OK, result); finish() }
            }
        }
    }

    private fun getPassword(dek: ByteArray) {
        val req = getReq!!
        val item = Repo.items(this, dek).firstOrNull { it.optString("id") == intent.getStringExtra(EXTRA_ITEM) }
        val result = Intent()
        if (item == null || req.credentialOptions.none { it is GetPasswordOption }) {
            PendingIntentHandler.setGetCredentialException(result, GetCredentialUnknownException("Password non trovata"))
        } else {
            PendingIntentHandler.setGetCredentialResponse(result, GetCredentialResponse(PasswordCredential(Vault.field(item, "username"), Vault.field(item, "password"))))
        }
        setResult(RESULT_OK, result)
        finish()
    }

    override fun cancel() {
        val result = Intent()
        when (intent.action) {
            ACTION_CREATE -> PendingIntentHandler.setCreateCredentialException(result, CreateCredentialCancellationException("Annullato"))
            ACTION_GET, ACTION_GET_PASSWORD -> PendingIntentHandler.setGetCredentialException(result, GetCredentialCancellationException("Annullato"))
            else -> { setResult(RESULT_CANCELED); finish(); return }
        }
        setResult(RESULT_OK, result)
        finish()
    }

    companion object {
        const val ACTION_CREATE = "app.scrigno.passkey.CREATE"
        const val ACTION_GET = "app.scrigno.passkey.GET"
        const val ACTION_GET_PASSWORD = "app.scrigno.passkey.GET_PASSWORD"
        const val ACTION_UNLOCK = "app.scrigno.passkey.UNLOCK"
        const val EXTRA_ITEM = "item"
    }
}
