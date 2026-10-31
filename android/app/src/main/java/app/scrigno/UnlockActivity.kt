package app.scrigno

import android.content.res.ColorStateList
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.text.Editable
import android.text.InputType
import android.text.TextUtils
import android.text.TextWatcher
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.view.inputmethod.EditorInfo
import android.widget.BaseAdapter
import android.widget.Button
import android.widget.EditText
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ListView
import android.widget.ProgressBar
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import app.scrigno.core.Vault
import app.scrigno.core.VaultCrypto
import app.scrigno.core.KeyfileRequiredException
import app.scrigno.core.WrongPasswordException
import org.json.JSONObject
import java.util.concurrent.Executors

/**
 * Base delle finestre usate fuori dall'app (compilazione automatica, passkey):
 * pannello in basso, blu notte, con sblocco (master password o biometria) e un elenco
 * di elementi con le icone dei siti, come i gestori di password professionali.
 */
abstract class UnlockActivity : AppCompatActivity() {
    protected val io = Executors.newSingleThreadExecutor()
    protected val main = Handler(Looper.getMainLooper())
    protected lateinit var root: LinearLayout

    private companion object Palette {
        val BG = 0xFF10233A.toInt()
        val FIELD = 0xFF1B3352.toInt()
        val LINE = 0xFF27405F.toInt()
        val TEXT = 0xFFF1F5FA.toInt()
        val MUTED = 0xFF9DB0C4.toInt()
        val ACCENT = 0xFF3A9BEF.toInt()
        val ERROR = 0xFFF27A74.toInt()
    }

    /** Chiamato quando il vault è disponibile. viaPassword = l'utente ha appena verificato la propria identità. */
    abstract fun onUnlocked(dek: ByteArray, userVerified: Boolean)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE)
        root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(20), dp(10), dp(20), dp(20))
            background = GradientDrawable().apply {
                setColor(BG)
                val r = dp(22).toFloat()
                cornerRadii = floatArrayOf(r, r, r, r, 0f, 0f, 0f, 0f)
            }
        }
        setContentView(root, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        // pannello che sale dal basso, a tutta larghezza
        window.setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
        window.setGravity(Gravity.BOTTOM)
        window.setBackgroundDrawable(GradientDrawable().apply { setColor(Color.TRANSPARENT) })
        window.addFlags(WindowManager.LayoutParams.FLAG_DIM_BEHIND)
        window.attributes = window.attributes.apply { dimAmount = 0.45f }
        setFinishOnTouchOutside(true)
    }

    private fun rounded(color: Int, radius: Int, stroke: Int = 0) = GradientDrawable().apply {
        setColor(color); cornerRadius = dp(radius).toFloat()
        if (stroke != 0) setStroke(dp(1), stroke)
    }

    /** Campo di testo scuro e arrotondato. */
    protected fun field(hintText: String) = EditText(this).apply {
        hint = hintText
        setTextColor(TEXT); setHintTextColor(MUTED)
        setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f)
        background = rounded(FIELD, 12, LINE)
        setPadding(dp(16), dp(13), dp(16), dp(13))
        isSingleLine = true
    }

    protected fun dp(v: Int) = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v.toFloat(), resources.displayMetrics).toInt()

    protected fun title(text: String, sub: String? = null) {
        // maniglia del pannello
        root.addView(View(this).apply { background = rounded(LINE, 3) }, LinearLayout.LayoutParams(dp(40), dp(5)).apply { gravity = Gravity.CENTER_HORIZONTAL; bottomMargin = dp(14) })
        val row = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
        row.addView(ImageView(this).apply { setImageResource(R.drawable.ic_scrigno) }, LinearLayout.LayoutParams(dp(36), dp(36)).apply { marginEnd = dp(12) })
        val col = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        col.addView(TextView(this).apply {
            this.text = text
            setTextColor(TEXT)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 18f)
            typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
        })
        if (sub != null) col.addView(TextView(this).apply {
            this.text = sub
            setTextColor(MUTED)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 13.5f)
            maxLines = 2; ellipsize = TextUtils.TruncateAt.END
        })
        row.addView(col, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
        root.addView(row, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { bottomMargin = dp(16) })
    }

    /** Pulsante: pieno (azione principale) o solo testo. */
    protected fun button(text: String, primary: Boolean = false, onClick: () -> Unit) = Button(this).apply {
        this.text = text
        isAllCaps = false
        setTextSize(TypedValue.COMPLEX_UNIT_SP, 15.5f)
        typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
        stateListAnimator = null
        if (primary) { setTextColor(Color.WHITE); background = rounded(0xFF1F78CC.toInt(), 12) }
        else { setTextColor(ACCENT); background = rounded(Color.TRANSPARENT, 12) }
        minHeight = dp(48)
        setOnClickListener { onClick() }
        root.addView(this, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(8) })
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
        val pw = field("Master password").apply {
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
            imeOptions = EditorInfo.IME_ACTION_DONE
        }
        root.addView(pw)
        val error = TextView(this).apply { setTextColor(ERROR); setPadding(dp(4), dp(8), 0, 0); visibility = View.GONE }
        root.addView(error)
        val progress = ProgressBar(this).apply { visibility = View.GONE; indeterminateTintList = ColorStateList.valueOf(ACCENT) }
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
                        error.text = when (e) {
                            is WrongPasswordException -> "Password errata"
                            is KeyfileRequiredException -> e.message
                            else -> e.message ?: "Errore"
                        }
                        error.visibility = View.VISIBLE
                    }
                }
            }
        }
        pw.setOnEditorActionListener { _, id, _ -> if (id == EditorInfo.IME_ACTION_DONE) { go(); true } else false }
        button("Sblocca", primary = true) { go() }
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

    /** Elenco di elementi con ricerca: prima quelli adatti al sito o all'app, con l'icona del sito. */
    protected fun showPicker(header: String, sub: String?, all: List<JSONObject>, preferred: List<JSONObject>, label: (JSONObject) -> String, onPick: (JSONObject) -> Unit) {
        root.removeAllViews()
        title(header, sub)
        val search = field("Cerca in Scrigno").apply {
            imeOptions = EditorInfo.IME_ACTION_SEARCH
            setCompoundDrawablesRelativeWithIntrinsicBounds(android.R.drawable.ic_menu_search, 0, 0, 0)
            compoundDrawablePadding = dp(10)
            compoundDrawableTintList = ColorStateList.valueOf(MUTED)
        }
        root.addView(search)
        val list = ListView(this).apply {
            divider = null
            selector = rounded(FIELD, 12)
            isVerticalScrollBarEnabled = false
        }
        val maxH = (resources.displayMetrics.heightPixels * 0.5).toInt()
        root.addView(list, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, maxH).apply { topMargin = dp(8) })
        val icon = dp(42)
        // righe: intestazioni di gruppo (String) o elementi (JSONObject)
        var rows: List<Any> = emptyList()
        val adapter = object : BaseAdapter() {
            override fun getCount() = rows.size
            override fun getItem(p: Int) = rows[p]
            override fun getItemId(p: Int) = p.toLong()
            override fun getViewTypeCount() = 2
            override fun getItemViewType(p: Int) = if (rows[p] is String) 0 else 1
            override fun isEnabled(p: Int) = rows[p] !is String
            override fun getView(p: Int, convert: View?, parent: ViewGroup): View {
                val r = rows[p]
                if (r is String) return TextView(this@UnlockActivity).apply {
                    text = r.uppercase()
                    setTextColor(MUTED); setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f); letterSpacing = 0.06f
                    typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
                    setPadding(dp(6), dp(14), 0, dp(6))
                }
                val item = r as JSONObject
                val row = LinearLayout(this@UnlockActivity).apply {
                    orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL
                    setPadding(dp(6), dp(10), dp(6), dp(10))
                }
                val img = ImageView(this@UnlockActivity).apply { setImageBitmap(Icons.forItem(this@UnlockActivity, item, icon)) }
                row.addView(img, LinearLayout.LayoutParams(icon, icon).apply { marginEnd = dp(14) })
                val col = LinearLayout(this@UnlockActivity).apply { orientation = LinearLayout.VERTICAL }
                col.addView(TextView(this@UnlockActivity).apply {
                    text = item.optString("title").ifEmpty { "Senza titolo" }
                    setTextColor(TEXT); setTextSize(TypedValue.COMPLEX_UNIT_SP, 16.5f)
                    typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
                    maxLines = 1; ellipsize = TextUtils.TruncateAt.END
                })
                val subText = Vault.field(item, "username").ifEmpty { Icons.hostOf(item) ?: "" }
                if (subText.isNotEmpty()) col.addView(TextView(this@UnlockActivity).apply {
                    text = subText
                    setTextColor(MUTED); setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
                    maxLines = 1; ellipsize = TextUtils.TruncateAt.END
                })
                row.addView(col, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
                // l'icona del sito arriva dalla rete la prima volta
                val host = if (Icons.enabled(this@UnlockActivity)) Icons.hostOf(item) else null
                if (host != null && Icons.cached(this@UnlockActivity, host) == null) {
                    Icons.load(this@UnlockActivity, host) { b -> if (b != null) img.setImageBitmap(Icons.framed(b, icon)) }
                }
                return row
            }
        }
        list.adapter = adapter
        fun refresh(q: String) {
            val ql = q.trim().lowercase()
            fun hit(o: JSONObject) = ql.isEmpty() || label(o).lowercase().contains(ql) || Vault.field(o, "url").lowercase().contains(ql)
            val pref = preferred.filter(::hit)
            val rest = all.filter { it !in preferred && hit(it) }
            val out = mutableListOf<Any>()
            if (pref.isNotEmpty()) { out.add(if (sub != null) "Suggeriti per $sub" else "Suggeriti"); out.addAll(pref) }
            if (rest.isNotEmpty()) { if (pref.isNotEmpty()) out.add("Tutti i login"); out.addAll(rest) }
            rows = out
            adapter.notifyDataSetChanged()
        }
        list.setOnItemClickListener { _, _, pos, _ -> (rows[pos] as? JSONObject)?.let(onPick) }
        search.addTextChangedListener(object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) {}
            override fun onTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) {}
            override fun afterTextChanged(s: Editable?) = refresh(s?.toString() ?: "")
        })
        refresh("")
        if (all.isEmpty()) root.addView(TextView(this).apply { text = "Nessun login nel vault"; setTextColor(MUTED); gravity = Gravity.CENTER; setPadding(0, dp(16), 0, dp(8)) })
        button("Annulla") { cancel() }
    }

    protected open fun cancel() {
        setResult(RESULT_CANCELED)
        finish()
    }
}
