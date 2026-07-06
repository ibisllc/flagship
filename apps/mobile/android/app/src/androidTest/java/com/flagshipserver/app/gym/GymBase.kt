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
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.junit4.ComposeTestRule
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import androidx.test.platform.app.InstrumentationRegistry
import com.flagshipserver.app.MainActivity
import com.flagshipserver.app.core.SmokeModeConfig
import org.junit.After
import org.junit.Rule
import java.io.File
import java.io.FileOutputStream

/**
 * Base for every gym instrumentation scenario. Subclasses call [launch] with a
 * tab + optional seed flags, then assert by testTag via [composeRule], and
 * capture screenshots via [gymShot].
 */
abstract class GymBase {

    /** Empty rule (no auto-launched activity) so we control the launch Intent. */
    @get:Rule
    val composeRule: ComposeTestRule = createEmptyComposeRule()

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
     * @param podsVariant "awaiting-unlock" | "dead" | null
     */
    protected fun launch(
        tab: String,
        ops: Boolean = false,
        trustUntrusted: Boolean = false,
        podsVariant: String? = null,
        adminRoot: Boolean = false,
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
        }
        scenario = ActivityScenario.launch(intent)
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

    @After
    fun tearDownScenario() {
        scenario?.close()
        scenario = null
    }

    /**
     * Capture a screenshot of the current screen and write it under the gym's
     * shot dir as `gym-screenshot-<point>-<n>.png` — the name shape the gym's
     * Android adapter scrapes off the device. Mirror of iOS gymShot. A capture
     * failure is swallowed (it must never change the verdict).
     */
    protected fun gymShot(point: String) {
        try {
            val instr: Instrumentation = InstrumentationRegistry.getInstrumentation()
            val safePoint = point.replace(Regex("[^A-Za-z0-9_.-]"), "-")
            val bitmap: Bitmap = instr.uiAutomation.takeScreenshot() ?: return
            val n = shotCounter++
            val file = File(shotDir, "gym-screenshot-$safePoint-$n.png")
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
