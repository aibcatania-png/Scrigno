package app.scrigno.autofill

import android.content.Context
import android.content.Intent
import android.content.IntentSender
import android.os.Build
import android.os.Bundle
import android.view.autofill.AutofillManager
import android.widget.Toast
import app.scrigno.Repo
import app.scrigno.UnlockActivity
import app.scrigno.core.Vault

/** Finestra della compilazione automatica: sblocca, cerca un login o salva quello appena inserito. */
class AutofillActivity : UnlockActivity() {
    private lateinit var target: Target
    private lateinit var mode: String

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val t: Target? = if (Build.VERSION.SDK_INT >= 33) intent.getParcelableExtra(EXTRA_TARGET, Target::class.java)
        else @Suppress("DEPRECATION") intent.getParcelableExtra(EXTRA_TARGET)
        if (t == null) { finish(); return }
        target = t
        mode = intent.getStringExtra(EXTRA_MODE) ?: MODE_FILL
        val where = target.webDomain ?: Fill.appLabel(this, target.pkg) ?: target.pkg
        requireUnlock(if (mode == MODE_SAVE) "Sblocca per salvare il login di $where" else "Sblocca per compilare $where")
    }

    override fun onUnlocked(dek: ByteArray, userVerified: Boolean) {
        if (mode == MODE_SAVE) {
            io.execute {
                val msg = try {
                    Repo.update(this, dek) { arr ->
                        Vault.upsertLogin(arr, target.webDomain, target.matchPkg, Fill.appLabel(this, target.pkg), target.username ?: "", target.password ?: "")
                    }
                    "Login salvato in Scrigno"
                } catch (e: Exception) { e.message ?: "Salvataggio non riuscito" }
                main.post { Toast.makeText(this, msg, Toast.LENGTH_SHORT).show(); setResult(RESULT_OK); finish() }
            }
            return
        }
        val items = Repo.items(this, dek)
        val logins = items.filter { it.optString("type") == "login" }.sortedBy { it.optString("title").lowercase() }
        val preferred = Vault.matchLogins(items, target.webDomain, target.matchPkg)
        val where = target.webDomain ?: Fill.appLabel(this, target.pkg) ?: target.pkg
        showPicker("Scegli un login", where, logins, preferred,
            { it.optString("title") + Vault.field(it, "username").let { u -> if (u.isEmpty()) "" else " · $u" } }) { item ->
            // Ricorda l'associazione con l'app, così la prossima volta il login viene proposto subito.
            if (target.webDomain.isNullOrEmpty() && Vault.appOf(item) != target.pkg) {
                val id = item.optString("id")
                io.execute { try { Repo.update(this, dek) { arr -> Vault.items(arr).firstOrNull { it.optString("id") == id }?.let { Vault.linkApp(it, target.pkg) } } } catch (_: Exception) { } }
            }
            val ds = if (target.otpId != null && target.passwordId == null) Fill.otpDataset(this, item, target) else Fill.dataset(this, item, target)
            if (ds == null) { Toast.makeText(this, "Questo login non ha un codice 2FA", Toast.LENGTH_SHORT).show(); return@showPicker }
            setResult(RESULT_OK, Intent().putExtra(AutofillManager.EXTRA_AUTHENTICATION_RESULT, ds))
            finish()
        }
    }

    companion object {
        const val MODE_FILL = "fill"
        const val MODE_SAVE = "save"
        private const val EXTRA_TARGET = "target"
        private const val EXTRA_MODE = "mode"

        fun intentSender(ctx: Context, mode: String, t: Target): IntentSender =
            pendingSender(ctx, Intent(ctx, AutofillActivity::class.java).putExtra(EXTRA_MODE, mode).putExtra(EXTRA_TARGET, t))
    }
}
