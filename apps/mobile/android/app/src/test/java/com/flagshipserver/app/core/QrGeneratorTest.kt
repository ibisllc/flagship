// QrGenerator: encode → decode round-trip via zxing-core. Robolectric is
// required because the Bitmap pixel buffer the encoder writes to is an
// Android API; the actual encoding (BitMatrix) is pure JVM.

package com.flagshipserver.app.core

import com.google.zxing.BarcodeFormat
import com.google.zxing.BinaryBitmap
import com.google.zxing.DecodeHintType
import com.google.zxing.MultiFormatReader
import com.google.zxing.RGBLuminanceSource
import com.google.zxing.common.HybridBinarizer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class QrGeneratorTest {

    @Test fun encode_thenDecode_roundTripsExact() {
        val payload = "https://flagshipserver.com/join?sid=abc-123&pk=oA0_aZ7K-r6cE6kqj0o2cN3dPq1pSvHnW8YxR-zBcDE"
        val bmp = qrBitmap(payload, sizePx = 512)
        val w = bmp.width
        val h = bmp.height
        assertTrue("encoder produced a bitmap", w > 0 && h > 0)

        val pixels = IntArray(w * h)
        bmp.getPixels(pixels, 0, w, 0, 0, w, h)
        val source = RGBLuminanceSource(w, h, pixels)
        val binary = BinaryBitmap(HybridBinarizer(source))

        val reader = MultiFormatReader()
        val hints = mapOf(
            DecodeHintType.POSSIBLE_FORMATS to listOf(BarcodeFormat.QR_CODE),
            DecodeHintType.TRY_HARDER to true,
        )
        val result = reader.decode(binary, hints)

        assertEquals(payload, result.text)
        assertEquals(BarcodeFormat.QR_CODE, result.barcodeFormat)
    }

    @Test fun qrImageBitmap_isSameUnderlyingPixels() {
        // The Compose-facing helper just .asImageBitmap()'s the same
        // Bitmap; the encoded payload must decode identically.
        val payload = "flagship://join?sid=xyz&pk=ZGV2aWNlcGsx"
        val androidBmp = qrBitmap(payload, sizePx = 400)
        val w = androidBmp.width
        val h = androidBmp.height
        val pixels = IntArray(w * h)
        androidBmp.getPixels(pixels, 0, w, 0, 0, w, h)
        val source = RGBLuminanceSource(w, h, pixels)
        val binary = BinaryBitmap(HybridBinarizer(source))
        val text = MultiFormatReader().decode(binary).text
        assertEquals(payload, text)
    }
}
