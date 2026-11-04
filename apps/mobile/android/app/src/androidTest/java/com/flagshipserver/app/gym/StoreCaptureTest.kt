// Store screenshots (docs/store-assets/capture-plan.md): the real app over the made-up world in
// store/demo-world.json, one language per run, light and dark by the slide's place in the strip,
// written to files/store/<id>.png (01-06; the watch's 07/07b come from the wear module). Opt-in: skipped
// unless the runner gets `storeWorld` (the file, base64) and `storeLang`; scripts/store-assets/capture-android.sh
// passes both and pulls the files.
// Every step finds its node by test tag or by a demo-world text, never by English UI text.

package com.flagshipserver.app.gym

import android.app.LocaleManager
import android.app.UiModeManager
import android.content.Intent
import android.graphics.Bitmap
import android.os.LocaleList
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.hasScrollAction
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.onFirst
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performSemanticsAction
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import androidx.test.platform.app.InstrumentationRegistry
import com.flagshipserver.app.MainActivity
import com.flagshipserver.app.core.SmokeModeConfig
import org.junit.After
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.File
import java.io.FileOutputStream

class StoreCaptureTest : GymBase() {
    private val args = InstrumentationRegistry.getArguments()
    private val world = args.getString("storeWorld")?.let { String(android.util.Base64.decode(it, android.util.Base64.DEFAULT)) }
    private val lang = args.getString("storeLang") ?: "en"
    private val ctx get() = ApplicationProvider.getApplicationContext<android.content.Context>()
    private val out by lazy { File(ctx.filesDir, "store").also { it.deleteRecursively(); it.mkdirs() } }
    private var scenario: ActivityScenario<MainActivity>? = null

    private fun launchStore(tab: String, dark: Boolean, waiting: Boolean = false) {
        scenario?.close()
        val main = InstrumentationRegistry.getInstrumentation()
        // Either change recreates the app's activities a moment later: make them before the launch, then let them land.
        main.runOnMainSync {
            ctx.getSystemService(UiModeManager::class.java)
                .setApplicationNightMode(if (dark) UiModeManager.MODE_NIGHT_YES else UiModeManager.MODE_NIGHT_NO)
            val lm = ctx.getSystemService(LocaleManager::class.java)
            val locales = LocaleList.forLanguageTags(lang)
            if (lm.applicationLocales != locales) lm.applicationLocales = locales
        }
        Thread.sleep(2_000)
        val intent = Intent(ctx, MainActivity::class.java).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
            putExtra(SmokeModeConfig.EXTRA_SMOKE_MODE, true)
            putExtra(SmokeModeConfig.EXTRA_SMOKE_TAB, tab)
            putExtra(SmokeModeConfig.EXTRA_SMOKE_ADMIN_ROOT, true)
            putExtra(SmokeModeConfig.EXTRA_SMOKE_USERNAME, "river-otter")
            putExtra(SmokeModeConfig.EXTRA_SMOKE_STORE_WORLD, world)
            if (waiting) putExtra(SmokeModeConfig.EXTRA_SMOKE_STORE_WAITING, true)
        }
        scenario = ActivityScenario.launch(intent)
        composeRule.waitForIdle()
    }

    private fun shot(id: String) {
        // The test's clock drives the app's own delays (Home's Add button waits for its layout to settle).
        composeRule.mainClock.advanceTimeBy(2_000)
        composeRule.waitForIdle()
        Thread.sleep(1_000)
        val bitmap: Bitmap = InstrumentationRegistry.getInstrumentation().uiAutomation.takeScreenshot()
        FileOutputStream(File(out, "$id.png")).use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        bitmap.recycle()
        scenario?.close()
        scenario = null
    }

    /** Scroll (no fling) until the node tagged [tag] sits [topFraction] of the window from the top. */
    private fun bring(tag: String, topFraction: Float) {
        composeRule.onNode(hasTestTag(tag)).performScrollTo()
        composeRule.waitForIdle()
        val height = composeRule.onRoot().fetchSemanticsNode().size.height
        val top = composeRule.onNode(hasTestTag(tag)).fetchSemanticsNode().boundsInRoot.top
        val delta = top - height * topFraction
        runCatching {
            composeRule.onAllNodes(hasScrollAction()).onFirst().performSemanticsAction(SemanticsActions.ScrollBy) { it(0f, delta) }
        }
        composeRule.waitForIdle()
    }

    /** The app follows the system's language and dark mode again (the gym's other scenarios expect that). */
    @After
    fun restoreSystemSettings() {
        scenario?.close()
        InstrumentationRegistry.getInstrumentation().runOnMainSync {
            ctx.getSystemService(UiModeManager::class.java).setApplicationNightMode(UiModeManager.MODE_NIGHT_AUTO)
            ctx.getSystemService(LocaleManager::class.java).applicationLocales = LocaleList.getEmptyLocaleList()
        }
    }

    private fun androidx.compose.ui.test.junit4.ComposeTestRule.onRoot() = onNode(androidx.compose.ui.test.isRoot())

    @Test
    fun storeCaptures() {
        assumeTrue("storeWorld not given: not a store capture run", world != null)
        val apps = org.json.JSONObject(world!!).getJSONArray("apps")
        val summary = { slug: String ->
            (0 until apps.length()).map { apps.getJSONObject(it) }.first { it.getString("slug") == slug }.getString("summary")
        }

        // 01 Home: both servers online, home the leader.
        launchStore("home", dark = false)
        waitText("cabin.river-otter.flagship.services", 20_000)
        // Add / Restore waits for Home's layout to settle before it takes taps: the shot shows it ready.
        composeRule.mainClock.advanceTimeBy(2_000)
        composeRule.onNode(hasTestTag("home-add-server")).assertIsEnabled()
        shot("01")

        // 02 The start-up request cabin sent, in Activity's Server approvals.
        launchStore("activity", dark = true, waiting = true)
        tap("activity-section-approvals", 20_000)
        waitUntilExists("secret-request-card", 20_000)
        shot("02")

        // 03 Every app on both servers.
        launchStore("apps", dark = false)
        waitText(summary("budget"), 20_000)
        waitText(summary("chess-club"), 20_000)
        shot("03")

        // 04 Chess Club's Access control: Members only, its three members and their ranks.
        launchStore("apps", dark = true)
        tapText(summary("chess-club"), 20_000)
        tap("service-detail-access-row", 20_000)
        waitUntilExists("service-access-members-title", 15_000)
        waitText("Lea", 15_000, substring = false)
        bring("service-access-restrict-toggle", 0.105f)
        shot("04")

        // 05 home's server page at Backups.
        launchStore("home", dark = false)
        tapText("home", 20_000)
        waitUntilExists("sd-backups-status", 20_000)
        bring("sd-backups", 0.11f)
        shot("05")

        // 06 Messages: the conversation someone started from voi.ci/river-otter, under the owner's nickname for them.
        launchStore("messages", dark = true)
        waitUntilExists("messages-your-page", 20_000)
        tapMatching(tagPrefix("messages-row-"), 20_000)
        waitUntilExists("thread-compose", 15_000)
        waitUntilExists("bubble-status", 15_000)
        shot("06")
    }
}
