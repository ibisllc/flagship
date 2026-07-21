// Phase 2 (login redesign) — pin the decoupling of account creation
// from server provisioning on Android.
//
// Two contracts:
//   1. OPEN ACCOUNT (OpenAccountViewModel): picking a username opens the
//      ACCOUNT — a STANDALONE username claim (exactly once) + onboarding
//      completed with ZERO pods so Home lands on the empty state. The
//      device name is recorded on the active profile. Idempotent on
//      retry (a re-tapped open from the same device key claims once).
//   2. ADD A SERVER (registerControlPlane): adding a server from Home —
//      1st or Nth — must NOT re-claim the username. The claim was
//      already done at open-account time; registerControlPlane only
//      publishes the RCK + auth-code.
//
// Mirror of the iOS open-account step + the claim extraction from
// CreateServerViewModel. See docs/login-and-account-redesign.md.

package com.flagshipserver.app.viewmodels

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import com.flagshipserver.app.api.MockFlagshipServerClient
import com.flagshipserver.app.api.UsernameClaimRequest
import com.flagshipserver.app.core.AppState
import com.flagshipserver.app.core.InstallBlobBundle
import com.flagshipserver.app.core.WireAuthCode
import com.flagshipserver.app.core.WireBlob
import com.flagshipserver.app.keystore.Keystore
import com.flagshipserver.app.ui.screens.registerControlPlane
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class OpenAccountFlowTest {

    @Before
    fun setUp() {
        // Robolectric has no hardware AndroidKeyStore; bind a plain
        // in-memory SharedPreferences via the Keystore test seam so the
        // UMK seed + IRK derivation run exactly as in production.
        val ctx = ApplicationProvider.getApplicationContext<Context>()
        Keystore.attachForTest(ctx.getSharedPreferences("open-account-test", Context.MODE_PRIVATE))
        Keystore.wipe()
    }

    @After
    fun tearDown() {
        Keystore.wipe()
    }

    private fun newVm(server: MockFlagshipServerClient, app: AppState, username: String) =
        OpenAccountViewModel(
            server = server,
            app = app,
            username = username,
            // StrongBox is unavailable on the JVM path — skip the
            // hardware key gen; the seed + claim are what's load-bearing.
            ensureHardwareUmk = {},
        )

    // ─── 1. OPEN ACCOUNT ────────────────────────────────────────────

    @Test fun openAccount_claimsStandalone_andOpensWithZeroPods() = runTest {
        val server = MockFlagshipServerClient(simulatedLatencyMs = 0)
        val app = AppState()
        val vm = newVm(server, app, "harry")

        vm.openAccount("Harry's Pixel")

        // The account opened.
        assertEquals(OpenAccountPhase.Opened, vm.phase.first())
        assertTrue("open-account must pair", app.isPaired.first())
        assertEquals("harry", app.currentUser.first())
        // ZERO servers — Home lands on the "add your first server" state.
        assertTrue("account opens with no servers", app.pods.first().isEmpty())

        // The STANDALONE username claim fired exactly once, for this user.
        assertEquals(1, server.claimedUsernames.size)
        assertTrue(server.claimedUsernames.containsKey("harry"))
        // No server-side artefacts — no RCK, no auth-code yet (a server
        // is a separate, later step).
        assertTrue(server.registeredRcks.isEmpty())
        assertTrue(server.issuedAuthCodes.isEmpty())
    }

    @Test fun openAccount_armsSecureAccountNudge() = runTest {
        // The CREATE path arms the SKIPPABLE "Secure your account" backup
        // step (rendered by AppRoot as an overlay above the shell).
        val server = MockFlagshipServerClient(simulatedLatencyMs = 0)
        val app = AppState()
        assertFalse(app.pendingSecureAccountNudge.first())

        newVm(server, app, "harry").openAccount("Harry's Pixel")

        assertTrue("opening a new account must arm the backup nudge", app.pendingSecureAccountNudge.first())
    }

    @Test fun openAccount_doesNotArmNudge_whenClaimFails() = runTest {
        val server = MockFlagshipServerClient(simulatedLatencyMs = 0, shouldFail = true)
        val app = AppState()
        newVm(server, app, "harry").openAccount("Harry's Pixel")
        // A failed open doesn't pair, so it must not strand a nudge over
        // a non-existent shell.
        assertFalse(app.isPaired.first())
        assertFalse(app.pendingSecureAccountNudge.first())
    }

    @Test fun openAccount_recordsDeviceName_onActiveProfile() = runTest {
        val server = MockFlagshipServerClient(simulatedLatencyMs = 0)
        val app = AppState()
        val vm = newVm(server, app, "harry")

        vm.openAccount("Harry's Pixel")

        val profile = app.activeProfile
        assertNotNull("the active profile is recorded", profile)
        assertEquals("harry", profile?.cloudName)
        assertEquals("Harry's Pixel", profile?.deviceDisplayName)
    }

    @Test fun openAccount_blankName_fallsBackToUsernamesPhone() = runTest {
        val server = MockFlagshipServerClient(simulatedLatencyMs = 0)
        val app = AppState()
        val vm = newVm(server, app, "harry")

        vm.openAccount("   ")

        assertEquals(OpenAccountPhase.Opened, vm.phase.first())
        assertEquals("harry's phone", app.activeProfile?.deviceDisplayName)
    }

    @Test fun defaultDeviceName_prefersModel_thenFallsBack() {
        val vm = newVm(MockFlagshipServerClient(simulatedLatencyMs = 0), AppState(), "harry")
        assertEquals("Pixel 8", vm.defaultDeviceName("Pixel 8"))
        assertEquals("harry's phone", vm.defaultDeviceName(null))
        assertEquals("harry's phone", vm.defaultDeviceName("  "))
    }

    @Test fun openAccount_retry_claimsOnlyOnce() = runTest {
        val server = MockFlagshipServerClient(simulatedLatencyMs = 0)
        val app = AppState()
        val vm = newVm(server, app, "harry")

        // Two opens from the same device key (same UMK seed ⇒ same IRK
        // pub) — claimUsername is idempotent for an unchanged irkPub.
        vm.openAccount("Harry's Pixel")
        vm.openAccount("Harry's Pixel")

        assertEquals(OpenAccountPhase.Opened, vm.phase.first())
        assertEquals(1, server.claimedUsernames.size)
        assertTrue(app.pods.first().isEmpty())
    }

    @Test fun openAccount_serverFailure_surfacesFailedState_andDoesNotPair() = runTest {
        val server = MockFlagshipServerClient(simulatedLatencyMs = 0, shouldFail = true)
        val app = AppState()
        val vm = newVm(server, app, "harry")

        vm.openAccount("Harry's Pixel")

        val phase = vm.phase.first()
        assertTrue("expected Failed, got $phase", phase is OpenAccountPhase.Failed)
        assertFalse("a failed claim must not pair the account", app.isPaired.first())
    }

    // ─── 2. ADD A SERVER does NOT re-claim ──────────────────────────

    @Test fun addServer_afterOpenAccount_doesNotReClaim() = runTest {
        val server = MockFlagshipServerClient(simulatedLatencyMs = 0)
        val app = AppState()

        // Open the account first (the only place the username is claimed).
        newVm(server, app, "harry").openAccount("Harry's Pixel")
        assertEquals(1, server.claimedUsernames.size)

        // Now add a server from Home — registerControlPlane publishes the
        // RCK + auth-code only; it must NOT touch claimUsername.
        registerControlPlane(
            flagshipServer = server,
            bundle = sampleBundle(username = "harry", serverName = "home"),
            authCodeUserSig = "00".repeat(64),
        )

        // Still exactly ONE claim — the add-server path didn't re-claim.
        assertEquals(1, server.claimedUsernames.size)
        // But the server-side artefacts for the new server DID publish.
        assertEquals(1, server.registeredRcks.size)
        assertEquals(1, server.issuedAuthCodes.size)
    }

    @Test fun addingSecondServer_stillDoesNotReClaim() = runTest {
        val server = MockFlagshipServerClient(simulatedLatencyMs = 0)
        val app = AppState()
        newVm(server, app, "harry").openAccount("Harry's Pixel")

        registerControlPlane(server, sampleBundle("harry", "home", serial = "S1"), "00".repeat(64))
        registerControlPlane(server, sampleBundle("harry", "work", serial = "S2"), "00".repeat(64))

        assertEquals("claim happens once regardless of server count", 1, server.claimedUsernames.size)
        assertEquals(2, server.issuedAuthCodes.size)
    }

    // ─── helpers ────────────────────────────────────────────────────

    private fun sampleBundle(
        username: String,
        serverName: String,
        serial: String = "S0",
    ): InstallBlobBundle {
        val domain = "$serverName.$username.flagship.services"
        val hex32 = "ab".repeat(32)
        return InstallBlobBundle(
            blob = WireBlob(
                serverDomain = domain,
                username = username,
                serverName = serverName,
                phoneDelegatedPubKey = hex32,
                authCode = WireAuthCode(
                    serial = serial,
                    username = username,
                    serverName = serverName,
                    serverDomain = domain,
                    delegatedPubKey = hex32,
                    userPubKey = hex32,
                    issuedAt = 0L,
                    expiresAt = 1L,
                ),
                authCodeUserSignature = "00".repeat(64),
                rckPubKey = hex32,
            ),
            blobSignature = "00".repeat(64),
        )
    }
}
