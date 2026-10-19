package app.scrigno

import android.graphics.Typeface
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.text.Editable
import android.text.InputType
import android.text.TextWatcher
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.view.inputmethod.EditorInfo
import android.widget.ArrayAdapter
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ListView
import android.widget.ProgressBar
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import app.scrigno.core.Vault
import app.scrigno.core.VaultCrypto
import app.scrigno.core.WrongPasswordException
import org.json.JSONObject
import java.util.concurrent.Executors

/**
 * Base delle finestre usate fuori dall'app (compilazione automatica, passkey):
 * sblocco con master password o biometria, e un elenco di elementi tra cui scegliere.
 */
abstract class UnlockActivity : AppCompatActivity() {
    protected val io = Executors.newSingleThreadExecutor()
    protected val main = Handler(Looper.getMainLooper())
    protected lateinit var root: LinearLayout

    /** Chiamato quando il vault è disponibile. viaPassword = l'utente ha appena verificato la propria identità. */
    abstract fun onUnlocked(dek: ByteArray, userVerified: Boolean)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE)
        root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            val p = dp(20)
            setPadding(p, p, p, p)
        }
        setContentView(root, LinearLayout.LayoutParams(dp(340), LinearLayout.LayoutParams.WRAP_CONTENT))
        setFinishOnTouchOutside(false)
    }

    protected fun dp(v: Int) = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v.toFloat(), resources.displayMetrics).toInt()

    protected fun title(text: String, sub: String? = null) {
        root.addView(TextView(this).apply {
            this.text = text
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 19f)
            setTypeface(typeface, Typeface.BOLD)
        })
        if (sub != null) root.addView(TextView(this).apply {
            this.text = sub
            setPadding(0, dp(4), 0, dp(12))
        })
    }

    protected fun button(text: String, onClick: () -> Unit) = Button(this).apply {
        this.text = text
        isAllCaps = false
        setOnClickListener { onClick() }
        root.addView(this, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT))
    }

    /** Se il vault è già sbloccato procede subito, altrimenti mostra lo sblocco. */
    protected fun requireUnlock(reason: String) {
        val dek = Session.get()
        if (dek != null) { onUnlocked(dek, false); return }
        if (Repo.vault(this) == null) {
            root.removeAllViews()
            title("Scrigno", "Apri l'app Scrigno e crea o scarica il tuo vault.")
            button("Chiudi") { cancel() }
            return
        }
        showUnlock(reason)
    }

    private fun showUnlock(reason: String) {
        root.removeAllViews()
        title("Sblocca Scrigno", reason)
        val pw = EditText(this).apply {
            hint = "Master password"
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
            imeOptions = EditorInfo.IME_ACTION_DONE
            isSingleLine = true
        }
        root.addView(pw)
        val error = TextView(this).apply { setTextColor(0xFFC0392B.toInt()); visibility = View.GONE }
        root.addView(error)
        val progress = ProgressBar(this).apply { visibility = View.GONE }
        root.addView(progress)
        val go = {
            progress.visibility = View.VISIBLE
            error.visibility = View.GONE
            val text = pw.text.toString()
            io.execute {
                try {
                    val f = Repo.vault(this) ?: throw IllegalStateException("Nessun vault")
                    val dek = VaultCrypto.unlock(f, text)
                    Session.set(this, dek)
                    main.post { onUnlocked(dek, true) }
                } catch (e: Exception) {
                    main.post {
                        progress.visibility = View.GONE
                        error.text = if (e is WrongPasswordException) "Password errata" else (e.message ?: "Errore")
                        error.visibility = View.VISIBLE
                    }
                }
            }
        }
        pw.setOnEditorActionListener { _, id, _ -> if (id == EditorInfo.IME_ACTION_DONE) { go(); true } else false }
        button("Sblocca") { go() }
        val bio = Bio(this)
        if (bio.enrolled()) {
            val useBio = {
                bio.unlock(this) { dek, e ->
                    if (dek != null) { Session.set(this, dek); onUnlocked(dek, true) }
                    else if (e != null) { error.text = e; error.visibility = View.VISIBLE }
                }
            }
            button("Usa impronta o volto") { useBio() }
            main.postDelayed({ useBio() }, 250)
        } else {
            pw.requestFocus()
            window.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_STATE_VISIBLE)
        }
        button("Annulla") { cancel() }
    }

    /** Elenco di elementi con ricerca. */
    protected fun showPicker(header: String, sub: String?, all: List<JSONObject>, preferred: List<JSONObject>, label: (JSONObject) -> String, onPick: (JSONObject) -> Unit) {
        root.removeAllViews()
        title(header, sub)
        val search = EditText(this).apply { hint = "Cerca…"; isSingleLine = true }
        root.addView(search)
        val list = ListView(this)
        root.addView(list, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(320)))
        var shown: List<JSONObject> = emptyList()
        fun refresh(q: String) {
            val ql = q.trim().lowercase()
            val base = if (ql.isEmpty() && preferred.isNotEmpty()) preferred + all.filter { it !in preferred } else all
            shown = base.filter { ql.isEmpty() || label(it).lowercase().contains(ql) || Vault.field(it, "url").lowercase().contains(ql) }
            list.adapter = ArrayAdapter(this, android.R.layout.simple_list_item_1, shown.map(label))
        }
        list.setOnItemClickListener { _, _, pos, _ -> onPick(shown[pos]) }
        search.addTextChangedListener(object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) {}
            override fun onTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) {}
            override fun afterTextChanged(s: Editable?) = refresh(s?.toString() ?: "")
        })
        refresh("")
        if (all.isEmpty()) root.addView(TextView(this).apply { text = "Nessun elemento"; gravity = Gravity.CENTER })
        button("Annulla") { cancel() }
    }

    protected open fun cancel() {
        setResult(RESULT_CANCELED)
        finish()
    }
}
