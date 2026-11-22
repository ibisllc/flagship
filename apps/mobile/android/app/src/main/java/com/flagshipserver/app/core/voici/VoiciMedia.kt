// Pictures and link cards for a voi.ci page (docs/voici-and-messages.md §2.3, §2.5). A photo is re-encoded on
// the device from pixels (square crop, 512 × 512, JPEG 0.82 stepping down to 0.6, sRGB, at most 150 KiB) and any
// APP1-APP15/COM segment the encoder still writes is cut out, so no EXIF, XMP, ICC or GPS leaves the phone. A link
// card is fetched once, by this device, when the post is written: GET, 5 s, 512 KiB, no cookies, no script; its
// og: fields are kept and its image re-encoded to at most 400 × 210, 40 KiB.

package com.flagshipserver.app.core.voici

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.ColorSpace
import android.graphics.ImageDecoder
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.Rect
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import kotlin.math.roundToInt

object VoiciJpeg {
    const val AVATAR_SIZE = 512
    const val CARD_MAX_W = 400
    const val CARD_MAX_H = 210

    /**
     * Removes every APPn segment but APP0 (JFIF), and COM, from a baseline or progressive JPEG; null when the bytes
     * are not a JPEG this can walk. Pure, for the metadata test.
     */
    fun stripMetadata(b: ByteArray): ByteArray? {
        if (b.size < 4 || b[0] != 0xff.toByte() || b[1] != 0xd8.toByte()) return null
        val out = ByteArrayOutputStream(b.size)
        out.write(0xff); out.write(0xd8)
        var i = 2
        while (i + 3 < b.size) {
            if (b[i] != 0xff.toByte()) return null
            val marker = b[i + 1].toInt() and 0xff
            if (marker == 0xff) { i++; continue }
            if (marker == 0xda) {
                out.write(b, i, b.size - i)
                return out.toByteArray()
            }
            val len = ((b[i + 2].toInt() and 0xff) shl 8) or (b[i + 3].toInt() and 0xff)
            if (len < 2 || i + 2 + len > b.size) return null
            val drop = (marker in 0xe1..0xef) || marker == 0xfe
            if (!drop) out.write(b, i, 2 + len)
            i += 2 + len
        }
        return null
    }

    /** The longest side the photo editor works on. */
    const val EDITOR_MAX_SIDE = 2048

    /**
     * The picked bytes as an upright ARGB_8888 sRGB bitmap whose longest side is at most [maxSide]: ImageDecoder applies
     * the EXIF orientation (BitmapFactory ignores it) and reads HEIF, wide-gamut and 16-bit sources the same way.
     */
    fun decode(bytes: ByteArray, maxSide: Int = EDITOR_MAX_SIDE): Result<Bitmap> {
        if (bytes.isEmpty()) return failure(VoiciImageFailure.UNREADABLE, "decode: no bytes")
        val bmp = try {
            ImageDecoder.decodeBitmap(ImageDecoder.createSource(ByteBuffer.wrap(bytes))) { decoder, info, _ ->
                val w = info.size.width
                val h = info.size.height
                val k = minOf(1.0, maxSide.toDouble() / maxOf(w, h))
                if (k < 1.0) decoder.setTargetSize(maxOf(1, (w * k).roundToInt()), maxOf(1, (h * k).roundToInt()))
                decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
                decoder.setTargetColorSpace(ColorSpace.get(ColorSpace.Named.SRGB))
            }
        } catch (e: Exception) {
            return failure(VoiciImageFailure.UNREADABLE, "decode: ${e.javaClass.simpleName}")
        }
        if (bmp.config == Bitmap.Config.ARGB_8888) return Result.success(bmp)
        // A 16-bit or hardware bitmap: redraw it as 8-bit sRGB.
        return Result.success(draw(bmp, Rect(0, 0, bmp.width, bmp.height), bmp.width, bmp.height))
    }

    private fun failure(f: VoiciImageFailure, step: String): Result<Nothing> {
        runCatching { android.util.Log.w("voici-image", step) }
        return Result.failure(VoiciImageException(f))
    }

    /**
     * The first JPEG within [maxBytes]: quality 82 stepping down to 60, then the picture a fifth smaller each round (never
     * under [minSide]). An encoder that fails at one size gets a freshly drawn copy at the next, so ENCODE_FAILED means
     * no size worked at all.
     */
    internal fun encode(bmp: Bitmap, maxBytes: Int, minSide: Int = 256): Result<ByteArray> {
        var current = bmp
        var smallest = Int.MAX_VALUE
        var wrote = false
        while (true) {
            var q = 82
            while (q >= 60) {
                val out = ByteArrayOutputStream()
                val clean = if (current.compress(Bitmap.CompressFormat.JPEG, q, out)) stripMetadata(out.toByteArray()) else null
                if (clean == null || VoiciPage.voiciJpegHasMetadata(clean)) {
                    runCatching { android.util.Log.w("voici-image", "jpeg failed at ${current.width}x${current.height} q=$q") }
                    break
                }
                wrote = true
                if (clean.size <= maxBytes) return Result.success(clean)
                smallest = minOf(smallest, clean.size)
                q -= 4
            }
            val k = 0.8
            val w = (current.width * k).toInt()
            val h = (current.height * k).toInt()
            if (maxOf(w, h) < minSide || minOf(w, h) < 1) break
            current = draw(current, Rect(0, 0, current.width, current.height), w, h)
        }
        if (!wrote) return failure(VoiciImageFailure.ENCODE_FAILED, "jpeg: no size could be written")
        return failure(VoiciImageFailure.TOO_DETAILED, "too detailed: $smallest bytes, cap $maxBytes")
    }

    private fun draw(src: Bitmap, from: Rect, w: Int, h: Int): Bitmap {
        val dst = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888, false, ColorSpace.get(ColorSpace.Named.SRGB))
        Canvas(dst).apply {
            drawColor(android.graphics.Color.WHITE)
            drawBitmap(src, from, Rect(0, 0, w, h), Paint(Paint.FILTER_BITMAP_FLAG))
        }
        return dst
    }

    /** An affine map [a, b, c, d, tx, ty] as an android.graphics.Matrix. */
    fun matrixOf(m: DoubleArray): Matrix = Matrix().apply {
        setValues(floatArrayOf(m[0].toFloat(), m[2].toFloat(), m[4].toFloat(), m[1].toFloat(), m[3].toFloat(), m[5].toFloat(), 0f, 0f, 1f))
    }

    /** [src] (upright) mapped through the edit onto a white [side] × [side] sRGB square. */
    fun render(src: Bitmap, edit: VoiciImageEdit, side: Int): Bitmap {
        val dst = Bitmap.createBitmap(side, side, Bitmap.Config.ARGB_8888, false, ColorSpace.get(ColorSpace.Named.SRGB))
        Canvas(dst).apply {
            drawColor(android.graphics.Color.WHITE)
            drawBitmap(src, matrixOf(edit.output(side.toDouble())), Paint(Paint.FILTER_BITMAP_FLAG))
        }
        return dst
    }

    /** The avatar: the editor's crop of [src] (turns, flip, square) at 512 × 512, ≤ 150 KiB. */
    fun avatar(src: Bitmap, edit: VoiciImageEdit): Result<ByteArray> = encode(render(src, edit, AVATAR_SIZE), VoiciPage.VOICI_AVATAR_MAX_BYTES)

    /** The avatar from picked bytes with the centred crop. Null when the picture can't be read or won't fit. */
    fun avatar(bytes: ByteArray): ByteArray? =
        decode(bytes, AVATAR_SIZE * 2).getOrNull()?.let { avatar(it, VoiciImageEdit.of(it.width, it.height)).getOrNull() }

    /** A card image: scaled to fit 400 × 210, ≤ 40 KiB. */
    fun cardImage(bytes: ByteArray): ByteArray? {
        val src = decode(bytes, CARD_MAX_W).getOrNull() ?: return null
        val scale = minOf(CARD_MAX_W.toFloat() / src.width, CARD_MAX_H.toFloat() / src.height, 1f)
        val w = maxOf(1, (src.width * scale).toInt())
        val h = maxOf(1, (src.height * scale).toInt())
        return encode(draw(src, Rect(0, 0, src.width, src.height), w, h), VoiciPage.VOICI_CARD_IMAGE_MAX_BYTES, minSide = 160).getOrNull()
    }
}

/** Why a picture could not become a voi.ci image; each has its own sentence (VoiciCopy.photoProblem). */
enum class VoiciImageFailure { UNREADABLE, ENCODE_FAILED, TOO_DETAILED }

class VoiciImageException(val failure: VoiciImageFailure) : Exception(failure.name)

/** What a link card keeps from a page's og: tags. */
data class VoiciOgFields(val title: String?, val site: String?, val description: String?, val image: String?)

object VoiciLinkCards {
    const val FETCH_CAP = 512 * 1024
    const val TIMEOUT_MS = 5_000L

    private val META = Regex("<meta\\b[^>]*>", RegexOption.IGNORE_CASE)
    private fun attr(tag: String, name: String): String? =
        Regex("\\b$name\\s*=\\s*(\"([^\"]*)\"|'([^']*)')", RegexOption.IGNORE_CASE).find(tag)?.let { it.groupValues[2].ifEmpty { it.groupValues[3] } }

    private fun unescape(s: String): String = s
        .replace("&quot;", "\"").replace("&#39;", "'").replace("&#x27;", "'").replace("&apos;", "'")
        .replace("&lt;", "<").replace("&gt;", ">").replace("&nbsp;", " ").replace("&amp;", "&")

    /** The og: fields of an HTML document (only `<meta property|name="og:…" content="…">` is read). Pure. */
    fun parseOg(html: String): VoiciOgFields {
        val found = HashMap<String, String>()
        for (m in META.findAll(html)) {
            val key = (attr(m.value, "property") ?: attr(m.value, "name"))?.lowercase() ?: continue
            if (!key.startsWith("og:")) continue
            val content = attr(m.value, "content") ?: continue
            found.putIfAbsent(key, unescape(content))
        }
        return VoiciOgFields(found["og:title"], found["og:site_name"], found["og:description"], found["og:image"])
    }

    /** One line, NFC, refusals dropped rather than refused, cut to [max] code points. Null when nothing remains. */
    fun clean(s: String?, field: VoiciTextField): String? {
        if (s == null) return null
        var t = java.text.Normalizer.normalize(s, java.text.Normalizer.Form.NFC)
            .replace(Regex("[\\u0000-\\u001f\\u007f-\\u009f\\u202a-\\u202e\\u2066-\\u2069\\ufeff]"), " ")
            .replace(Regex("\\s+"), " ").trim().trim('\u200b', '\u200c', '\u200d', '\u2060').trim()
        val cps = t.codePointCount(0, t.length)
        if (cps > field.max) t = t.substring(0, t.offsetByCodePoints(0, field.max)).trim()
        if (t.isEmpty() && field.min > 0) return null
        return t.takeIf { VoiciText.checkVoiciText(field, it) == null }
    }

    /** The card for a page's og: fields: null when there is no title. [imageSha] is the re-encoded image's hash. */
    fun card(og: VoiciOgFields, host: String, imageSha: String?): VoiciCard? {
        val title = clean(og.title, VoiciTextField.cardTitle) ?: return null
        return VoiciCard(title, clean(og.site ?: host, VoiciTextField.cardSite) ?: "", clean(og.description, VoiciTextField.cardDescription) ?: "", imageSha)
    }
}

/** Fetches a link's card on this device (§2.5): GET, 5 s, 512 KiB, no cookies, https only (redirects too). */
class VoiciCardFetcher(http: okhttp3.OkHttpClient, private val putImage: (ByteArray) -> String?) {
    private val client = http.newBuilder()
        .cookieJar(okhttp3.CookieJar.NO_COOKIES)
        .callTimeout(VoiciLinkCards.TIMEOUT_MS, java.util.concurrent.TimeUnit.MILLISECONDS)
        .followRedirects(true)
        .followSslRedirects(false)
        .build()

    private fun get(url: String, accept: String): ByteArray? {
        if (!url.startsWith("https://")) return null
        val req = okhttp3.Request.Builder().url(url).get().header("accept", accept).header("user-agent", "Flagship link preview").build()
        return runCatching {
            client.newCall(req).execute().use { r ->
                if (!r.isSuccessful || r.request.url.scheme != "https") return@use null
                val src = r.body?.source() ?: return@use null
                val buf = okio.Buffer()
                while (buf.size <= VoiciLinkCards.FETCH_CAP && src.read(buf, 8192) != -1L) Unit
                if (buf.size > VoiciLinkCards.FETCH_CAP) null else buf.readByteArray()
            }
        }.getOrNull()
    }

    /** The card for [url], or null when the page has no title or can't be read. Blocking: call off the main thread. */
    fun fetch(url: String): VoiciCard? {
        val host = VoiciText.voiciUrlHost(url) ?: return null
        val html = get(url, "text/html") ?: return null
        val og = VoiciLinkCards.parseOg(String(html, Charsets.UTF_8))
        val imageUrl = og.image?.let { runCatching { java.net.URI(url).resolve(it).toString() }.getOrNull() }
        val sha = imageUrl?.let { get(it, "image/*") }?.let(VoiciJpeg::cardImage)?.let(putImage)
        return VoiciLinkCards.card(og, host, sha)
    }
}
