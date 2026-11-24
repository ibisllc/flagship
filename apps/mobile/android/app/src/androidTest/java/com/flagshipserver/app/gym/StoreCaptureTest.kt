// Store screenshots (docs/store-assets/capture-plan.md): the real app over the made-up world in
// store/demo-world.json, one language per run, light and dark by the slide's place in the strip,
// written to files/store/<id>.png (01-06, the 0.4 order: call, Social, Home, Apps, Access, Backups; the watch's
// 07/07b/07c come from the wear module). Opt-in: skipped
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

    private fun shell(cmd: String): String =
        InstrumentationRegistry.getInstrumentation().uiAutomation.executeShellCommand(cmd).let { fd ->
            android.os.ParcelFileDescriptor.AutoCloseInputStream(fd).use { it.readBytes().decodeToString() }
        }

    /** A density change redraws the status bar with its icons doubled: demo mode again, as capture-android.sh sets it. */
    private fun demoStatusBar() {
        val demo = { args: String -> shell("am broadcast -a com.android.systemui.demo -e command $args") }
        demo("exit"); Thread.sleep(500)
        demo("enter")
        demo("clock -e hhmm 0941")
        demo("battery -e level 100 -e plugged false")
        demo("network -e wifi show -e level 4 -e mobile hide")
        demo("notifications -e visible false")
        Thread.sleep(1_000)
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

        val store = com.flagshipserver.app.core.StoreWorld.parse(world)!!

        // 01 Sam calling from voi.ci (video offered): the full-screen incoming-call screen, Decline and Answer. The
        // call center holds a ringing call from the world; nothing rings, no network (VoiciCallCenter's state is
        // private, so the test sets it, and puts it back).
        launchStore("home", dark = false)
        waitText("cabin.river-otter.flagship.services", 20_000)
        scenario?.close()
        scenario = null
        val uiField = com.flagshipserver.app.calls.VoiciCallCenter::class.java.getDeclaredField("_ui").apply { isAccessible = true }
        @Suppress("UNCHECKED_CAST")
        val callUi = uiField.get(null) as kotlinx.coroutines.flow.MutableStateFlow<com.flagshipserver.app.calls.VoiciCallCenter.Ui>
        callUi.value = com.flagshipserver.app.calls.VoiciCallCenter.Ui(
            phase = com.flagshipserver.app.calls.VoiciCallCenter.Phase.Ringing, callId = "store-ring",
            name = store.ringingName(lang) ?: "Sam", video = store.calls?.ringing?.video == true,
        )
        try {
            val call = ActivityScenario.launch<com.flagshipserver.app.calls.VoiciCallActivity>(
                Intent(ctx, com.flagshipserver.app.calls.VoiciCallActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            )
            waitUntilExists("voici-call-answer", 20_000)
            waitUntilExists("voici-call-decline", 5_000)
            shot("01")
            call.close()
        } finally {
            callUi.value = com.flagshipserver.app.calls.VoiciCallCenter.Ui()
        }

        // 02 Social: the account's voi.ci page (its address under the title), Sam's conversation in the Inbox and the
        // calls button with its missed-call count, from the world's history.
        launchStore("messages", dark = true)
        waitUntilExists("social-title", 20_000)
        val center = com.flagshipserver.app.core.voici.VoiciCenter.shared!!
        kotlinx.coroutines.runBlocking { store.seedCalls(center, System.currentTimeMillis()) }
        tap("social-tab-inbox")
        waitUntilExists("social-call-button", 15_000)
        composeRule.waitUntil(15_000) { composeRule.onAllNodes(tagPrefix("messages-row-")).fetchSemanticsNodes().isNotEmpty() }
        shot("02")

        // 03 Home: both servers online, home the leader.
        launchStore("home", dark = false)
        waitText("cabin.river-otter.flagship.services", 20_000)
        // Add / Restore waits for Home's layout to settle before it takes taps: the shot shows it ready.
        composeRule.mainClock.advanceTimeBy(2_000)
        composeRule.onNode(hasTestTag("home-add-server")).assertIsEnabled()
        shot("03")

        // 04 Every app on both servers.
        launchStore("apps", dark = true)
        waitText(summary("budget"), 20_000)
        waitText(summary("chess-club"), 20_000)
        shot("04")

        // 05 Chess Club's Access control: Members only, its three members and their ranks. On the phone the page
        // (with 0.4's per-server list row) is taller than the screen at the run's density: this one slide draws a
        // little smaller, so Lea's row fits under Ana's and Kenji's.
        val phone = ctx.resources.configuration.smallestScreenWidthDp < 600
        val density = shell("wm density").let { Regex("""Override density: (\d+)""").find(it)?.groupValues?.get(1) }
        if (phone) { shell("wm density 330"); Thread.sleep(2_000); demoStatusBar() }
        launchStore("apps", dark = false)
        tapText(summary("chess-club"), 20_000)
        tap("service-detail-access-row", 20_000)
        waitUntilExists("service-access-members-title", 15_000)
        waitText("Lea", 15_000, substring = false)
        bring("service-access-restrict-toggle", 0.105f)
        shot("05")
        if (phone) { shell(if (density != null) "wm density $density" else "wm density reset"); Thread.sleep(2_000); demoStatusBar() }

        // 06 home's server page at Backups, each backup offering Restore into this server.
        launchStore("home", dark = true)
        tapText("home", 20_000)
        waitUntilExists("sd-backups-status", 20_000)
        bring("sd-backups", 0.11f)
        shot("06")
    }
}
