package app.scrigno

import android.content.Context
import org.json.JSONObject

/**
 * Preferenze di compilazione automatica scelte nell'app (Impostazioni › Compilazione automatica).
 * La web app le passa qui a ogni sblocco o modifica, così il servizio le usa anche a vault bloccato.
 */
data class AfPrefs(val exactMatch: Boolean, val askSave: Boolean, val lockedSuggest: Boolean, val ignore: List<String>) {
    fun ignored(host: String?): Boolean {
        val h = host?.lowercase()?.removePrefix("www.") ?: return false
        return h.isNotEmpty() && ignore.any { h == it || h.endsWith(".$it") }
    }

    companion object {
        private const val KEY = "afprefs"
        fun save(ctx: Context, json: String) {
            JSONObject(json) // verifica che sia JSON valido
            ctx.getSharedPreferences("scrigno", Context.MODE_PRIVATE).edit().putString(KEY, json).apply()
        }
        fun load(ctx: Context): AfPrefs {
            val o = try { JSONObject(ctx.getSharedPreferences("scrigno", Context.MODE_PRIVATE).getString(KEY, "{}") ?: "{}") } catch (e: Exception) { JSONObject() }
            val arr = o.optJSONArray("ignore")
            val ignore = if (arr == null) emptyList() else (0 until arr.length()).map { arr.optString(it).lowercase() }.filter { it.isNotEmpty() }
            return AfPrefs(o.optBoolean("exactMatch", false), o.optBoolean("askSave", true), o.optBoolean("lockedSuggest", true), ignore)
        }
    }
}
