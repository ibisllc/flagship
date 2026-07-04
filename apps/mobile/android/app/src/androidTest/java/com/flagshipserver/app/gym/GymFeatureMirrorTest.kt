// GYM Android feature-coverage mirrors (Tier-1, NO-BACKEND) — the Android twins
// of the webapp feature tranche (web-total-transfer-offer / -box-inbox /
// -pod-switcher / -cs-advanced-toggles / -admin-root-state /
// -rotate-admin-ceremony / -promote-admin-toggle) and of the iOS
// GymFeatureMirrorTests. Same discipline: DemoFixtures + the mock client, the
// deterministic verdict is the assertion, screenshots advisory; danger controls
// are asserted at their CONFIRM stage only (no transfer created, no rotation
// fired — Cancel, no device admitted).
//
// Several of these controls carry their parity handle as a semantics
// contentDescription (not a testTag) — matched via
// onNodeWithContentDescription, see GymBase.waitUntilExistsDesc.
//
// NOT mirrored: the acquirer take-over claim (web-total-transfer-claim) — on
// mobile it is deep-link/QR-only (no in-app entry) and needs a REAL signed
// offer to pass verify; a signed-offer fixture seam is disproportionate for a
// render assert.

package com.flagshipserver.app.gym

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsOff
import androidx.compose.ui.test.assertIsOn
import androidx.compose.ui.test.onAllNodesWithContentDescription
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import org.junit.Assert.assertTrue
import org.junit.Test

class GymFeatureMirrorTest : GymBase() {

    /** Open the seeded "Home" pod's server-detail by tapping its unique
     *  description line (the pod NAME text would collide with the bottom tab). */
    private fun openHomePodDetail() {
        launch(tab = "home")
        composeRule.onNodeWithText("Living-room mini-PC")
            .performScrollTo()
            .performClick()
        composeRule.waitForIdle()
    }

    // ─── D1 — transfer-a-box giver entry ─────────────────────────────────────

    /** Server-detail's transfer entry opens the giver ceremony: the
     *  type-the-FQDN confirm field + the danger CTA. Confirm stage only —
     *  nothing typed, nothing signed. */
    @Test
    fun transferOfferEntryOpensCeremony() {
        openHomePodDetail()
        waitUntilExistsDesc("sd-transfer-server", timeoutMs = 15_000)
        gymShot("transfer-entry")
        composeRule.onNodeWithContentDescription("sd-transfer-server")
            .performScrollTo()
            .performClick()
        composeRule.waitForIdle()
        waitUntilExists("transfer-confirm-field", timeoutMs = 15_000)
        composeRule.onNodeWithContentDescription("transfer-start").assertExists()
        gymShot("transfer-confirm-gate")
    }

    // ─── D5 — box-request inbox approve card ─────────────────────────────────

    /** A box awaiting boot-unlock (the Cabin seed) surfaces the one-tap
     *  Approve/Deny card on its detail — driven by the directory's cheap
     *  awaitingUnlock flag, no backend. Approve is never tapped. */
    @Test
    fun boxInboxApproveCard() {
        launch(tab = "home", podsVariant = "awaiting-unlock")
        composeRule.onNodeWithText("Cabin mini-PC, just rebooted")
            .performScrollTo()
            .performClick()
        composeRule.waitForIdle()
        waitUntilExistsDesc("sd-approve-unlock", timeoutMs = 15_000)
        composeRule.onNodeWithContentDescription("sd-deny-unlock").assertExists()
        gymShot("inbox-approve-card")
    }

    // ─── D5 — multi-pod switcher ─────────────────────────────────────────────

    /** The Services tab renders the PodSwitcher (3 seeded pods); opening it
     *  lists the per-pod items. */
    @Test
    fun podSwitcherOpensMenu() {
        launch(tab = "apps")
        waitUntilExists("pod-switcher", timeoutMs = 15_000)
        gymShot("pod-switcher")
        composeRule.onNodeWithTag("pod-switcher").performClick()
        composeRule.waitForIdle()
        // Item tags carry the (random-suffixed) podId — wait for ANY of them.
        composeRule.waitUntil(timeoutMillis = 10_000) {
            composeRule.onAllNodesWithTag("pod-switcher", useUnmergedTree = true)
                .fetchSemanticsNodes().isNotEmpty() &&
                anyPodSwitcherItem()
        }
        assertTrue("The switcher menu should list the seeded pods.", anyPodSwitcherItem())
        gymShot("pod-switcher-menu")
    }

    private fun anyPodSwitcherItem(): Boolean =
        composeRule.onAllNodes(
            androidx.compose.ui.test.SemanticsMatcher("testTag startsWith pod-switcher-item-") { node ->
                val tag = node.config.getOrElseNullable(
                    androidx.compose.ui.semantics.SemanticsProperties.TestTag,
                ) { null }
                tag?.startsWith("pod-switcher-item-") == true
            },
            useUnmergedTree = true,
        ).fetchSemanticsNodes().isNotEmpty()

    // ─── D4 — create-server Advanced toggles ─────────────────────────────────

    /** The Advanced section defaults OFF with its embed-secrets +
     *  debug-friendly toggles hidden; opening reveals both (default OFF);
     *  closing Advanced RESETS an armed debug-friendly (a debug/secret choice
     *  can never stay silently armed). */
    @Test
    fun createServerAdvancedTogglesResetRule() {
        launch(tab = "home")
        composeRule.onNodeWithTag("home-add-server").performScrollTo().performClick()
        composeRule.waitForIdle()
        waitUntilExists("cs-advanced-toggle", timeoutMs = 15_000)
        val advanced = composeRule.onNodeWithTag("cs-advanced-toggle")
        advanced.performScrollTo().assertIsOff()
        composeRule.onAllNodesWithTag("cs-debug-friendly-toggle").fetchSemanticsNodes().let {
            assertTrue("debug-friendly must be hidden while Advanced is off", it.isEmpty())
        }
        advanced.performClick()
        composeRule.waitForIdle()
        waitUntilExists("cs-debug-friendly-toggle")
        composeRule.onNodeWithTag("cs-embed-secrets-toggle").performScrollTo().assertIsOff()
        val debug = composeRule.onNodeWithTag("cs-debug-friendly-toggle")
        debug.performScrollTo().assertIsOff()
        gymShot("cs-advanced-open")

        debug.performClick()
        composeRule.waitForIdle()
        debug.assertIsOn()
        advanced.performScrollTo().performClick()   // close — hides + resets
        composeRule.waitForIdle()
        advanced.performClick()                      // reopen
        composeRule.waitForIdle()
        waitUntilExists("cs-debug-friendly-toggle")
        composeRule.onNodeWithTag("cs-debug-friendly-toggle").performScrollTo().assertIsOff()
        gymShot("cs-advanced-reset")
    }

    // ─── D3 — admin-root state on Account security ───────────────────────────

    /** Account security reports THIS device's admin standing honestly: the
     *  demo default (no admin master root) shows NO rotate card; the
     *  smokeAdminRoot seed renders the Admin-key card + Rotate. */
    @Test
    fun adminRootStateGatesRotateCard() {
        // Non-admin half.
        launch(tab = "settings")
        openAccountSecurity()
        composeRule.onAllNodesWithContentDescription("admin-root-rotate-btn")
            .fetchSemanticsNodes().let {
                assertTrue("A non-admin device must NOT offer Rotate-admin", it.isEmpty())
            }
        gymShot("admin-root-non-admin")

        // Admin half.
        launch(tab = "settings", adminRoot = true)
        openAccountSecurity()
        waitUntilExistsDesc("admin-root-rotate-btn", timeoutMs = 15_000)
        composeRule.onNodeWithContentDescription("admin-root-rotate-btn")
            .performScrollTo().assertIsDisplayed()
        gymShot("admin-root-admin")
    }

    // ─── D4 — rotate-admin ceremony first screen ─────────────────────────────

    /** Rotate-admin opens its warning dialog (revoke semantic + typed-ROTATE
     *  gate); Cancel rotates nothing and lands back on the intact card. */
    @Test
    fun rotateAdminCeremonyFirstScreen() {
        launch(tab = "settings", adminRoot = true)
        openAccountSecurity()
        waitUntilExistsDesc("admin-root-rotate-btn", timeoutMs = 15_000)
        composeRule.onNodeWithContentDescription("admin-root-rotate-btn")
            .performScrollTo().performClick()
        composeRule.waitForIdle()
        composeRule.onNodeWithText("Rotate admin key?").assertIsDisplayed()
        waitUntilExistsDesc("admin-root-rotate-confirm-field")
        gymShot("rotate-admin-ceremony")
        composeRule.onNodeWithText("Cancel").performClick()
        composeRule.waitForIdle()
        composeRule.onNodeWithContentDescription("admin-root-rotate-btn").assertExists()
        composeRule.onAllNodesWithContentDescription("admin-root-rotate-done")
            .fetchSemanticsNodes().let {
                assertTrue("Cancel must not have rotated anything", it.isEmpty())
            }
        gymShot("rotate-admin-cancelled")
    }

    // NOTE — promote-to-admin (web-total-promote-admin-toggle) is NOT mirrored
    // on Android: the toggle renders only at the ConfirmSas stage, which needs
    // a live peer hello; the in-composable MockDevicePairingRelay has no
    // instrumentation seam to script one (awaitPeerHello errors without it) —
    // disproportionate fixture surgery for a render assert. iOS mirrors it
    // (its promote card renders from the pre-peer waitingForDevice stage).

    // ─── shared navigation ────────────────────────────────────────────────────

    private fun openAccountSecurity() {
        waitUntilExists("settings-open-account-security", timeoutMs = 15_000)
        composeRule.onNodeWithTag("settings-open-account-security")
            .performScrollTo().performClick()
        composeRule.waitForIdle()
        // Open once the mock-served account-type action renders (the row's own
        // label also says "Account security", so a bare text match is ambiguous).
        composeRule.waitUntil(timeoutMillis = 15_000) {
            composeRule.onAllNodesWithContentDescription("account-security-enable-btn")
                .fetchSemanticsNodes().isNotEmpty() ||
                composeRule.onAllNodesWithContentDescription("account-security-disable-btn")
                    .fetchSemanticsNodes().isNotEmpty()
        }
    }

}
