// The tile, rendered: the store's Wear OS tile screenshot (docs/store-assets/capture-plan.md, slide 07c) and
// the tile picker's preview image (the manifest's androidx.wear.tiles.PREVIEW). Both are the real tile layout
// (statusTileLayout) over the made-up world in store/demo-world.json, both servers online, drawn by the Tiles
// renderer under Robolectric's native graphics on a 192dp round screen at 2x (384 x 384 px, no frame).
//
//   STORE_CAPTURE_WEAR=1     store/captures/android/<lang>/wear/07c.png (scripts/store-assets/capture-android.sh)
//   WEAR_TILE_PREVIEW=1      wear/src/main/res/drawable[-<lang>]-nodpi/tile_preview.png, every ga language;
//                            rerun after changing the tile's layout or its words, and commit the images.
//
// Skipped unless one of them is set.

package com.flagshipserver.wear

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.view.View
import android.widget.FrameLayout
import androidx.core.content.ContextCompat
import androidx.test.core.app.ApplicationProvider
import androidx.wear.protolayout.LayoutElementBuilders
import androidx.wear.protolayout.ResourceBuilders
import androidx.wear.tiles.renderer.TileRenderer
import com.flagshipserver.companion.PodStatusSnapshot
import com.flagshipserver.companion.WatchContext
import org.json.JSONObject
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.ParameterizedRobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File
import java.util.concurrent.TimeUnit

@RunWith(ParameterizedRobolectricTestRunner::class)
@Config(sdk = [33], qualifiers = "w192dp-h192dp-round-watch-night-xhdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class StoreTileCaptureTest(private val lang: String) {

    private val root = generateSequence(File("").absoluteFile) { it.parentFile }.firstOrNull { File(it, "store/demo-world.json").exists() }

    @Test
    fun capture() {
        val store = System.getenv("STORE_CAPTURE_WEAR") != null
        val preview = System.getenv("WEAR_TILE_PREVIEW") != null
        assumeTrue("neither STORE_CAPTURE_WEAR nor WEAR_TILE_PREVIEW is set", (store || preview) && root != null)
        val world = JSONObject(File(root, "store/demo-world.json").readText())
        val servers = world.getJSONArray("servers").let { a -> (0 until a.length()).map { a.getJSONObject(it) } }
            .sortedBy { if (it.getBoolean("leader")) 0 else 1 }
        val data = WatchContext(
            status = PodStatusSnapshot(
                username = world.getString("account"),
                pods = servers.map { s ->
                    PodStatusSnapshot.Pod(
                        podId = "store-${s.getString("name")}", name = s.getString("name"), fqdn = s.getString("fqdn"),
                        statusRaw = "online", isLeader = s.getBoolean("leader"),
                    )
                },
                updatedAt = 1,
            ),
            updatedAt = 1,
        )

        RuntimeEnvironment.setQualifiers("+" + resourceQualifier(lang))
        val ctx = ApplicationProvider.getApplicationContext<android.content.Context>()
        val bitmap = render(ctx, statusTileLayout(ctx, data))

        if (store) write(File(root, "store/captures/android/$lang/wear/07c.png"), bitmap)
        if (preview) {
            val dir = if (lang == "en") "drawable-nodpi" else "drawable-${resourceQualifier(lang)}-nodpi"
            write(File(root, "apps/mobile/android/wear/src/main/res/$dir/tile_preview.png"), bitmap)
        }
    }

    private fun render(ctx: android.content.Context, element: LayoutElementBuilders.LayoutElement): Bitmap {
        val px = ctx.resources.displayMetrics.let { (192 * it.density).toInt() }
        val parent = FrameLayout(ctx).apply { setBackgroundColor(Color.BLACK) }
        val renderer = TileRenderer(ctx, ContextCompat.getMainExecutor(ctx)) { }
        val future = renderer.inflateAsync(
            LayoutElementBuilders.Layout.Builder().setRoot(element).build(),
            ResourceBuilders.Resources.Builder().setVersion(StatusTileService.RESOURCES_VERSION).build(),
            parent,
        )
        repeat(20) { if (!future.isDone) shadowOf(ctx.mainLooper).idle() }
        future.get(10, TimeUnit.SECONDS)
        val spec = View.MeasureSpec.makeMeasureSpec(px, View.MeasureSpec.EXACTLY)
        parent.measure(spec, spec)
        parent.layout(0, 0, px, px)
        shadowOf(ctx.mainLooper).idle()
        return Bitmap.createBitmap(px, px, Bitmap.Config.ARGB_8888).also { parent.draw(Canvas(it)) }
    }

    private fun write(file: File, bitmap: Bitmap) {
        file.parentFile.mkdirs()
        file.outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    companion object {
        private fun resourceQualifier(lang: String) = when (lang) {
            "zh-Hans" -> "b+zh+Hans"
            "pt-BR" -> "pt-rBR"
            else -> lang
        }

        @JvmStatic
        @ParameterizedRobolectricTestRunner.Parameters(name = "{0}")
        fun cases(): List<Array<Any>> {
            val root = generateSequence(File("").absoluteFile) { it.parentFile }.firstOrNull { File(it, "i18n/locales.json").exists() }
            // Outside Robolectric's sandbox org.json is a stub: read the flat locale objects by pattern.
            val ga = root?.let { r ->
                Regex("""\{[^{}]*\}""").findAll(File(r, "i18n/locales.json").readText()).map { it.value }
                    .filter { Regex(""""status":\s*"ga"""").containsMatchIn(it) }
                    .mapNotNull { Regex(""""code":\s*"([^"]+)"""").find(it)?.groupValues?.get(1) }.toList()
            } ?: listOf("en")
            val langs = System.getenv("STORE_LANGS")?.split(',') ?: ga
            return langs.map { arrayOf<Any>(it) }
        }
    }
}
