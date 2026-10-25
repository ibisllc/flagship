// GYM Android: 0.3 screens for passkey recovery (SEC-REPAIR-001), browser access beyond a
// manifest (SEC-BROWSER-002) and syncing an imported app with its upstream (N12).
//   Recovery: set-up sends the passkey's attestation; a record from before the check raises
//   "Update your account recovery" once (Not now is final), and Update with the passphrase
//   re-enrols with one passkey sheet; Settings keeps a quiet Update row.
//   Browser: a waiting ask raises a dialog with the verified app, the exact sites and how long;
//   Allow is an admin-signed flagship/browser-grant/v1 labelled by the ask's duration, Deny is
//   unsigned; the same asks wait under Activity and on the app's page.
//   Sync: the app page's "Check for updates from <repo>" shows the proposal with the new
//   permissions apart and hands the build to the deploy step; an up-to-date answer discards it.
// NO BACKEND: the mock box and `.com` check each signature and the passkey check as the real ones do.

package com.flagshipserver.app.gym

import androidx.compose.ui.test.performTextReplacement
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class GymPasskeyBrowserSyncTest : GymBase() {

    private val flagshipMock get() = com.flagshipserver.app.core.GymProbe.flagship!!
    private val user get() = com.flagshipserver.app.core.GymProbe.appState!!.currentUser.value!!
    private val passphrase = "a whole sentence I will remember"

    /** Google Block Store outlives the app's data: a copy from an earlier run reads as "Configured". */
    private fun forgetBlockStoreCopy() {
        val ctx = androidx.test.core.app.ApplicationProvider.getApplicationContext<android.content.Context>()
        kotlinx.coroutines.runBlocking { runCatching { com.flagshipserver.app.keystore.BlockStoreUmkStore(ctx).delete() } }
    }

    @org.junit.After
    fun leaveNoRecoveryCopy() = forgetBlockStoreCopy()

    private fun recheckRecovery() {
        composeRule.runOnIdle { com.flagshipserver.app.core.RecoveryUpdateOffer.recheck() }
    }

    // ---- Passkey recovery ------------------------------------------------

    @Test
    fun recoverySetUpSendsThePasskeysAttestation() {
        forgetBlockStoreCopy()
        launch(tab = "settings", adminRoot = true, fakePasskeys = true)
        waitUntilExists("settings-title")
        tapText("Cloud recovery", 20_000)
        tap("recovery-setup", 20_000)
        waitText("Longer is stronger and there is no upper limit", 10_000)
        gymShot("recovery-passphrase-hint")
        val fields = composeRule.onAllNodes(androidx.compose.ui.test.hasSetTextAction())
        fields[0].typeText(passphrase)
        fields[1].typeText(passphrase)
        tapText("Configure")
        waitUntilExists("recovery-active", 30_000)
        assertEquals(1, flagshipMock.recoveryAttestations.size)
        eventually(10_000, "the record holds the passkey's key") {
            kotlinx.coroutines.runBlocking { flagshipMock.recoveryRecordState(user)?.passkeyRequired == true }
        }
    }

    @Test
    fun recoveryUpdateIsOfferedOnceAndNotNowIsFinal() {
        launch(tab = "home", adminRoot = true, fakePasskeys = true)
        flagshipMock.seedLegacyRecovery(user, passphrase)
        recheckRecovery()
        waitUntilExists("recovery-update", 20_000)
        assertEquals("Update your account recovery", textOfTag("recovery-update-title"))
        assertTrue(textOfTag("recovery-update-body").startsWith("Account recovery can now also check your passkey"))
        gymShot("recovery-update-prompt")
        tap("recovery-update-not-now")
        waitGone("recovery-update")
        recheckRecovery()
        Thread.sleep(1_500)
        assertEquals(0, composeRule.onAllNodes(androidx.compose.ui.test.hasTestTag("recovery-update")).fetchSemanticsNodes().size)
        // Declined: nothing changed, and Settings keeps a quiet row.
        assertTrue(flagshipMock.recoveryAttestations.isEmpty())
        tap("tab-settings", 15_000)
        tapText("Cloud recovery", 20_000)
        waitUntilExists("recovery-update-row", 20_000)
        gymShot("recovery-update-row")
    }

    @Test
    fun recoveryUpdateWithThePassphraseReEnrolsWithThePasskey() {
        launch(tab = "home", adminRoot = true, fakePasskeys = true)
        flagshipMock.seedLegacyRecovery(user, passphrase)
        recheckRecovery()
        waitUntilExists("recovery-update", 20_000)
        // A wrong passphrase is refused before anything is replaced.
        type("recovery-update-passphrase", "not the passphrase at all")
        tap("recovery-update-confirm")
        waitUntilExists("recovery-update-error", 30_000)
        assertEquals("That passphrase didn't match.", textOfTag("recovery-update-error"))
        gymShot("recovery-update-wrong-passphrase")
        assertTrue(flagshipMock.recoveryAttestations.isEmpty())
        composeRule.onNode(
            androidx.compose.ui.test.hasSetTextAction() and androidx.compose.ui.test.hasAnyAncestor(androidx.compose.ui.test.hasTestTag("recovery-update-passphrase")),
        ).performTextReplacement(passphrase)
        tap("recovery-update-confirm")
        waitGone("recovery-update", 40_000)
        waitText("Account recovery updated.", 10_000)
        assertEquals(1, flagshipMock.recoveryAttestations.size)
        assertTrue(kotlinx.coroutines.runBlocking { flagshipMock.recoveryRecordState(user)!!.passkeyRequired })
    }

    // ---- Browser access beyond the manifest ------------------------------

    private fun seedBrowserAndPush() {
        screensMock.seedBrowserGrants()
        composeRule.runOnIdle { com.flagshipserver.app.core.AccessRequestBridge.onAccessRequest?.invoke() }
        waitUntilExists("browser-grant", 15_000)
    }

    @Test
    fun browserGrantAllowOnceFromTheDialogDenyFromActivity() {
        launch(tab = "activity", adminRoot = true)
        seedBrowserAndPush()
        assertEquals("Browser access request", textOfTag("browser-grant-title"))
        val plants = "6b7c0f1e-1111-4a2b-9c3d-000000000001"
        assertEquals("Plants wants to use this server's browser.", textOfTag("browser-grant-wants-$plants"))
        assertEquals("radar.weather.example", textOfTag("browser-grant-site-$plants"))
        assertEquals("For one visit", textOfTag("browser-grant-duration-$plants"))
        assertEquals("Allow once", textOfTag("browser-grant-allow"))
        gymShot("browser-grant-dialog")
        tap("browser-grant-allow")
        waitText("Browser access allowed", 15_000)
        tap("browser-grant-close")
        waitUntilExists("browser-grant", 15_000)
        assertEquals("Always allow", textOfTag("browser-grant-allow"))
        tap("browser-grant-not-now")
        waitGone("browser-grant")

        tap("activity-section-browser", 15_000)
        val wiki = "6b7c0f1e-2222-4a2b-9c3d-000000000002"
        waitUntilExists("browser-grant-card-$wiki")
        assertEquals("These devices on your network: 192.168.1.40", textOfTag("browser-grant-lan-$wiki"))
        gymShot("browser-grant-activity")
        tap("browser-grant-card-deny-$wiki")
        waitGone("browser-grant-card-$wiki", 15_000)

        assertEquals(listOf("allow" to plants, "deny" to wiki), screensMock.browserGrantAnswers.map { it.decision to it.requestId })
        assertNull(screensMock.browserGrantAnswers[1].signature)
        assertSigned("browser-grant", "admin")
        assertTrue("browser-grant:refused" !in signedChecks())
    }

    @Test
    fun browserGrantOnTheAppsPage() {
        launch(tab = "apps", adminRoot = true)
        screensMock.seedBrowserGrants()
        openPlantsFromServices()
        val plants = "6b7c0f1e-1111-4a2b-9c3d-000000000001"
        waitUntilExists("service-detail-browser-access", 20_000)
        waitUntilExists("browser-grant-card-$plants", 20_000)
        assertEquals(0, composeRule.onAllNodes(androidx.compose.ui.test.hasTestTag("browser-grant-card-6b7c0f1e-2222-4a2b-9c3d-000000000002")).fetchSemanticsNodes().size)
        gymShot("browser-grant-app-page")
        tap("browser-grant-card-allow-$plants")
        waitGone("browser-grant-card-$plants", 15_000)
        assertEquals("allow", screensMock.browserGrantAnswers.single().decision)
        assertSigned("browser-grant", "admin")
    }

    // ---- Sync an imported app with its upstream --------------------------

    private val plantsId = "bright-maple--plants"

    @Test
    fun syncShowsTheProposalThenDeploysTheBuildThatHoldsIt() {
        launch(tab = "apps", adminRoot = true)
        screensMock.importedFromFixture = mapOf(plantsId to "https://github.com/gym/plants")
        openPlantsFromServices()
        waitUntilExists("service-detail-sync", 20_000)
        waitText("Check for updates from https://github.com/gym/plants", 10_000)
        tap("service-detail-sync")
        type("app-sync-ref", "v2")
        tap("app-sync-check")
        waitUntilExists("app-sync-proposal", 20_000)
        assertEquals(listOf(plantsId to "v2"), buildMock.syncCalls)
        assertEquals("Version 4f2a9c0e1b7d", textOfTag("app-sync-version"))
        assertEquals("Internet access", textOfTag("app-sync-capability"))
        assertEquals("1 conflict: your version was kept", textOfTag("app-sync-conflicts-title"))
        gymShot("app-sync-proposal")
        tap("app-sync-review")
        waitUntilExists("build-journal-holds-update", 20_000)
        tap("build-journal-deploy")
        eventually(20_000, "the build that holds the merge was deployed") { buildMock.deployCalls == listOf("bld-sync-0001") }
        assertTrue("the opened build is never discarded on the way to deploy", buildMock.discardCalls.isEmpty())
    }

    @Test
    fun syncUpToDateDiscardsTheOpenedBuild() {
        launch(tab = "apps", adminRoot = true)
        screensMock.importedFromFixture = mapOf(plantsId to "https://github.com/gym/plants")
        buildMock.syncFixture = com.flagshipserver.app.api.BuildSyncResponse(
            buildId = "bld-same", proposal = com.flagshipserver.app.api.SyncProposal(clean = true), candidateCommit = "abc", upToDate = true,
        )
        openPlantsFromServices()
        tap("service-detail-sync", 20_000)
        tap("app-sync-check")
        waitUntilExists("app-sync-up-to-date", 20_000)
        assertEquals("You already run the latest version from https://github.com/gym/plants.", textOfTag("app-sync-up-to-date"))
        gymShot("app-sync-up-to-date")
        tap("app-sync-close")
        eventually(10_000, "the build was discarded") { buildMock.discardCalls == listOf("bld-same") }
        assertTrue(buildMock.deployCalls.isEmpty())
    }

    @Test
    fun syncIsNotOfferedForAnAppNotImported() {
        launch(tab = "apps", adminRoot = true)
        openPlantsFromServices()
        waitUntilExists("service-detail-edit", 20_000)
        gymShot("app-sync-not-offered")
        assertFalse(composeRule.onAllNodes(androidx.compose.ui.test.hasTestTag("service-detail-sync")).fetchSemanticsNodes().isNotEmpty())
    }
}
