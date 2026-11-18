// The share card drawn on a device (docs/voici-and-messages.md §2.10): a 1200×630 Bitmap in the theme's colours, the
// photo as a circle (or the name's initial on an accent disc), the name, voi.ci/<username> and the wordmark; no words
// to translate. JPEG 90 stepping down by 10 to 40 until it fits the share cap, then any APP1-APP15/COM segment the
// encoder wrote is cut out (VoiciJpeg.stripMetadata), so no metadata leaves the phone.
package com.flagshipserver.app.core.voici

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.BitmapShader
import android.graphics.Canvas
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.Shader
import android.graphics.Typeface
import android.text.TextUtils
import android.text.TextPaint
import java.io.ByteArrayOutputStream

object AndroidShareCardRenderer : VoiciShareCardRenderer {
    private const val W = VoiciPage.VOICI_SHARE_IMAGE_WIDTH
    private const val H = VoiciPage.VOICI_SHARE_IMAGE_HEIGHT

    override fun render(profile: VoiciProfile, username: String, avatar: ByteArray?): ByteArray? {
        val bmp = Bitmap.createBitmap(W, H, Bitmap.Config.ARGB_8888)
        try {
            draw(Canvas(bmp), profile, username, avatar)
            for (q in VoiciShareCards.QUALITIES) {
                val out = ByteArrayOutputStream()
                if (!bmp.compress(Bitmap.CompressFormat.JPEG, q, out)) return null
                val clean = VoiciJpeg.stripMetadata(out.toByteArray()) ?: return null
                if (VoiciShareCards.acceptable(clean)) return clean
            }
            return null
        } finally {
            bmp.recycle()
        }
    }

    private fun draw(c: Canvas, profile: VoiciProfile, username: String, avatar: ByteArray?) {
        val pal = VoiciShareCards.palette(profile.theme)
        c.drawColor(pal.canvas)
        val cx = 220f
        val cy = 290f
        val r = 120f
        val photo = avatar?.let { runCatching { BitmapFactory.decodeByteArray(it, 0, it.size) }.getOrNull() }
        if (photo != null) {
            val side = minOf(photo.width, photo.height).toFloat()
            val scale = (2 * r) / side
            val m = Matrix().apply {
                postTranslate(-(photo.width - side) / 2f, -(photo.height - side) / 2f)
                postScale(scale, scale)
                postTranslate(cx - r, cy - r)
            }
            val shader = BitmapShader(photo, Shader.TileMode.CLAMP, Shader.TileMode.CLAMP).apply { setLocalMatrix(m) }
            c.drawCircle(cx, cy, r, Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG).apply { this.shader = shader })
            photo.recycle()
        } else {
            c.drawCircle(cx, cy, r, Paint(Paint.ANTI_ALIAS_FLAG).apply { color = pal.accent })
            val p = Paint(Paint.ANTI_ALIAS_FLAG).apply {
                color = pal.canvas
                textSize = 112f
                typeface = Typeface.create(Typeface.SANS_SERIF, Typeface.BOLD)
                textAlign = Paint.Align.CENTER
            }
            val fm = p.fontMetrics
            c.drawText(VoiciShareCards.initial(profile.displayName), cx, cy - (fm.ascent + fm.descent) / 2f, p)
        }
        val name = TextPaint(Paint.ANTI_ALIAS_FLAG).apply {
            color = pal.ink
            textSize = 72f
            typeface = Typeface.create(Typeface.SANS_SERIF, Typeface.BOLD)
        }
        val shown = TextUtils.ellipsize(profile.displayName, name, 700f, TextUtils.TruncateAt.END).toString()
        c.drawText(shown, 400f, 290f, name)
        val addr = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            color = pal.muted
            textSize = 40f
            typeface = Typeface.MONOSPACE
        }
        c.drawText("voi.ci/$username", 400f, 360f, addr)
        c.drawRect(100f, 519f, 1100f, 521f, Paint().apply { color = pal.rule })
        c.drawCircle(110f, 568f, 9f, Paint(Paint.ANTI_ALIAS_FLAG).apply { color = pal.accent })
        val mark = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            color = pal.ink
            textSize = 40f
            typeface = Typeface.create(Typeface.SANS_SERIF, Typeface.BOLD)
        }
        c.drawText("voi.ci", 128f, 582f, mark)
    }
}
