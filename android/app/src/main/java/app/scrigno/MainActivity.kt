package app.scrigno

import android.annotation.SuppressLint
import android.content.ClipData
import android.content.ClipDescription
import android.content.ClipboardManager
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.PersistableBundle
import android.provider.Settings
import android.view.WindowManager
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.browser.customtabs.CustomTabsIntent
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewClientCompat
import app.scrigno.core.B64
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/** L'app: la web app di Scrigno in una WebView, con un ponte verso le funzioni del telefono. */
class MainActivity : AppCompatActivity() {
    private lateinit var web: WebView
    private val io = Executors.newCachedThreadPool()
    private val http = OkHttpClient.Builder().connectTimeout(20, TimeUnit.SECONDS).readTimeout(60, TimeUnit.SECONDS).build()
    private val main = Handler(Looper.getMainLooper())
    private val bio by lazy { Bio(this) }
    private var oauthId: Int? = null
    private var fileCb: ValueCallback<Array<Uri>>? = null
    private var pendingSave: Pair<Int, ByteArray>? = null
    private var clipClear: Runnable? = null

    private val pickFile = registerForActivityResult(ActivityResultContracts.GetContent()) { uri ->
        fileCb?.onReceiveValue(if (uri != null) arrayOf(uri) else null)
        fileCb = null
    }
    private val createDoc = registerForActivityResult(ActivityResultContracts.CreateDocument("*/*")) { uri ->
        val p = pendingSave ?: return@registerForActivityResult
        pendingSave = null
        if (uri == null) { reply(p.first, true, "false"); return@registerForActivityResult }
        try {
            contentResolver.openOutputStream(uri)!!.use { it.write(p.second) }
            reply(p.first, true, "true")
        } catch (e: Exception) { reply(p.first, false, err(e)) }
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE)
        WebView.setWebContentsDebuggingEnabled(applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0)
        web = WebView(this)
        setContentView(web)
        val loader = WebViewAssetLoader.Builder().addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this)).build()
        web.webViewClient = object : WebViewClientCompat() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? = loader.shouldInterceptRequest(request.url)
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                if (request.url.host == "appassets.androidplatform.net") return false
                openExternal(request.url)
                return true
            }
        }
        web.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(view: WebView, cb: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
                fileCb?.onReceiveValue(null)
                fileCb = cb
                pickFile.launch("*/*")
                return true
            }
        }
        with(web.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            setSupportMultipleWindows(false)
        }
        web.addJavascriptInterface(Bridge(), "ScrignoAndroid")
        web.loadUrl("https://appassets.androidplatform.net/assets/web/index.html")
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() { moveTaskToBack(true) }
        })
        handleIntent(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleIntent(intent)
    }

    override fun onPause() {
        // invia al cloud le modifiche ancora in attesa prima che l'app vada in secondo piano
        if (::web.isInitialized) event("pause")
        super.onPause()
    }

    override fun onResume() {
        super.onResume()
        if (::web.isInitialized) event("resume")
    }

    private fun handleIntent(intent: Intent?) {
        val data = intent?.data ?: return
        if (data.scheme == "scrigno" && data.host == "oauth") {
            oauthId?.let { reply(it, true, JSONObject.quote(data.toString())) }
            oauthId = null
        }
    }

    private fun openExternal(uri: Uri) {
        if (uri.scheme != "https" && uri.scheme != "http") return
        try { startActivity(Intent(Intent.ACTION_VIEW, uri)) } catch (_: Exception) { }
    }

    // ------------------------------------------------------------ risposte alla web app
    private fun err(e: Throwable?) = JSONObject().put("message", e?.message ?: "Errore").toString()
    private fun reply(id: Int, ok: Boolean, payload: String) {
        main.post { web.evaluateJavascript("window.__scrignoReply($id,$ok,${JSONObject.quote(payload)})", null) }
    }
    private fun event(name: String, payload: String = "null") {
        main.post { web.evaluateJavascript("window.__scrignoEvent && window.__scrignoEvent(${JSONObject.quote(name)},${JSONObject.quote(payload)})", null) }
    }

    inner class Bridge {
        @android.webkit.JavascriptInterface
        fun call(id: Int, method: String, argsJson: String) {
            val a = try { if (argsJson == "null") JSONObject() else JSONObject(argsJson) } catch (e: Exception) { JSONObject() }
            try { dispatch(id, method, a) } catch (e: Exception) { reply(id, false, err(e)) }
        }
    }

    private fun ok(id: Int, payload: String = "null") = reply(id, true, payload)

    private fun dispatch(id: Int, method: String, a: JSONObject) {
        when (method) {
            "kvGet" -> ok(id, Repo.get(this, a.getString("key")) ?: "null")
            "kvSet" -> { Repo.set(this, a.getString("key"), a.get("value").toString()); ok(id) }
            "kvDel" -> { Repo.del(this, a.getString("key")); ok(id) }
            "session" -> { Session.set(this, B64.dec(a.getString("dek")), a.optInt("ttlMin", 5)); ok(id) }
            "afPrefs" -> { AfPrefs.save(this, a.getString("prefs")); ok(id) }
            "lock" -> { Session.clear(); ok(id) }
            "http" -> io.execute {
                try {
                    val url = a.getString("url")
                    require(url.startsWith("https://")) { "Sono consentite solo connessioni HTTPS" }
                    val method2 = a.optString("method", "GET").uppercase()
                    val headers = a.optJSONObject("headers") ?: JSONObject()
                    val ct = headers.optString("Content-Type", headers.optString("content-type", ""))
                    val bodyStr = if (a.isNull("body")) null else a.optString("body")
                    val body = if (method2 == "GET" || method2 == "HEAD") null else (bodyStr ?: "").toRequestBody(ct.ifEmpty { null }?.toMediaTypeOrNull())
                    val rb = Request.Builder().url(url).method(method2, body)
                    headers.keys().forEach { k -> if (!k.equals("Content-Type", true)) rb.header(k, headers.getString(k)) }
                    http.newCall(rb.build()).execute().use { r ->
                        ok(id, JSONObject().put("status", r.code).put("body", r.body?.string() ?: "").toString())
                    }
                } catch (e: Exception) { reply(id, false, err(e)) }
            }
            "oauth" -> main.post {
                oauthId?.let { reply(it, false, err(Exception("Accesso annullato"))) }
                oauthId = id
                try { CustomTabsIntent.Builder().build().launchUrl(this, Uri.parse(a.getString("url"))) } catch (e: Exception) { oauthId = null; reply(id, false, err(e)) }
            }
            "oauthCancel" -> main.post {
                oauthId?.let { reply(it, false, err(Exception("Accesso annullato"))) }
                oauthId = null
                ok(id)
            }
            "shareText" -> main.post {
                try {
                    val send = Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, a.getString("text"))
                    startActivity(Intent.createChooser(send, a.optString("title", "Condividi")))
                    ok(id)
                } catch (e: Exception) { reply(id, false, err(e)) }
            }
            "clipboardRead" -> main.post {
                val cm = getSystemService(ClipboardManager::class.java)
                val t = try { cm.primaryClip?.takeIf { it.itemCount > 0 }?.getItemAt(0)?.coerceToText(this)?.toString() ?: "" } catch (e: Exception) { "" }
                ok(id, JSONObject.quote(t))
            }
            "copy" -> main.post {
                val cm = getSystemService(ClipboardManager::class.java)
                val text = a.getString("text")
                val clip = ClipData.newPlainText("Scrigno", text)
                clip.description.extras = PersistableBundle().apply {
                    putBoolean(if (Build.VERSION.SDK_INT >= 33) ClipDescription.EXTRA_IS_SENSITIVE else "android.content.extra.IS_SENSITIVE", true)
                }
                cm.setPrimaryClip(clip)
                clipClear?.let { main.removeCallbacks(it) }
                val sec = a.optInt("clearSec", 0)
                if (sec > 0) {
                    val r = Runnable {
                        if (Build.VERSION.SDK_INT >= 28) cm.clearPrimaryClip() else cm.setPrimaryClip(ClipData.newPlainText("", ""))
                    }
                    clipClear = r
                    main.postDelayed(r, sec * 1000L)
                }
                ok(id)
            }
            "saveFile" -> main.post {
                val bytes = if (a.has("b64")) B64.dec(a.getString("b64")) else a.getString("text").toByteArray()
                pendingSave = id to bytes
                createDoc.launch(a.optString("name", "scrigno-backup.json"))
            }
            "openUrl" -> main.post { openExternal(Uri.parse(a.getString("url"))); ok(id) }
            "bioStatus" -> ok(id, JSONObject().put("available", bio.available()).put("enrolled", bio.enrolled()).toString())
            "bioEnroll" -> main.post {
                bio.enroll(this, B64.dec(a.getString("dek"))) { e -> if (e == null) ok(id) else reply(id, false, err(Exception(e))) }
            }
            "bioUnlock" -> main.post {
                bio.unlock(this) { dek, e ->
                    if (dek != null) ok(id, JSONObject().put("dek", B64.enc(dek)).toString()) else reply(id, false, err(Exception(e)))
                }
            }
            "bioDisable" -> { bio.disable(); ok(id) }
            "openAutofillSettings" -> main.post {
                try {
                    startActivity(Intent(Settings.ACTION_REQUEST_SET_AUTOFILL_SERVICE).setData(Uri.parse("package:$packageName")))
                } catch (_: Exception) {
                    startActivity(Intent(Settings.ACTION_SETTINGS))
                }
                ok(id)
            }
            "openCredentialSettings" -> main.post {
                try {
                    if (Build.VERSION.SDK_INT >= 34) startActivity(Intent("android.settings.CREDENTIAL_PROVIDER").setData(Uri.parse("package:$packageName")))
                    else {
                        Toast.makeText(this, "Le passkey di terze parti richiedono Android 14 o successivo", Toast.LENGTH_LONG).show()
                    }
                } catch (_: Exception) {
                    startActivity(Intent(Settings.ACTION_SETTINGS))
                }
                ok(id)
            }
            else -> reply(id, false, err(Exception("Funzione non disponibile: $method")))
        }
    }
}
