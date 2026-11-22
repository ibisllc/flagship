// The photo editor's rules (VoiciImageEdit) against packages/protocol/test-vectors/voici-image-edit
// (tools/voici-image-edit-vectors.mjs), and the encoder that applies them (VoiciJpeg), drawn for real
// (Robolectric native graphics).

package com.flagshipserver.app.core.voici

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.double
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.ByteArrayOutputStream

@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [33])
class VoiciImageEditTest {
    @Test fun vectors() {
        val v = Json.parseToJsonElement(VoiciVectorsTest.vectorsFile("packages/protocol/test-vectors/voici-image-edit/vectors.json").readText()).jsonObject
        for (c in v["cases"]!!.jsonArray.map { it.jsonObject }) {
            val name = c["name"]!!.jsonPrimitive.content
            var e = VoiciImageEdit(c["width"]!!.jsonPrimitive.double, c["height"]!!.jsonPrimitive.double)
            for (op in c["ops"]!!.jsonArray.map { it.jsonArray }) {
                val n = { i: Int -> op[i].jsonPrimitive.double }
                e = when (op[0].jsonPrimitive.content) {
                    "rotate" -> e.rotate()
                    "flip" -> e.flip()
                    "zoom" -> e.withZoom(n(1))
                    else -> e.pan(n(1), n(2), n(3))
                }
            }
            val x = c["expect"]!!.jsonObject
            fun near(got: Double, key: String, want: Double) = assertEquals("$name: $key", want, got, 1e-6)
            assertEquals(name, x["turns"]!!.jsonPrimitive.int, e.turns)
            assertEquals(name, x["flipped"]!!.jsonPrimitive.boolean, e.flipped)
            near(e.zoom, "zoom", x["zoom"]!!.jsonPrimitive.double)
            near(e.displayWidth, "displayWidth", x["displayWidth"]!!.jsonPrimitive.double)
            near(e.displayHeight, "displayHeight", x["displayHeight"]!!.jsonPrimitive.double)
            val crop = x["crop"]!!.jsonObject
            near(e.crop.x, "crop.x", crop["x"]!!.jsonPrimitive.double)
            near(e.crop.y, "crop.y", crop["y"]!!.jsonPrimitive.double)
            near(e.crop.side, "crop.side", crop["side"]!!.jsonPrimitive.double)
            for ((key, got) in listOf("orient" to e.orient(), "output512" to e.output(512.0))) {
                x[key]!!.jsonArray.forEachIndexed { i, w -> near(got[i], "$key[$i]", w.jsonPrimitive.double) }
            }
        }
    }

    /** 200 × 100: left half red, right half blue, a green 30 × 30 top-left corner. */
    private fun quadrants(): Bitmap {
        val b = Bitmap.createBitmap(200, 100, Bitmap.Config.ARGB_8888)
        Canvas(b).apply {
            val p = Paint()
            p.color = Color.RED; drawRect(0f, 0f, 100f, 100f, p)
            p.color = Color.BLUE; drawRect(100f, 0f, 200f, 100f, p)
            p.color = Color.GREEN; drawRect(0f, 0f, 30f, 30f, p)
        }
        return b
    }

    private fun Bitmap.at(x: Int, y: Int): String {
        val c = getPixel(x, y)
        val (r, g, b) = Triple(Color.red(c), Color.green(c), Color.blue(c))
        return when {
            r > 200 && g < 60 && b < 60 -> "r"
            g > 200 && r < 60 && b < 60 -> "g"
            b > 200 && r < 60 && g < 60 -> "b"
            else -> "?"
        }
    }

    @Test fun renderAppliesCropTurnAndFlip() {
        val src = quadrants()
        var e = VoiciImageEdit.of(200, 100)
        var out = VoiciJpeg.render(src, e, 64)
        assertEquals("r", out.at(8, 32))
        assertEquals("b", out.at(56, 32))
        e = e.pan(1000.0, 0.0, 64.0)
        out = VoiciJpeg.render(src, e, 64)
        assertEquals("g", out.at(4, 4))
        assertEquals("r", out.at(4, 60))
        e = e.flip()
        out = VoiciJpeg.render(src, e, 64)
        assertEquals("g", out.at(60, 4))
        val t = VoiciImageEdit.of(200, 100).rotate().pan(0.0, 1000.0, 64.0)
        out = VoiciJpeg.render(src, t, 64)
        assertEquals("g", out.at(60, 4))
        assertEquals("r", out.at(4, 60))
    }

    @Test fun avatarIsA512JpegWithinTheCapWithNoMetadata() {
        val big = Bitmap.createBitmap(1600, 1200, Bitmap.Config.ARGB_8888)
        val rnd = java.util.Random(42)
        Canvas(big).apply {
            val p = Paint()
            repeat(1500) {
                p.color = Color.rgb(rnd.nextInt(256), rnd.nextInt(256), rnd.nextInt(256))
                val x = rnd.nextFloat() * 1600; val y = rnd.nextFloat() * 1200
                drawRect(x, y, x + 4 + rnd.nextFloat() * 150, y + 4 + rnd.nextFloat() * 150, p)
            }
        }
        val jpeg = VoiciJpeg.avatar(big, VoiciImageEdit.of(1600, 1200).withZoom(1.5).rotate().flip()).getOrThrow()
        assertTrue(VoiciPage.isVoiciJpeg(jpeg))
        assertFalse(VoiciPage.voiciJpegHasMetadata(jpeg))
        assertTrue(jpeg.size <= VoiciPage.VOICI_AVATAR_MAX_BYTES)
        val decoded = VoiciJpeg.decode(jpeg).getOrThrow()
        assertEquals(512, decoded.width)
        assertEquals(512, decoded.height)
        // The one-step path still works for a centred crop.
        val png = ByteArrayOutputStream().also { big.compress(Bitmap.CompressFormat.PNG, 100, it) }.toByteArray()
        assertTrue(VoiciJpeg.avatar(png) != null)
    }

    @Test fun eachFailureHasItsOwnCode() {
        assertEquals(VoiciImageFailure.UNREADABLE, (VoiciJpeg.decode(byteArrayOf(1, 2, 3, 4)).exceptionOrNull() as VoiciImageException).failure)
        assertEquals(VoiciImageFailure.UNREADABLE, (VoiciJpeg.decode(ByteArray(0)).exceptionOrNull() as VoiciImageException).failure)
        assertNotEquals(VoiciImageFailure.UNREADABLE, VoiciImageFailure.TOO_DETAILED)
    }
}
