// Phase 3b — QR-bitmap encoder for the admin's pairing window.
//
// mlkit (already a dep) only DECODES QR codes; we need to GENERATE one
// for the admin to display. zxing core is a pure-JVM encoder with no
// Android dependencies. We render the BitMatrix into an ARGB Bitmap the
// Compose `Image(bitmap = …)` surface can show.

package com.flagshipserver.app.core

import android.graphics.Bitmap
import android.graphics.Color
import com.google.zxing.BarcodeFormat
import com.google.zxing.EncodeHintType
import com.google.zxing.qrcode.QRCodeWriter
import com.google.zxing.qrcode.decoder.ErrorCorrectionLevel

object PairingQr {
    /**
     * Encode [contents] (the join universal link) into a square QR
     * [Bitmap] of [sizePx] × [sizePx]. Medium error-correction keeps
     * the code scannable through a little screen glare without inflating
     * the module count for our short URL payload.
     */
    fun encode(contents: String, sizePx: Int = 720): Bitmap {
        val hints = mapOf(
            EncodeHintType.ERROR_CORRECTION to ErrorCorrectionLevel.M,
            EncodeHintType.MARGIN to 1,
            EncodeHintType.CHARACTER_SET to "UTF-8",
        )
        val matrix = QRCodeWriter().encode(contents, BarcodeFormat.QR_CODE, sizePx, sizePx, hints)
        val w = matrix.width
        val h = matrix.height
        val pixels = IntArray(w * h)
        for (y in 0 until h) {
            val row = y * w
            for (x in 0 until w) {
                pixels[row + x] = if (matrix[x, y]) Color.BLACK else Color.WHITE
            }
        }
        return Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888).apply {
            setPixels(pixels, 0, w, 0, 0, w, h)
        }
    }
}
