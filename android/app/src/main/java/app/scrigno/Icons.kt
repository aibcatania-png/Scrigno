package app.scrigno

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.Typeface
import android.os.Handler
import android.os.Looper
import android.util.LruCache
import app.scrigno.core.Vault
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors

/**
 * Icone dei siti per la compilazione automatica (come nella web app): scaricate dal servizio di
 * DuckDuckGo, che riceve solo il nome del sito, e conservate sul dispositivo. Senza icona si
 * disegna un riquadro colorato con l'iniziale.
 */
object Icons {
    private val mem = LruCache<String, Bitmap>(96)
    private val exec = Executors.newFixedThreadPool(3)
    private val main = Handler(Looper.getMainLooper())
    private val HOST = Regex("^[a-z0-9.-]+\\.[a-z]{2,}$")
    private val TILES = intArrayOf(0xFF1F78CC.toInt(), 0xFF2E8B57.toInt(), 0xFFB5651D.toInt(), 0xFF7A4FC9.toInt(), 0xFFC0392B.toInt(), 0xFF138D90.toInt(), 0xFF5D6D7E.toInt(), 0xFFAD1457.toInt())

    fun enabled(ctx: Context) = AfPrefs.load(ctx).icons

    fun hostOf(item: JSONObject): String? {
        val url = Vault.field(item, "url")
        if (url.isEmpty() || url.startsWith("androidapp:")) return null
        val h = Vault.hostOf(url).removePrefix("www.")
        return if (HOST.matches(h)) h else null
    }

    private fun dir(ctx: Context) = File(ctx.cacheDir, "icons").apply { mkdirs() }
    private fun file(ctx: Context, host: String) = File(dir(ctx), "$host.png")
    private fun miss(ctx: Context, host: String) = File(dir(ctx), "$host.none")

    /** Icona già disponibile (memoria o disco), senza rete. */
    fun cached(ctx: Context, host: String): Bitmap? {
        mem.get(host)?.let { return it }
        val f = file(ctx, host)
        if (!f.exists() || f.length() == 0L) return null
        return try { BitmapFactory.decodeFile(f.path)?.also { mem.put(host, it) } } catch (e: Exception) { null }
    }

    /** Scarica l'icona se manca; cb sul thread principale (null se il sito non ne ha). */
    fun load(ctx: Context, host: String, cb: ((Bitmap?) -> Unit)? = null) {
        cached(ctx, host)?.let { b -> cb?.invoke(b); return }
        val app = ctx.applicationContext
        val m = miss(app, host)
        if (m.exists() && System.currentTimeMillis() - m.lastModified() < 7 * 86400_000L) { cb?.invoke(null); return }
        exec.execute {
            val bmp = try {
                val c = URL("https://icons.duckduckgo.com/ip3/$host.ico").openConnection() as HttpURLConnection
                c.connectTimeout = 6000; c.readTimeout = 6000
                c.setRequestProperty("Referer", "")
                val bytes = if (c.responseCode == 200) c.inputStream.use { it.readBytes() } else null
                c.disconnect()
                bytes?.let { BitmapFactory.decodeByteArray(it, 0, it.size) }
            } catch (e: Exception) { null }
            if (bmp != null && bmp.width >= 8) {
                val sq = square(bmp)
                try { file(app, host).outputStream().use { sq.compress(Bitmap.CompressFormat.PNG, 100, it) } } catch (_: Exception) { }
                mem.put(host, sq)
                main.post { cb?.invoke(sq) }
            } else {
                try { m.writeText("") } catch (_: Exception) { }
                main.post { cb?.invoke(null) }
            }
        }
    }

    /** Icona del sito su fondo bianco arrotondato, pronta da mostrare (o il riquadro con l'iniziale). */
    fun forItem(ctx: Context, item: JSONObject, sizePx: Int): Bitmap {
        val host = if (enabled(ctx)) hostOf(item) else null
        val ic = host?.let { cached(ctx, it) }
        if (host != null && ic == null) load(ctx, host)
        return if (ic != null) framed(ic, sizePx) else letter(item.optString("title"), sizePx)
    }

    private fun square(b: Bitmap): Bitmap {
        val s = maxOf(b.width, b.height)
        if (b.width == s && b.height == s) return b
        val out = Bitmap.createBitmap(s, s, Bitmap.Config.ARGB_8888)
        Canvas(out).drawBitmap(b, ((s - b.width) / 2).toFloat(), ((s - b.height) / 2).toFloat(), null)
        return out
    }

    fun framed(icon: Bitmap, size: Int): Bitmap {
        val out = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
        val c = Canvas(out)
        val r = size * 0.24f
        c.drawRoundRect(RectF(0f, 0f, size.toFloat(), size.toFloat()), r, r, Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.WHITE })
        val pad = size * 0.16f
        c.drawBitmap(icon, null, RectF(pad, pad, size - pad, size - pad), Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG))
        return out
    }

    fun letter(title: String, size: Int): Bitmap {
        val out = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
        val c = Canvas(out)
        val ch = title.trim().firstOrNull()?.uppercaseChar()?.toString() ?: "?"
        val bg = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = TILES[(title.hashCode() and 0x7fffffff) % TILES.size] }
        val r = size * 0.24f
        c.drawRoundRect(RectF(0f, 0f, size.toFloat(), size.toFloat()), r, r, bg)
        val tp = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.WHITE; textSize = size * 0.46f; typeface = Typeface.DEFAULT_BOLD; textAlign = Paint.Align.CENTER }
        val y = size / 2f - (tp.descent() + tp.ascent()) / 2f
        c.drawText(ch, size / 2f, y, tp)
        return out
    }
}
