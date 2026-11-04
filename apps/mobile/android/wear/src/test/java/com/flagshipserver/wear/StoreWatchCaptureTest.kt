// Store screenshots of the Wear OS app (docs/store-assets/capture-plan.md): the watch's home over the
// made-up world in store/demo-world.json, every ga language, written to
// store/captures/android/<lang>/wear/07.png (both servers online) and 07b.png (cabin waiting).
// Rendered by Robolectric's native graphics on a 192dp round screen at 2x (384 x 384 px), since the
// phone emulator can't hold the watch build. Opt-in: skipped unless STORE_CAPTURE_WEAR is set;
// scripts/store-assets/capture-android.sh runs it.

package com.flagshipserver.wear

import android.graphics.Bitmap
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.performSemanticsAction
import androidx.test.core.app.ApplicationProvider
import com.flagshipserver.companion.ApproveReply
import com.flagshipserver.companion.PendingApproval
import com.flagshipserver.companion.PodStatusSnapshot
import com.flagshipserver.companion.WatchContext
import org.json.JSONObject
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.ParameterizedRobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File

@RunWith(ParameterizedRobolectricTestRunner::class)
@Config(sdk = [33], qualifiers = "w192dp-h192dp-round-watch-night-xhdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class StoreWatchCaptureTest(private val lang: String, private val waiting: Boolean) {
    @get:Rule val compose = createAndroidComposeRule<androidx.activity.ComponentActivity>()

    private val root = generateSequence(File("").absoluteFile) { it.parentFile }.firstOrNull { File(it, "store/demo-world.json").exists() }

    @Test
    fun capture() {
        assumeTrue("STORE_CAPTURE_WEAR not set: not a store capture run", System.getenv("STORE_CAPTURE_WEAR") != null && root != null)
        val world = JSONObject(File(root, "store/demo-world.json").readText())
        val servers = world.getJSONArray("servers").let { a -> (0 until a.length()).map { a.getJSONObject(it) } }
            .sortedBy { if (it.getBoolean("leader")) 0 else 1 }
        val asking = world.getJSONObject("unlockRequest")
        val now = System.currentTimeMillis()
        val waitingFor = servers.filter { waiting && it.getString("name") == asking.getString("server") }

        RuntimeEnvironment.setQualifiers("+" + resourceQualifier(lang))
        val ctx = ApplicationProvider.getApplicationContext<android.content.Context>()
        WatchStore.write(
            ctx,
            WatchContext(
                status = PodStatusSnapshot(
                    username = world.getString("account"),
                    pods = servers.map { s ->
                        PodStatusSnapshot.Pod(
                            podId = "store-${s.getString("name")}", name = s.getString("name"), fqdn = s.getString("fqdn"),
                            statusRaw = if (s in waitingFor) "offline" else "online", isLeader = s.getBoolean("leader"),
                        )
                    },
                    updatedAt = now,
                ),
                pendingApprovals = waitingFor.map { s ->
                    PendingApproval(
                        requestId = "store-${s.getString("name")}", serverFqdn = s.getString("fqdn"), serverName = s.getString("name"),
                        requestedAt = now - asking.getLong("askedMinutesAgo") * 60_000,
                    )
                },
                updatedAt = now,
            ).encode(),
        )
        compose.setContent {
            androidx.wear.compose.material.MaterialTheme {
                WearApp(sync = {}, approve = { _, a -> ApproveReply(a.serverFqdn, ok = true) }, presence = { _, _ -> null })
            }
        }
        compose.waitForIdle()
        // Past the app's title, so the servers (and the waiting one) fill the round face.
        compose.onNode(androidx.compose.ui.test.hasScrollAction())
            .performSemanticsAction(androidx.compose.ui.semantics.SemanticsActions.ScrollBy) { it(0f, 120f) }
        compose.waitForIdle()
        val out = File(root, "store/captures/android/$lang/wear").also { it.mkdirs() }
        // captureToImage waits for a hardware frame Robolectric never draws: draw the window ourselves.
        val view = compose.activity.window.decorView
        val bitmap = Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888)
        compose.runOnUiThread { view.draw(android.graphics.Canvas(bitmap)) }
        File(out, if (waiting) "07b.png" else "07.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    companion object {
        private fun resourceQualifier(lang: String) = when (lang) {
            "zh-Hans" -> "b+zh+Hans"
            "pt-BR" -> "pt-rBR"
            else -> lang
        }

        @JvmStatic
        @ParameterizedRobolectricTestRunner.Parameters(name = "{0} waiting={1}")
        fun cases(): List<Array<Any>> {
            val root = generateSequence(File("").absoluteFile) { it.parentFile }.firstOrNull { File(it, "i18n/locales.json").exists() }
            // Outside Robolectric's sandbox org.json is a stub: read the flat locale objects by pattern.
            val ga = root?.let { r ->
                Regex("""\{[^{}]*\}""").findAll(File(r, "i18n/locales.json").readText()).map { it.value }
                    .filter { Regex(""""status":\s*"ga"""").containsMatchIn(it) }
                    .mapNotNull { Regex(""""code":\s*"([^"]+)"""").find(it)?.groupValues?.get(1) }.toList()
            } ?: listOf("en")
            val langs = System.getenv("STORE_LANGS")?.split(',') ?: ga
            return langs.flatMap { listOf(arrayOf<Any>(it, false), arrayOf<Any>(it, true)) }
        }
    }
}
