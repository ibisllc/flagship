// Store screenshots (docs/store-assets/capture-plan.md): the real app over the made-up world in
// store/demo-world.json, one language per run, light and dark by the slide's place in the strip,
// written to files/store/<id>.png (01-06 and 08: call, Home, Social's calls, Apps, Access, Backups, build chat; the
// watch's 07/07b/07c come from the wear module). Opt-in: skipped
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
import androidx.compose.ui.test.hasAnyDescendant
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
    private companion object {
        /** Tablets (320 dpi in the run) draw Social and Access control up to this density: the same page, a size larger.
         *  Never so far that the short side drops under 600 dp: the app would take the phone's layout (and turn the
         *  screen upright), so the 7" (1200 px) stays at 320 and only the 10" (1600 px) gets it. */
        const val TABLET_ZOOM_DPI = 400
        /** How far down the screen the tablet art (1920 x 1200, 2560 x 1600) shows: its device runs off the bottom. */
        const val TABLET_ART_BOTTOM = 0.86f
    }

    private val args = InstrumentationRegistry.getArguments()
    private val world = args.getString("storeWorld")?.let { String(android.util.Base64.decode(it, android.util.Base64.DEFAULT)) }
    private val lang = args.getString("storeLang") ?: "en"
    /** `-e storeOnly 05,08`: only these slides (a retake after a change to one screen). */
    private val only = args.getString("storeOnly")?.takeIf { it.isNotBlank() }?.split(",")?.toSet()
    private fun want(id: String) = only?.contains(id) ?: true
    private val ctx get() = ApplicationProvider.getApplicationContext<android.content.Context>()
    private val out by lazy { File(ctx.filesDir, "store").also { it.deleteRecursively(); it.mkdirs() } }
    private var scenario: ActivityScenario<MainActivity>? = null

    private fun launchStore(tab: String, dark: Boolean, waiting: Boolean = false, link: String? = null) {
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
            // A link the app opens as it would from a push (slide 08's chat).
            if (link != null) data = android.net.Uri.parse(link)
        }
        scenario = ActivityScenario.launch(intent)
        composeRule.waitForIdle()
    }

    private fun shot(id: String, close: Boolean = true) {
        // The test's clock drives the app's own delays (Home's Add button waits for its layout to settle).
        composeRule.mainClock.advanceTimeBy(2_000)
        composeRule.waitForIdle()
        Thread.sleep(1_000)
        val bitmap: Bitmap = InstrumentationRegistry.getInstrumentation().uiAutomation.takeScreenshot()
        FileOutputStream(File(out, "$id.png")).use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        bitmap.recycle()
        if (!close) return
        scenario?.close()
        scenario = null
    }

    /** The tablets: the run's landscape sizes. */
    private val tablet get() = ctx.resources.displayMetrics.let { it.widthPixels > it.heightPixels }

    /** The density a tablet draws Social and Access control at (see [TABLET_ZOOM_DPI]). */
    private val zoomDpi get() = ctx.resources.displayMetrics.let { minOf(TABLET_ZOOM_DPI, minOf(it.widthPixels, it.heightPixels) * 160 / 600) }

    /** A display density for the next launch, the status bar put back in demo mode after it. */
    private fun setDensity(dpi: Int, reset: Boolean = false) {
        shell(if (reset) "wm density reset" else "wm density $dpi")
        Thread.sleep(2_000)
        demoStatusBar()
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
        // Wi-Fi at full strength, fully = connected with internet (without it the icon carries the "!" of a network with
        // none); no cell icon (the emulator's shows "3G", and twice, one per SIM slot).
        demo("network -e airplane hide -e nosim hide -e mobile hide")
        demo("network -e wifi show -e level 4 -e fully true")
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
        val store = com.flagshipserver.app.core.StoreWorld.parse(world)!!
        // demo mode set afresh here: as the script leaves it, the status bar can carry a second Wi-Fi icon
        demoStatusBar()
        // The apps' summaries as the capture language shows them (the world's summaryByLang).
        val summary = { slug: String -> store.apps.first { it.slug == slug }.summary(lang) }
        val base = shell("wm density").let { Regex("""Override density: (\d+)""").find(it)?.groupValues?.get(1) }
        val baseDpi = base?.toIntOrNull() ?: ctx.resources.displayMetrics.densityDpi

        if (want("01")) {
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
        }
        if (want("02")) {
            // 02 Home: both servers online, home the leader.
            launchStore("home", dark = true)
            waitText("cabin.river-otter.flagship.services", 20_000)
            // Add / Restore waits for Home's layout to settle before it takes taps: the shot shows it ready.
            composeRule.mainClock.advanceTimeBy(2_000)
            composeRule.onNode(hasTestTag("home-add-server")).assertIsEnabled()
            shot("02")
        }
        if (want("03")) {
            // 03 Social: the Inbox with every conversation and the calls button with its missed count (kept as
            // x03-inbox.png), then the calls button's Calls page: missed, video and audio calls under the owner's
            // nicknames (03.png). Tablets draw it a size larger: the page is a column in the middle of the screen.
            if (tablet && zoomDpi > baseDpi) setDensity(zoomDpi)
            launchStore("messages", dark = false)
            waitUntilExists("social-title", 20_000)
            val center = com.flagshipserver.app.core.voici.VoiciCenter.shared!!
            kotlinx.coroutines.runBlocking { store.seedCalls(center, System.currentTimeMillis()) }
            tap("social-tab-inbox")
            waitUntilExists("social-call-button", 15_000)
            composeRule.waitUntil(15_000) { composeRule.onAllNodes(tagPrefix("messages-row-")).fetchSemanticsNodes().size >= 4 }
            shot("x03-inbox", close = false)
            tap("social-call-button")
            waitUntilExists("calls-title", 15_000)
            shot("03")
        }
        if (want("04")) {
            // 04 Every app on both servers, each with its own voi.ci link.
            if (tablet && zoomDpi > baseDpi) setDensity(baseDpi)
            launchStore("apps", dark = true)
            waitText(summary("budget"), 20_000)
            waitText(summary("chess-club"), 20_000)
            shot("04")
        }
        if (want("05")) {
            // 05 Chess Club's Access control: the Members only switch and all three members with their ranks. Phone: 0.4's
            // per-server list row makes the page taller than the screen at the run's density: scroll as far as the switch
            // allows, and where that is not enough draw this one slide a little smaller (a lower density; the Play phone
            // art then shows this slide's whole phone, store/store.json `fit`). Tablets: the page is far taller than a
            // landscape screen, so the switch and the members never fit together at a readable size (0.4 drew them
            // tiny): the members and their ranks at the run's density, Lea's row ending where the art's crop does. What
            // each try measured goes to x05-fit.txt beside the shots.
            val lea = "service-access-remove-inv-lea"
            val fitLog = StringBuilder()
            var dpi = baseDpi
            var changed = false
            for (attempt in 0..7) {
                launchStore("apps", dark = false)
                tapText(summary("chess-club"), 20_000)
                tap("service-detail-access-row", 20_000)
                waitUntilExists("service-access-members-title", 15_000)
                waitText("Lea", 15_000, substring = false)
                val h = composeRule.onRoot().fetchSemanticsNode().size.height.toFloat()
                // Unclipped: boundsInRoot is empty for a node scrolled out of view.
                val leaBottom = { composeRule.onNode(hasTestTag(lea)).fetchSemanticsNode().let { it.positionInRoot.y + it.size.height } }
                // The page's own scroller (the first scrollable node can be the navigation rail's).
                val page = composeRule.onNode(hasScrollAction() and hasAnyDescendant(hasTestTag(lea)))
                if (tablet) {
                    val delta = leaBottom() + h * 0.02f - h * TABLET_ART_BOTTOM
                    if (delta > 0) page.performSemanticsAction(SemanticsActions.ScrollBy) { it(0f, delta) }
                    composeRule.waitForIdle()
                    fitLog.append("tablet dpi=$dpi h=$h scrolled=$delta lea=${leaBottom()}\n")
                    break
                }
                bring("service-access-restrict-toggle", 0.105f)
                val toggle = composeRule.onNode(hasTestTag("service-access-restrict-toggle")).fetchSemanticsNode().boundsInRoot
                // Above the bottom navigation bar.
                val tab = composeRule.onAllNodes(hasTestTag("tab-apps")).fetchSemanticsNodes().firstOrNull()?.boundsInRoot
                val visibleBottom = tab?.top?.takeIf { it > h / 2 } ?: (h * 0.96f)
                val overflow = leaBottom() + h * 0.025f - visibleBottom
                val allowed = toggle.height * 0.5f
                fitLog.append("attempt=$attempt dpi=$dpi h=$h lea=${leaBottom()} visible=$visibleBottom overflow=$overflow allowed=$allowed\n")
                if (overflow <= allowed || attempt == 7) {
                    if (overflow > 0) {
                        // Never past half the switch: it stays in the shot.
                        page.performSemanticsAction(SemanticsActions.ScrollBy) { it(0f, minOf(overflow, allowed)) }
                        composeRule.waitForIdle()
                    }
                    break
                }
                dpi = (dpi * 0.92f).toInt()
                setDensity(dpi)
                changed = true
            }
            File(out, "x05-fit.txt").writeText(fitLog.toString())
            shot("05")
            if (changed) setDensity(baseDpi, reset = base == null)
        }
        if (want("06")) {
            // 06 home's server page at Backups, each backup offering Restore into this server.
            launchStore("home", dark = true)
            tapText("home", 20_000)
            waitUntilExists("sd-backups-status", 20_000)
            bring("sd-backups", 0.11f)
            shot("06")
        }
        if (want("08")) {
            // 08 The build chat: the owner described an app, the AI built it on home; ready to deploy.
            launchStore("apps", dark = true, link = "flagship://vibecode/${store.build!!.sessionId}")
            waitUntilExists("vibecode-continue-field", 30_000)
            // the Deploy button in view (the chat opens a little above its end)
            runCatching { composeRule.onNode(hasTestTag("vibecode-deploy-btn")).performScrollTo() }
            composeRule.waitForIdle()
            shot("08")
        }
    }
}
