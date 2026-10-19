package app.scrigno.core

import org.json.JSONArray
import org.json.JSONObject
import java.net.URI
import java.util.UUID

/** Elementi del vault e ricerca dei login per sito o app (come matchLogins in core.js). */
object Vault {
    const val APP_FIELD = "App Android"
    private val SLD = setOf("co.uk", "org.uk", "gov.uk", "ac.uk", "com.au", "net.au", "co.jp", "co.nz", "com.br", "com.mx", "co.in", "gov.it", "edu.it", "com.tr", "co.za")

    fun now() = System.currentTimeMillis()

    fun items(arr: JSONArray): List<JSONObject> =
        (0 until arr.length()).map { arr.getJSONObject(it) }.filter { !it.optBoolean("deleted") }

    fun field(it: JSONObject, k: String): String = it.optJSONObject("f")?.optString(k, "") ?: ""

    fun hostOf(url: String): String {
        val s = url.trim()
        if (s.isEmpty()) return ""
        val withScheme = if (Regex("^[a-zA-Z][a-zA-Z0-9+.-]*:").containsMatchIn(s)) s else "https://$s"
        return try { URI(withScheme).host?.lowercase() ?: "" } catch (e: Exception) { "" }
    }

    fun baseDomain(hostIn: String): String {
        val host = hostIn.lowercase().removePrefix("www.").trimEnd('.')
        if (!host.contains('.') || host.all { it.isDigit() || it == '.' }) return host
        val p = host.split('.')
        val last2 = p.takeLast(2).joinToString(".")
        return if (last2 in SLD && p.size >= 3) p.takeLast(3).joinToString(".") else last2
    }

    fun appOf(it: JSONObject): String? {
        val custom = it.optJSONArray("custom") ?: return null
        for (i in 0 until custom.length()) {
            val c = custom.getJSONObject(i)
            if (c.optString("label") == APP_FIELD) return c.optString("value")
        }
        val url = field(it, "url").trim()
        return if (url.startsWith("androidapp://")) url.removePrefix("androidapp://") else null
    }

    fun matchLogins(all: List<JSONObject>, host: String?, pkg: String?): List<JSONObject> {
        val bd = if (!host.isNullOrEmpty()) baseDomain(host) else ""
        return all.filter { it.optString("type") == "login" }.filter {
            if (pkg != null && appOf(it) == pkg) return@filter true
            val url = field(it, "url")
            bd.isNotEmpty() && url.isNotEmpty() && baseDomain(hostOf(url)) == bd
        }
    }

    fun passkeysFor(all: List<JSONObject>, rpId: String): List<JSONObject> =
        all.filter { it.optString("type") == "passkey" && field(it, "rpId") == rpId && field(it, "privateKey").isNotEmpty() }

    fun rpIdAllowed(rpIdIn: String, hostIn: String): Boolean {
        val rpId = rpIdIn.lowercase()
        val host = hostIn.lowercase()
        if (rpId.isEmpty() || (rpId != "localhost" && !rpId.contains('.')) || rpId in SLD) return false
        return host == rpId || host.endsWith(".$rpId")
    }

    fun newItem(type: String, title: String, f: JSONObject, custom: JSONArray = JSONArray()): JSONObject {
        val t = now()
        val o = JSONObject()
            .put("id", UUID.randomUUID().toString()).put("type", type)
            .put("title", title.trim().ifEmpty { "Senza titolo" })
            .put("f", f).put("custom", custom).put("fav", false)
            .put("created", t).put("updated", t)
        if (f.optString("password").isNotEmpty()) o.put("pwChanged", t)
        return o
    }

    /** Aggiunge o aggiorna un login. Ritorna l'elemento salvato. */
    fun upsertLogin(arr: JSONArray, host: String?, pkg: String?, appLabel: String?, username: String, password: String): JSONObject {
        val all = items(arr)
        val same = matchLogins(all, host, pkg).firstOrNull { field(it, "username") == username }
        if (same != null) {
            val f = same.getJSONObject("f")
            if (f.optString("password") != password) { f.put("password", password); same.put("pwChanged", now()) }
            same.put("updated", now())
            return same
        }
        val f = JSONObject().put("username", username).put("password", password)
        val custom = JSONArray()
        if (!host.isNullOrEmpty()) f.put("url", "https://$host")
        else if (pkg != null) custom.put(JSONObject().put("label", APP_FIELD).put("value", pkg).put("secret", false))
        val title = when {
            !host.isNullOrEmpty() -> baseDomain(host)
            !appLabel.isNullOrEmpty() -> appLabel
            else -> pkg ?: "Login"
        }
        val item = newItem("login", title, f, custom)
        arr.put(item)
        return item
    }

    /** Collega un login a un'app Android, così la prossima volta viene proposto subito. */
    fun linkApp(item: JSONObject, pkg: String) {
        if (appOf(item) == pkg) return
        val custom = item.optJSONArray("custom") ?: JSONArray().also { item.put("custom", it) }
        custom.put(JSONObject().put("label", APP_FIELD).put("value", pkg).put("secret", false))
        item.put("updated", now())
    }
}
