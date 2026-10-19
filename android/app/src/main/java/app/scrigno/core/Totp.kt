package app.scrigno.core

import java.net.URI
import java.net.URLDecoder
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/** Codici 2FA (RFC 6238), stessi parametri della web app. */
object Totp {
    class Cfg(val secret: ByteArray, val digits: Int, val period: Int, val algorithm: String)

    fun base32(s: String): ByteArray {
        val a = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
        var bits = 0
        var v = 0
        val out = java.io.ByteArrayOutputStream()
        for (c in s.uppercase().replace(Regex("[\\s=-]"), "")) {
            val i = a.indexOf(c)
            require(i >= 0) { "Segreto 2FA non valido" }
            v = (v shl 5) or i
            bits += 5
            if (bits >= 8) { out.write((v ushr (bits - 8)) and 255); bits -= 8 }
        }
        return out.toByteArray()
    }

    fun parse(input: String): Cfg {
        val s = input.trim()
        if (s.startsWith("otpauth://", ignoreCase = true)) {
            val q = (URI(s).rawQuery ?: "").split('&').filter { it.contains('=') }
                .associate { val (k, v) = it.split('=', limit = 2); k.lowercase() to URLDecoder.decode(v, "UTF-8") }
            val alg = when ((q["algorithm"] ?: "SHA1").uppercase()) { "SHA256" -> "HmacSHA256"; "SHA512" -> "HmacSHA512"; else -> "HmacSHA1" }
            return Cfg(base32(q["secret"] ?: ""), (q["digits"] ?: "6").toInt(), (q["period"] ?: "30").toInt(), alg)
        }
        return Cfg(base32(s), 6, 30, "HmacSHA1")
    }

    fun code(cfg: Cfg, timeMs: Long = System.currentTimeMillis()): String {
        val counter = timeMs / 1000 / cfg.period
        val msg = ByteArray(8) { i -> (counter ushr (56 - 8 * i)).toByte() }
        val mac = Mac.getInstance(cfg.algorithm).apply { init(SecretKeySpec(cfg.secret, cfg.algorithm)) }
        val h = mac.doFinal(msg)
        val o = h[h.size - 1].toInt() and 15
        val bin = ((h[o].toInt() and 127) shl 24) or ((h[o + 1].toInt() and 255) shl 16) or ((h[o + 2].toInt() and 255) shl 8) or (h[o + 3].toInt() and 255)
        var mod = 1
        repeat(cfg.digits) { mod *= 10 }
        return (bin % mod).toString().padStart(cfg.digits, '0')
    }
}
