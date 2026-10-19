package app.scrigno

import android.content.Context
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyPermanentlyInvalidatedException
import android.security.keystore.KeyProperties
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_STRONG
import androidx.biometric.BiometricManager.Authenticators.DEVICE_CREDENTIAL
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import app.scrigno.core.B64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Sblocco con impronta/volto: la chiave del vault è cifrata con una chiave del Keystore che richiede la biometria. */
class Bio(private val ctx: Context) {
    private val prefs = ctx.getSharedPreferences("bio", Context.MODE_PRIVATE)
    private val alias = "scrigno_bio"

    fun available() = BiometricManager.from(ctx).canAuthenticate(BIOMETRIC_STRONG) == BiometricManager.BIOMETRIC_SUCCESS
    fun enrolled() = prefs.contains("ct")

    private fun keystore() = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

    private fun newKey(): SecretKey {
        keystore().deleteEntry(alias)
        val spec = KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .setUserAuthenticationRequired(true)
            .setInvalidatedByBiometricEnrollment(true)
        if (Build.VERSION.SDK_INT >= 30) spec.setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG)
        val kg = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        kg.init(spec.build())
        return kg.generateKey()
    }

    private fun prompt(act: FragmentActivity, title: String, cipher: Cipher, done: (Cipher?, String?) -> Unit) {
        val info = BiometricPrompt.PromptInfo.Builder()
            .setTitle(title).setSubtitle("Scrigno")
            .setNegativeButtonText("Usa la master password")
            .setAllowedAuthenticators(BIOMETRIC_STRONG)
            .build()
        BiometricPrompt(act, ContextCompat.getMainExecutor(act), object : BiometricPrompt.AuthenticationCallback() {
            override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) = done(result.cryptoObject?.cipher, null)
            override fun onAuthenticationError(code: Int, msg: CharSequence) = done(null, msg.toString())
        }).authenticate(info, BiometricPrompt.CryptoObject(cipher))
    }

    fun enroll(act: FragmentActivity, dek: ByteArray, done: (String?) -> Unit) {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, newKey())
        prompt(act, "Attiva lo sblocco biometrico", cipher) { c, err ->
            if (c == null) { done(err ?: "Annullato"); return@prompt }
            val ct = c.doFinal(dek)
            prefs.edit().putString("iv", B64.enc(c.iv)).putString("ct", B64.enc(ct)).apply()
            done(null)
        }
    }

    fun unlock(act: FragmentActivity, done: (ByteArray?, String?) -> Unit) {
        val iv = prefs.getString("iv", null)
        val ct = prefs.getString("ct", null)
        if (iv == null || ct == null) { done(null, "Sblocco biometrico non attivo"); return }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        try {
            val key = keystore().getKey(alias, null) as SecretKey? ?: throw KeyPermanentlyInvalidatedException()
            cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, B64.dec(iv)))
        } catch (e: KeyPermanentlyInvalidatedException) {
            disable()
            done(null, "Le impronte del dispositivo sono cambiate: sblocca con la master password e riattiva la biometria.")
            return
        }
        prompt(act, "Sblocca Scrigno", cipher) { c, err ->
            if (c == null) done(null, err ?: "Annullato") else done(c.doFinal(B64.dec(ct)), null)
        }
    }

    fun disable() {
        prefs.edit().clear().apply()
        try { keystore().deleteEntry(alias) } catch (_: Exception) { }
    }

    companion object {
        /** Verifica dell'utente (impronta o PIN del dispositivo) prima di usare una passkey. Ritorna false se il dispositivo non ha blocco. */
        fun verifyUser(act: FragmentActivity, title: String, done: (Boolean, Boolean) -> Unit) {
            val auth = if (Build.VERSION.SDK_INT >= 30) BIOMETRIC_STRONG or DEVICE_CREDENTIAL else BiometricManager.Authenticators.BIOMETRIC_WEAK or DEVICE_CREDENTIAL
            if (BiometricManager.from(act).canAuthenticate(auth) != BiometricManager.BIOMETRIC_SUCCESS) { done(true, false); return }
            val info = BiometricPrompt.PromptInfo.Builder().setTitle(title).setSubtitle("Scrigno").setAllowedAuthenticators(auth).build()
            BiometricPrompt(act, ContextCompat.getMainExecutor(act), object : BiometricPrompt.AuthenticationCallback() {
                override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) = done(true, true)
                override fun onAuthenticationError(code: Int, msg: CharSequence) = done(false, false)
            }).authenticate(info)
        }
    }
}
