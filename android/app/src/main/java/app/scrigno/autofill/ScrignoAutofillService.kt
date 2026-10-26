package app.scrigno.autofill

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.IntentSender
import android.content.pm.PackageManager
import android.os.Build
import android.os.CancellationSignal
import android.service.autofill.AutofillService
import android.service.autofill.Dataset
import android.service.autofill.FillCallback
import android.service.autofill.FillRequest
import android.service.autofill.FillResponse
import android.service.autofill.SaveCallback
import android.service.autofill.SaveInfo
import android.service.autofill.SaveRequest
import android.view.autofill.AutofillValue
import android.widget.RemoteViews
import app.scrigno.AfPrefs
import app.scrigno.R
import app.scrigno.Repo
import app.scrigno.Session
import app.scrigno.core.Totp
import app.scrigno.core.Vault
import org.json.JSONObject

/** Servizio di compilazione automatica di Android: propone i login di Scrigno in app e browser. */
class ScrignoAutofillService : AutofillService() {

    override fun onFillRequest(request: FillRequest, cancellationSignal: CancellationSignal, callback: FillCallback) {
        val t = try { StructureParser.parse(request.fillContexts.last().structure) } catch (e: Exception) { callback.onSuccess(null); return }
        if (t.pkg == packageName || t.ids.isEmpty()) { callback.onSuccess(null); return }
        val prefs = AfPrefs.load(this)
        if (prefs.ignored(t.webDomain)) { callback.onSuccess(null); return }
        val resp = FillResponse.Builder()
        val dek = Session.get()
        if (dek == null && !prefs.lockedSuggest) { callback.onSuccess(null); return }
        if (dek != null) {
            val items = try { Repo.items(this, dek) } catch (e: Exception) { emptyList() }
            val matches = Vault.matchLogins(items, t.webDomain, t.matchPkg, prefs.exactMatch)
            if (t.otpId != null && t.passwordId == null) {
                matches.filter { Vault.field(it, "totp").isNotEmpty() }.take(4).forEach { item ->
                    Fill.otpDataset(this, item, t)?.let { resp.addDataset(it) }
                }
            } else {
                matches.take(6).forEach { resp.addDataset(Fill.dataset(this, it, t)) }
            }
        }
        resp.addDataset(Fill.authDataset(this, t, if (dek == null) "Sblocca Scrigno" else "Cerca in Scrigno…"))
        if (t.passwordId != null && prefs.askSave) {
            val type = SaveInfo.SAVE_DATA_TYPE_PASSWORD or (if (t.usernameId != null) SaveInfo.SAVE_DATA_TYPE_USERNAME else 0)
            resp.setSaveInfo(SaveInfo.Builder(type, listOfNotNull(t.usernameId, t.passwordId).toTypedArray()).build())
        }
        callback.onSuccess(resp.build())
    }

    override fun onSaveRequest(request: SaveRequest, callback: SaveCallback) {
        val t = try { StructureParser.parse(request.fillContexts.last().structure) } catch (e: Exception) { callback.onSuccess(); return }
        val pw = t.password
        if (pw.isNullOrEmpty() || t.pkg == packageName || AfPrefs.load(this).ignored(t.webDomain)) { callback.onSuccess(); return }
        val dek = Session.get()
        if (dek != null) {
            try {
                Repo.update(this, dek) { arr -> Vault.upsertLogin(arr, t.webDomain, t.matchPkg, Fill.appLabel(this, t.pkg), t.username ?: "", pw) }
                callback.onSuccess()
            } catch (e: Exception) { callback.onFailure(e.message ?: "Salvataggio non riuscito") }
            return
        }
        if (Build.VERSION.SDK_INT >= 28) callback.onSuccess(AutofillActivity.intentSender(this, AutofillActivity.MODE_SAVE, t))
        else callback.onFailure("Sblocca Scrigno e riprova a salvare")
    }
}

object Fill {
    fun appLabel(ctx: Context, pkg: String): String? = try {
        val pm = ctx.packageManager
        pm.getApplicationLabel(pm.getApplicationInfo(pkg, PackageManager.GET_META_DATA)).toString()
    } catch (e: Exception) { null }

    fun presentation(ctx: Context, title: String, sub: String?): RemoteViews =
        RemoteViews(ctx.packageName, R.layout.autofill_item).apply {
            setTextViewText(R.id.title, title)
            setTextViewText(R.id.subtitle, sub ?: "")
        }

    @Suppress("DEPRECATION")
    fun dataset(ctx: Context, item: JSONObject, t: Target): Dataset {
        val user = Vault.field(item, "username")
        val b = Dataset.Builder(presentation(ctx, item.optString("title"), user.ifEmpty { "Scrigno" }))
        var any = false
        t.usernameId?.let { if (user.isNotEmpty()) { b.setValue(it, AutofillValue.forText(user)); any = true } }
        t.passwordId?.let { val p = Vault.field(item, "password"); if (p.isNotEmpty()) { b.setValue(it, AutofillValue.forText(p)); any = true } }
        if (!any) t.ids.firstOrNull()?.let { b.setValue(it, AutofillValue.forText(user)) }
        return b.build()
    }

    @Suppress("DEPRECATION")
    fun otpDataset(ctx: Context, item: JSONObject, t: Target): Dataset? {
        val code = try { Totp.code(Totp.parse(Vault.field(item, "totp"))) } catch (e: Exception) { return null }
        return Dataset.Builder(presentation(ctx, "Codice 2FA $code", item.optString("title")))
            .setValue(t.otpId!!, AutofillValue.forText(code)).build()
    }

    @Suppress("DEPRECATION")
    fun authDataset(ctx: Context, t: Target, label: String): Dataset {
        val b = Dataset.Builder(presentation(ctx, label, t.webDomain ?: appLabel(ctx, t.pkg)))
        t.ids.forEach { b.setValue(it, null) }
        b.setAuthentication(AutofillActivity.intentSender(ctx, AutofillActivity.MODE_FILL, t))
        return b.build()
    }

    fun pendingFlags() = PendingIntent.FLAG_CANCEL_CURRENT or (if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0)
}

private var requestCode = 1000
internal fun nextRequestCode(): Int = synchronized(Fill) { ++requestCode }

internal fun pendingSender(ctx: Context, intent: Intent): IntentSender =
    PendingIntent.getActivity(ctx, nextRequestCode(), intent, Fill.pendingFlags()).intentSender
