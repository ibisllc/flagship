// GYM Android instrumentation base (§10 Phase-5) — the on-device harness that
// launches MainActivity (the real app) on an emulator/device and drives it via
// Compose UI Test + Espresso, mirroring the iOS XCUITest GymSmokeTests /
// GymEveryMergeTests / GymTotalTests.
//
// Each test is ONE gym scenario. The deterministic verdict is the assertion
// (Layer 1, docs/ui-test-gym.md §2.1); a bitmap is captured at each named point
// (mirror of iOS gymShot) so the gym adapter can pull screenshots for the
// advisory judge — they never decide pass/fail.
//
// The launch SEAM mirrors iOS's `-smoke-mode` process arguments: we launch
// MainActivity with `flagship.smoke*` Intent extras (parsed in MainActivity ->
// SmokeMode, DEBUG-only) so the app skips onboarding, seeds DemoFixtures (no
// backend), lands on a tab, and optionally seeds an ops/trust/server-event
// state. Because we need to set extras on the launch Intent, we use an empty
// compose rule + an explicit ActivityScenario rather than
// createAndroidComposeRule<MainActivity>() (which launches with a bare intent).

package com.flagshipserver.app.gym

import android.app.Activity
import android.app.Instrumentation
import android.content.Intent
import android.graphics.Bitmap
import androidx.compose.ui.test.onAllNodesWithContentDescription
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.printToLog
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onFirst
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.performTextReplacement
import androidx.compose.ui.test.junit4.ComposeTestRule
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import androidx.test.platform.app.InstrumentationRegistry
import com.flagshipserver.app.MainActivity
import com.flagshipserver.app.core.SmokeModeConfig
import org.junit.After
import org.junit.Rule
import org.junit.rules.TestName
import java.io.File
import java.io.FileOutputStream

/**
 * Base for every gym instrumentation scenario. Subclasses call [launch] with a
 * tab + optional seed flags, then assert by testTag via [composeRule], and
 * capture screenshots via [gymShot].
 */
abstract class GymBase {

    /** Empty rule (no auto-launched activity) so we control the launch Intent. */
    @get:Rule(order = 0)
    val composeRule: ComposeTestRule = createEmptyComposeRule()

    @get:Rule(order = 1)
    val testName = TestName()

    /** A failing scenario leaves what the screen showed in the log (tag GYMTREE). */
    @get:Rule(order = 2)
    val dumpOnFailure = object : org.junit.rules.TestWatcher() {
        override fun failed(e: Throwable?, description: org.junit.runner.Description?) {
            android.util.Log.w("GYMTREE", "=== ${description?.methodName}: ${e?.message?.lineSequence()?.firstOrNull()}")
            dumpTree()
        }
        override fun finished(description: org.junit.runner.Description?) {
            runCatching { scenario?.close() }
            scenario = null
        }
    }

    private var scenario: ActivityScenario<MainActivity>? = null
    /** The directory the gym adapter pulls bitmaps from (cleared each scenario). */
    private val shotDir: File by lazy {
        File(
            ApplicationProvider.getApplicationContext<android.content.Context>().filesDir,
            GYM_SHOT_SUBDIR,
        ).also { it.mkdirs() }
    }

    /**
     * Launch MainActivity in smoke mode on [tab], optionally seeding the
     * operations sliver / an untrusted maintainer-trust verdict / a server-event
     * pod variant. Mirror of iOS GymEveryMergeTests.launch(tab:extra:).
     *
     * @param tab one of "home" | "apps" | "activity" | "settings"
     * @param ops seed one in-flight build so the operations sliver renders
     * @param trustUntrusted seed an untrusted verdict so the trust sliver renders
     * @param podsVariant "awaiting-unlock" | "dead" | "awaiting-backup" | null
     * @param accessAlert raise the app-wide access dialogs from the mock box
     * @param shares provide the in-memory share world (owner card, shared with me)
     * @param deviceRank this (non-admin) device's rank in the mock box's apps: "member" | "manager" | "master" | "refused"
     * @param backups the mock box's saved backups and policy: "empty" | "failed" | "unset" | "over" | "restore-partial"
     * @param onboarding start unpaired on Welcome (iOS `-smoke-onboarding`)
     * @param rateLimited `.com` endpoints the mock refuses with a 429 ("totp-verify", "watch-delegate")
     * @param chat the build chat the mock box serves: "env" (default) | "ready" | "failed"
     */
    protected fun launch(
        tab: String,
        ops: Boolean = false,
        trustUntrusted: Boolean = false,
        podsVariant: String? = null,
        adminRoot: Boolean = false,
        username: String? = null,
        accessAlert: Boolean = false,
        shares: Boolean = false,
        deviceRank: String? = null,
        live: Boolean = false,
        apexHost: String? = null,
        fakePasskeys: Boolean = false,
        realBiometrics: Boolean = false,
        refuseBiometrics: Boolean = false,
        persistSession: Boolean = false,
        /** An App Link to open at launch (e.g. a share link). */
        deepLink: String? = null,
        backups: String? = null,
        onboarding: Boolean = false,
        rateLimited: List<String> = emptyList(),
        chat: String? = null,
    ) {
        // A test may relaunch with different seeds (e.g. the admin/non-admin
        // state pair) — close the prior scenario so activities never stack.
        scenario?.close()
        val ctx = ApplicationProvider.getApplicationContext<android.content.Context>()
        val intent = Intent(ctx, MainActivity::class.java).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
            putExtra(SmokeModeConfig.EXTRA_SMOKE_MODE, true)
            putExtra(SmokeModeConfig.EXTRA_SMOKE_TAB, tab)
            if (ops) putExtra(SmokeModeConfig.EXTRA_SMOKE_OPS, true)
            if (trustUntrusted) putExtra(SmokeModeConfig.EXTRA_SMOKE_TRUST_UNTRUSTED, true)
            if (podsVariant != null) putExtra(SmokeModeConfig.EXTRA_SMOKE_PODS, podsVariant)
            if (adminRoot) putExtra(SmokeModeConfig.EXTRA_SMOKE_ADMIN_ROOT, true)
            if (username != null) putExtra(SmokeModeConfig.EXTRA_SMOKE_USERNAME, username)
            if (accessAlert) putExtra(SmokeModeConfig.EXTRA_SMOKE_ACCESS_ALERT, true)
            if (shares) putExtra(SmokeModeConfig.EXTRA_SMOKE_SHARES, true)
            if (deviceRank != null) putExtra(SmokeModeConfig.EXTRA_SMOKE_DEVICE_RANK, deviceRank)
            if (live) putExtra(SmokeModeConfig.EXTRA_SMOKE_LIVE, true)
            if (apexHost != null) putExtra("flagship.apexHost", apexHost)
            if (fakePasskeys) putExtra(SmokeModeConfig.EXTRA_SMOKE_FAKE_PASSKEYS, true)
            if (realBiometrics) putExtra(SmokeModeConfig.EXTRA_SMOKE_REAL_BIOMETRICS, true)
            if (refuseBiometrics) putExtra(SmokeModeConfig.EXTRA_SMOKE_REFUSE_BIOMETRICS, true)
            if (persistSession) putExtra(SmokeModeConfig.EXTRA_SMOKE_PERSIST_SESSION, true)
            if (deepLink != null) data = android.net.Uri.parse(deepLink)
            if (backups != null) putExtra(SmokeModeConfig.EXTRA_SMOKE_BACKUPS, backups)
            if (onboarding) putExtra(SmokeModeConfig.EXTRA_SMOKE_ONBOARDING, true)
            if (rateLimited.isNotEmpty()) putExtra(SmokeModeConfig.EXTRA_SMOKE_RATE_LIMITED, rateLimited.joinToString(","))
            if (chat != null) putExtra(SmokeModeConfig.EXTRA_SMOKE_CHAT, chat)
        }
        scenario = ActivityScenario.launch(intent)
        composeRule.waitForIdle()
    }

    /** Launch the app the way the launcher does, with no gym extras (a cold
     *  start of whatever the device holds), pointed at [apexHost]. */
    protected fun launchPlain(apexHost: String = "flagship.invalid") {
        scenario?.close()
        val ctx = ApplicationProvider.getApplicationContext<android.content.Context>()
        val intent = Intent(ctx, MainActivity::class.java).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
            putExtra("flagship.apexHost", apexHost)
        }
        scenario = ActivityScenario.launch(intent)
        composeRule.waitForIdle()
    }

    /** Recreate the activity (what Android does after a configuration change
     *  or when it reclaims a backgrounded app), keeping saved state. */
    protected fun recreateActivity() {
        scenario?.recreate()
        composeRule.waitForIdle()
    }

    // ─── Shared finders and waits (deterministic: each wait is bounded and
    //     returns as soon as its condition holds) ─────────────────────────────

    /** `!matcher`: nodes the matcher doesn't match. */
    protected operator fun androidx.compose.ui.test.SemanticsMatcher.not(): androidx.compose.ui.test.SemanticsMatcher {
        val m = this
        return androidx.compose.ui.test.SemanticsMatcher("not (${m.description})") { !m.matches(it) }
    }

    protected fun tagPrefix(prefix: String) = androidx.compose.ui.test.SemanticsMatcher("testTag starts with $prefix") {
        it.config.getOrNull(androidx.compose.ui.semantics.SemanticsProperties.TestTag)?.startsWith(prefix) == true
    }

    protected fun waitText(text: String, timeoutMs: Long = 10_000, substring: Boolean = true) {
        composeRule.waitUntil(timeoutMs) {
            composeRule.onAllNodes(androidx.compose.ui.test.hasText(text, substring = substring)).fetchSemanticsNodes().isNotEmpty()
        }
    }

    protected fun waitGone(tag: String, timeoutMs: Long = 10_000) {
        composeRule.waitUntil(timeoutMs) { composeRule.onAllNodesWithTag(tag).fetchSemanticsNodes().isEmpty() }
    }

    protected fun waitTextGone(text: String, timeoutMs: Long = 10_000) {
        composeRule.waitUntil(timeoutMs) {
            composeRule.onAllNodes(androidx.compose.ui.test.hasText(text, substring = true)).fetchSemanticsNodes().isEmpty()
        }
    }

    protected fun tagCount(tag: String, unmerged: Boolean = false) =
        composeRule.onAllNodesWithTag(tag, useUnmergedTree = unmerged).fetchSemanticsNodes().size

    protected fun descCount(desc: String) =
        composeRule.onAllNodesWithContentDescription(desc).fetchSemanticsNodes().size

    protected fun textCount(text: String, substring: Boolean = true) =
        composeRule.onAllNodes(androidx.compose.ui.test.hasText(text, substring = substring)).fetchSemanticsNodes().size

    /** Scroll a node into view when it sits in a scrolling container (a
     *  dialog's buttons don't). */
    protected fun androidx.compose.ui.test.SemanticsNodeInteraction.scrollIfNeeded(): androidx.compose.ui.test.SemanticsNodeInteraction =
        try {
            performScrollTo()
        } catch (e: AssertionError) {
            if (e.message?.contains("Scroll", ignoreCase = true) == true) this else throw e
        }

    /** Wait (bounded) for a node [m] matches to exist and be enabled, scrolling
     *  a lazy list to it when it isn't composed yet, then tap the first one. */
    protected fun tapMatching(m: androidx.compose.ui.test.SemanticsMatcher, timeoutMs: Long = 10_000) {
        val enabled = m and !androidx.compose.ui.test.SemanticsMatcher.keyIsDefined(androidx.compose.ui.semantics.SemanticsProperties.Disabled)
        try {
            composeRule.waitUntil(timeoutMs) {
                if (composeRule.onAllNodes(enabled).fetchSemanticsNodes().isNotEmpty()) return@waitUntil true
                // A lazy list composes only what's on screen: ask each to scroll to it.
                composeRule.onAllNodes(androidx.compose.ui.test.hasScrollToNodeAction()).fetchSemanticsNodes().indices.forEach { i ->
                    runCatching {
                        composeRule.onAllNodes(androidx.compose.ui.test.hasScrollToNodeAction())[i].performScrollToNode(m)
                    }
                }
                false
            }
        } catch (e: Throwable) {
            dumpTree()
            throw e
        }
        waitOutToasts()
        composeRule.onAllNodes(enabled).onFirst().scrollIfNeeded().performClick()
        composeRule.waitForIdle()
    }

    /** A toast floats over the bottom of the screen and takes touches; let it go
     *  before tapping what it may cover. */
    protected fun waitOutToasts(timeoutMs: Long = 12_000) {
        runCatching {
            composeRule.waitUntil(timeoutMs) { composeRule.onAllNodesWithTag("toast-row").fetchSemanticsNodes().isEmpty() }
        }
    }

    /** Scroll to a tagged node and tap it (once it's enabled). */
    protected fun tap(tag: String, timeoutMs: Long = 10_000) = tapMatching(hasTestTag(tag), timeoutMs)

    /** Tap a node whose content description is the gym handle. */
    protected fun tapDesc(desc: String, timeoutMs: Long = 10_000) =
        tapMatching(androidx.compose.ui.test.hasContentDescription(desc), timeoutMs)

    /** Tap the first node showing [text] (a button or row without a handle). */
    protected fun tapText(text: String, timeoutMs: Long = 10_000, substring: Boolean = false) {
        waitText(text, timeoutMs, substring)
        waitOutToasts()
        val node = composeRule.onAllNodes(androidx.compose.ui.test.hasText(text, substring = substring) and androidx.compose.ui.test.hasClickAction())
            .fetchSemanticsNodes().firstOrNull()
        if (node != null) {
            composeRule.onAllNodes(androidx.compose.ui.test.hasText(text, substring = substring) and androidx.compose.ui.test.hasClickAction())
                .onFirst().scrollIfNeeded().performClick()
        } else {
            composeRule.onAllNodes(androidx.compose.ui.test.hasText(text, substring = substring)).onFirst().scrollIfNeeded().performClick()
        }
        composeRule.waitForIdle()
    }

    /** Type into the text field tagged [tag] (or inside a wrapper tagged [tag]). */
    protected fun type(tag: String, text: String) {
        waitUntilExists(tag)
        composeRule.onNode(hasSetTextAction() and (hasTestTag(tag) or hasAnyAncestor(hasTestTag(tag))))
            .scrollIfNeeded().typeText(text)
    }

    /** Whether the soft keyboard is on screen (or still sliding in or out). */
    private fun keyboardShown(): Boolean {
        var shown = false
        scenario?.onActivity { a ->
            shown = androidx.core.view.ViewCompat.getRootWindowInsets(a.window.decorView)
                ?.isVisible(androidx.core.view.WindowInsetsCompat.Type.ime()) == true
        }
        return shown
    }

    /**
     * Put the soft keyboard away and wait until it is gone. Typing into a field
     * raises it over the bottom of the screen, where it covers (and takes the
     * touches meant for) the button the scenario taps next, and the page
     * resizes under it; on a busy machine the next tap lands before that has
     * settled. Every scenario types through [typeText] / [replaceText], which end here.
     */
    protected fun hideKeyboard() {
        composeRule.waitForIdle()
        if (!keyboardShown()) return
        runCatching { androidx.test.espresso.Espresso.closeSoftKeyboard() }
        composeRule.waitUntil(10_000) { !keyboardShown() }
        composeRule.waitForIdle()
    }

    /** Type [text] into this field, then put the keyboard away so the next tap reaches the page. */
    protected fun androidx.compose.ui.test.SemanticsNodeInteraction.typeText(text: String): androidx.compose.ui.test.SemanticsNodeInteraction {
        performTextInput(text)
        hideKeyboard()
        return this
    }

    /** Replace this field's text, then put the keyboard away. */
    protected fun androidx.compose.ui.test.SemanticsNodeInteraction.replaceText(text: String): androidx.compose.ui.test.SemanticsNodeInteraction {
        performTextReplacement(text)
        hideKeyboard()
        return this
    }

    /** The text a tagged node shows. */
    protected fun textOfTag(tag: String, unmerged: Boolean = false): String =
        composeRule.onAllNodesWithTag(tag, useUnmergedTree = unmerged).onFirst().fetchSemanticsNode().config
            .getOrNull(androidx.compose.ui.semantics.SemanticsProperties.Text)?.joinToString("") { it.text }.orEmpty()

    /** Wait (bounded) until [check] holds; for effects on the mocks. */
    protected fun eventually(timeoutMs: Long = 10_000, what: String = "condition", check: () -> Boolean) {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            // A frame, so continuations the test clock holds back (a mock's delay) run.
            composeRule.mainClock.advanceTimeByFrame()
            composeRule.waitForIdle()
            if (check()) return
            Thread.sleep(50)
        }
        if (!check()) {
            dumpTree()
            throw AssertionError("Timed out waiting for $what")
        }
    }

    /** On a failure: what the screen shows (texts, tags, descriptions) in the log, tag GYMTREE. */
    protected fun dumpTree() {
        runCatching {
            // Kept outside the app's data so a failed run leaves a picture to look at.
            InstrumentationRegistry.getInstrumentation().uiAutomation
                .executeShellCommand("screencap -p /data/local/tmp/gym-failure-${this::class.java.simpleName}.${testName.methodName}.png").close()
            Thread.sleep(800)
        }
        runCatching {
            composeRule.onAllNodes(androidx.compose.ui.test.SemanticsMatcher("any") { true }, useUnmergedTree = true)
                .fetchSemanticsNodes().forEach { n ->
                    val c = n.config
                    val text = c.getOrNull(androidx.compose.ui.semantics.SemanticsProperties.Text)?.joinToString("") { it.text }
                        ?: c.getOrNull(androidx.compose.ui.semantics.SemanticsProperties.EditableText)?.text?.let { "[edit:$it]" }
                    val tag = c.getOrNull(androidx.compose.ui.semantics.SemanticsProperties.TestTag)
                    val desc = c.getOrNull(androidx.compose.ui.semantics.SemanticsProperties.ContentDescription)?.joinToString("|")
                    val off = c.getOrNull(androidx.compose.ui.semantics.SemanticsProperties.Disabled) != null
                    val toggle = c.getOrNull(androidx.compose.ui.semantics.SemanticsProperties.ToggleableState)
                    if (text != null || tag != null || desc != null) {
                        android.util.Log.w("GYMTREE", "tag=$tag text=$text desc=$desc${if (off) " DISABLED" else ""}${if (toggle != null) " toggle=$toggle" else ""}")
                    }
                }
        }
    }

    /** The orders the mocks verified: "<what>:admin", "<what>:share" or "<what>:refused". */
    protected fun signedChecks(): List<String> = com.flagshipserver.app.api.MockSignatures.checks()

    protected fun assertSigned(what: String, by: String, timeoutMs: Long = 10_000) =
        eventually(timeoutMs, "$what signed with the $by key (saw ${signedChecks()}, verify=${com.flagshipserver.app.core.GymSeams.verifySignatures}, approvals=${runCatching { screensMock.archiveApprovals.size }.getOrNull()})") { "$what:$by" in signedChecks() }

    protected val screensMock get() = com.flagshipserver.app.core.GymProbe.screens!!
    protected val buildMock get() = com.flagshipserver.app.core.GymProbe.build!!
    protected val comMock get() = com.flagshipserver.app.core.GymProbe.flagship!!
    protected val mailboxMock get() = com.flagshipserver.app.core.GymProbe.mailbox!!

    // ─── System pickers and share sheets ─────────────────────────────────────
    //
    // A gym scenario never leaves the app: an Instrumentation monitor answers
    // the system document pickers and share sheets the app starts, the way
    // the user would, and records what each was asked for (the share text, the
    // file name to create) so a test can check the button's effect.

    /** Every outside activity the app tried to start, in order. */
    protected val startedIntents: MutableList<Intent> = java.util.Collections.synchronizedList(mutableListOf())

    /** Files the next document pick returns (OPEN_DOCUMENT / GET_CONTENT / OpenMultipleDocuments). */
    protected var pickedFiles: List<File> = emptyList()

    /** Where a CREATE_DOCUMENT save is written. */
    protected val savedDocument: File by lazy {
        File(ApplicationProvider.getApplicationContext<android.content.Context>().cacheDir, "gym-saved-document")
    }

    private val outsideMonitor = object : Instrumentation.ActivityMonitor() {
        override fun onStartActivity(intent: Intent): Instrumentation.ActivityResult? {
            // The app's own screens and the test runner's own activities are
            // explicit; pickers, share sheets and browsers aren't.
            if (intent.component != null) return null
            startedIntents += intent
            val result = Intent()
            when (intent.action) {
                Intent.ACTION_OPEN_DOCUMENT, Intent.ACTION_GET_CONTENT -> {
                    val uris = pickedFiles.map { android.net.Uri.fromFile(it) }
                    if (uris.isEmpty()) return Instrumentation.ActivityResult(Activity.RESULT_CANCELED, null)
                    result.data = uris.first()
                    if (uris.size > 1 || intent.getBooleanExtra(Intent.EXTRA_ALLOW_MULTIPLE, false)) {
                        val clip = android.content.ClipData.newRawUri("files", uris.first())
                        uris.drop(1).forEach { clip.addItem(android.content.ClipData.Item(it)) }
                        result.clipData = clip
                    }
                }
                Intent.ACTION_CREATE_DOCUMENT -> {
                    savedDocument.delete()
                    savedDocument.createNewFile()
                    result.data = android.net.Uri.fromFile(savedDocument)
                }
                else -> {} // share sheets, browsers, OPEN_DOCUMENT_TREE: answered, nothing chosen
            }
            return Instrumentation.ActivityResult(Activity.RESULT_OK, result)
        }
    }

    @org.junit.Before
    fun installOutsideMonitor() {
        InstrumentationRegistry.getInstrumentation().addMonitor(outsideMonitor)
    }

    @After
    fun removeOutsideMonitor() {
        InstrumentationRegistry.getInstrumentation().removeMonitor(outsideMonitor)
    }

    /** The text a share sheet was handed (the chooser's inner ACTION_SEND). */
    protected fun sharedTexts(): List<String> = startedIntents.mapNotNull { i ->
        val inner = if (i.action == Intent.ACTION_CHOOSER) {
            @Suppress("DEPRECATION")
            i.getParcelableExtra<Intent>(Intent.EXTRA_INTENT)
        } else {
            i
        }
        inner?.takeIf { it.action == Intent.ACTION_SEND }?.getStringExtra(Intent.EXTRA_TEXT)
    }

    /** The files a share sheet was handed (EXTRA_STREAM). */
    protected fun sharedStreams(): List<android.net.Uri> = startedIntents.mapNotNull { i ->
        val inner = if (i.action == Intent.ACTION_CHOOSER) {
            @Suppress("DEPRECATION")
            i.getParcelableExtra<Intent>(Intent.EXTRA_INTENT)
        } else {
            i
        }
        @Suppress("DEPRECATION")
        inner?.takeIf { it.action == Intent.ACTION_SEND }?.getParcelableExtra<android.net.Uri>(Intent.EXTRA_STREAM)
    }

    /** What the clipboard holds now. */
    protected fun clipboardText(): String {
        var out = ""
        InstrumentationRegistry.getInstrumentation().runOnMainSync {
            val cm = ApplicationProvider.getApplicationContext<android.content.Context>()
                .getSystemService(android.content.Context.CLIPBOARD_SERVICE) as android.content.ClipboardManager
            out = cm.primaryClip?.takeIf { it.itemCount > 0 }?.getItemAt(0)?.text?.toString().orEmpty()
        }
        return out
    }

    /** Home → a server's page by its name (the demo fixtures' summary line). */
    protected fun openServerFromHome(name: String) {
        waitText(name, 20_000)
        composeRule.onAllNodes(androidx.compose.ui.test.hasText(name) and androidx.compose.ui.test.hasClickAction()).onFirst()
            .scrollIfNeeded().performClick()
        composeRule.waitForIdle()
    }

    /** Services → the demo Plants app's page. */
    protected fun openPlantsFromServices() {
        waitText("Houseplant watering tracker", 20_000)
        composeRule.onNodeWithText("Houseplant watering tracker").performClick()
        composeRule.waitForIdle()
    }

    /**
     * Wait until a node with [tag] is present in the composition (bounded). For
     * state- or nav-driven appearances that `waitForIdle()` doesn't catch — a
     * Flow emission (the ops seed), nav-settle (a tab switch / NavHost push), or
     * an AnimatedVisibility enter. Throwing on timeout IS the deterministic
     * assertion (these are real "did the screen render after the action" checks).
     */
    protected fun waitUntilExists(tag: String, timeoutMs: Long = 10_000) {
        composeRule.waitUntil(timeoutMillis = timeoutMs) {
            composeRule.onAllNodesWithTag(tag).fetchSemanticsNodes().isNotEmpty()
        }
    }

    /** Twin of [waitUntilExists] for controls exposed via
     *  `Modifier.semantics { contentDescription = … }` (the app's parity-handle
     *  idiom on several Slice-D / transfer / approval controls) rather than a
     *  testTag. */
    protected fun waitUntilExistsDesc(desc: String, timeoutMs: Long = 10_000) {
        composeRule.waitUntil(timeoutMillis = timeoutMs) {
            composeRule.onAllNodesWithContentDescription(desc).fetchSemanticsNodes().isNotEmpty()
        }
    }

    /** Home's "Add/Restore server" asks which; pick "Create a server". */
    protected fun addNewServer() {
        tap("home-add-server")
        waitUntilExists("home-add-new-server")
        composeRule.onNodeWithTag("home-add-new-server").performClick()
        composeRule.waitForIdle()
    }

    /** Create-server step 1 (name) → Next → step 2 (boot unlock + encryption). */
    protected fun nameServerAndNext(name: String = "gymbox") {
        waitUntilExists("cs-name-field")
        // The tag sits on the field's wrapper; type into the text input inside it.
        // The field starts prefilled ("home"): replace it.
        composeRule.onNode(hasSetTextAction() and hasAnyAncestor(hasTestTag("cs-name-field")))
            .replaceText(name)
        composeRule.onNodeWithTag("cs-next-button").performScrollTo().performClick()
        composeRule.waitForIdle()
    }


    /**
     * Capture a screenshot of the current screen and write it under the gym's
     * shot dir as `gym-screenshot-<Class>.<method>--<point>-<n>.png` — the name
     * shape the gym's Android adapter scrapes off the device (the test name lets
     * it hand each shot to its scenario when the whole suite runs as one batch). Mirror of iOS gymShot. A capture
     * failure is swallowed (it must never change the verdict).
     */
    protected fun gymShot(point: String) {
        try {
            val instr: Instrumentation = InstrumentationRegistry.getInstrumentation()
            val safePoint = point.replace(Regex("[^A-Za-z0-9_.-]"), "-")
            val bitmap: Bitmap = instr.uiAutomation.takeScreenshot() ?: return
            val n = shotCounter++
            val test = "${this::class.java.simpleName}.${testName.methodName}"
            val file = File(shotDir, "gym-screenshot-$test--$safePoint-$n.png")
            FileOutputStream(file).use { out ->
                bitmap.compress(Bitmap.CompressFormat.PNG, 100, out)
            }
            bitmap.recycle()
        } catch (_: Throwable) {
            // Best-effort: a missing screenshot never affects pass/fail.
        }
    }

    companion object {
        /** Where on-device bitmaps land; the adapter pulls these off via adb. */
        const val GYM_SHOT_SUBDIR = "gym-shots"
        private var shotCounter = 0
    }
}
