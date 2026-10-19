package app.scrigno.autofill

import android.app.assist.AssistStructure
import android.os.Parcelable
import android.text.InputType
import android.view.View
import android.view.autofill.AutofillId
import kotlinx.parcelize.Parcelize

/** Campi trovati in una schermata da compilare. */
@Parcelize
data class Target(
    val pkg: String,
    val webDomain: String?,
    val usernameId: AutofillId?,
    val passwordId: AutofillId?,
    val otpId: AutofillId?,
    val username: String?,
    val password: String?,
) : Parcelable {
    /** Per i browser si confronta il sito, per le app il nome del pacchetto. */
    val matchPkg: String? get() = if (webDomain.isNullOrEmpty()) pkg else null
    val ids: List<AutofillId> get() = listOfNotNull(usernameId, passwordId, otpId)
}

object StructureParser {
    private val USER = Regex("user|email|e-mail|login|account|utente|identifier|phone|cellulare", RegexOption.IGNORE_CASE)
    private val OTP = Regex("otp|totp|2fa|mfa|one.?time|verification.?code|auth.?code|codice", RegexOption.IGNORE_CASE)

    private class Field(val id: AutofillId, val kind: String, val value: String?, val focused: Boolean)

    fun parse(s: AssistStructure): Target {
        val fields = mutableListOf<Field>()
        var web: String? = null
        fun walk(n: AssistStructure.ViewNode) {
            if (web == null && !n.webDomain.isNullOrEmpty()) web = n.webDomain
            val id = n.autofillId
            if (id != null && n.autofillType == View.AUTOFILL_TYPE_TEXT && n.visibility == View.VISIBLE) {
                val k = classify(n)
                if (k != null) fields += Field(id, k, n.autofillValue?.takeIf { it.isText }?.textValue?.toString(), n.isFocused)
            }
            for (i in 0 until n.childCount) walk(n.getChildAt(i))
        }
        for (i in 0 until s.windowNodeCount) walk(s.getWindowNodeAt(i).rootViewNode)

        val pws = fields.filter { it.kind == "password" }
        val pw = pws.firstOrNull { it.focused } ?: pws.firstOrNull()
        var user = fields.firstOrNull { it.kind == "username" }
        if (user == null && pw != null) {
            val idx = fields.indexOf(pw)
            user = fields.subList(0, idx).lastOrNull { it.kind == "text" }
        }
        val otp = fields.firstOrNull { it.kind == "otp" }
        return Target(s.activityComponent.packageName, web, user?.id, pw?.id, otp?.id, user?.value, pw?.value)
    }

    private fun classify(n: AssistStructure.ViewNode): String? {
        val hints = n.autofillHints?.map { it.lowercase() } ?: emptyList()
        val attrs = n.htmlInfo?.attributes?.associate { (it.first ?: "").lowercase() to (it.second ?: "") } ?: emptyMap()
        val htmlType = attrs["type"]?.lowercase()
        val autocomplete = attrs["autocomplete"]?.lowercase() ?: ""
        if (n.htmlInfo != null && n.htmlInfo?.tag?.lowercase() != "input") return null
        if (htmlType in setOf("hidden", "submit", "button", "checkbox", "radio", "search")) return null
        val cls = n.inputType and InputType.TYPE_MASK_CLASS
        val variation = n.inputType and InputType.TYPE_MASK_VARIATION
        val text = listOfNotNull(n.idEntry, n.hint, attrs["name"], attrs["id"], attrs["placeholder"], attrs["aria-label"]).joinToString(" ")

        val isOtp = hints.any { it.contains("otp") || it == "one-time-code" } || autocomplete == "one-time-code" || (OTP.containsMatchIn(text) && htmlType != "password")
        if (isOtp) return "otp"
        val isPassword = hints.any { it.contains("password") } || htmlType == "password" ||
            (cls == InputType.TYPE_CLASS_TEXT && variation in setOf(InputType.TYPE_TEXT_VARIATION_PASSWORD, InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD, InputType.TYPE_TEXT_VARIATION_WEB_PASSWORD)) ||
            (cls == InputType.TYPE_CLASS_NUMBER && variation == InputType.TYPE_NUMBER_VARIATION_PASSWORD)
        if (isPassword) return "password"
        val isUser = hints.any { it in setOf("username", "emailaddress", "email", "phone", "phonenumber") } ||
            htmlType == "email" || autocomplete.contains("username") || autocomplete.contains("email") ||
            (cls == InputType.TYPE_CLASS_TEXT && variation in setOf(InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS, InputType.TYPE_TEXT_VARIATION_WEB_EMAIL_ADDRESS)) ||
            USER.containsMatchIn(text)
        if (isUser) return "username"
        if (cls == InputType.TYPE_CLASS_TEXT || htmlType == "text" || htmlType == "tel") return "text"
        return null
    }
}
