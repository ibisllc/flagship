// Phase 3 (login redesign) — pin the REAL single/multi login state
// machine on Android. Mock WebAuthn only (the live CredentialManager
// wrapper is a separate human/device task).
//
// Contracts (mirror docs/login-and-account-redesign.md "The unified
// login decision tree" + the iOS LoginViewModel tests):
//
//   1. recovery.present == false → a STATE (NoCloudBackup), never an
//      error: single vs multi flagged so the host renders distinct copy.
//      The account does NOT open.
//   2. single (recovery.present) → PRF unwrap → TakeoverReady(7d) → on
//      confirm: installUmk(recovered seed) + re-pair initiated (NO
//      totpProof) + device labelled "admin" + onboarding completed with
//      the RESOLVED username + ZERO pods.
//   3. multi (recovery.present, totpEnrolled) → PRF unwrap →
//      AwaitingSecondFactor → re-pair MUST NOT fire before the second
//      factor → on factor + confirm: re-pair carries totpProof
//      (method tags totp vs recovery) + same install/admin/onboard.
//
// installUmk is asserted by reading the Keystore UMK seed back after the
// takeover; re-pair correctness by inspecting mock.lastRePairInitiate.

package com.flagshipserver.app.viewmodels

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import com.flagshipserver.app.api.AccountResolution
import com.flagshipserver.app.api.MockFlagshipServerClient
import com.flagshipserver.app.api.RecoveryEnvelopeRequest
import com.flagshipserver.app.core.AppState
import com.flagshipserver.app.core.HexUtil
import com.flagshipserver.app.keystore.Keystore
import com.flagshipserver.app.keystore.MockWebAuthnProvider
import com.flagshipserver.app.keystore.Recovery
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class LoginFlowTest {

    private val credentialId = "ab".repeat(32)        // hex-shaped Mock cred
    private val recoveredSeed = ByteArray(32) { (it + 1).toByte() }

    @Before
    fun setUp() {
        val ctx = ApplicationProvider.getApplicationContext<Context>()
        Keystore.attachForTest(ctx.getSharedPreferences("login-flow-test", Context.MODE_PRIVATE))
        Keystore.wipe()
    }

    @After
    fun tearDown() {
        Keystore.wipe()
    }

    private val webauthn = MockWebAuthnProvider()

    /** Seed a Mock recovery envelope wrapped under the deterministic
     *  Mock PRF secret for [credentialId], so the VM's PRF unwrap
     *  recovers exactly [recoveredSeed]. */
    private suspend fun seedRecoveryEnvelope(server: MockFlagshipServerClient) {
        val prfSecret = webauthn.prfAssert(credentialId)
        val sealed = Recovery.wrap(recoveredSeed, prfSecret)
        server.registerRecoveryEnvelope(
            RecoveryEnvelopeRequest(
                credentialId = credentialId,
                wrappedUmkBase64 = sealed.ciphertextBase64,
                nonceBase64 = sealed.nonceBase64,
            ),
        )
    }

    private fun resolution(
        username: String,
        kind: String,
        recoveryPresent: Boolean,
        totpEnrolled: Boolean = false,
        grace: String = if (kind == "multi") "24h-totp" else "7d",
    ) = AccountResolution(
        username = username,
        exists = true,
        kind = kind,
        recovery = AccountResolution.RecoveryState(
            present = recoveryPresent,
            hasFetchGate = false,
            credentialId = if (recoveryPresent) credentialId else null,
        ),
        totpEnrolled = totpEnrolled,
        trustedDeviceCount = 0,
        graceModel = grace,
    )

    private fun vm(res: AccountResolution, server: MockFlagshipServerClient, app: AppState) =
        LoginViewModel(
            resolution = res,
            server = server,
            app = app,
            webauthn = webauthn,
            now = { 1_000L },
        )

    // ─── 1. recovery.present == false → STATE, not error ──────────────

    @Test fun begin_singleNoCloudBackup_rendersStateAndDoesNotOpen() = runTest {
        val server = MockFlagshipServerClient(simulatedLatencyMs = 0)
        val app = AppState()
        val m = vm(resolution("harry", "single", recoveryPresent = false), server, app)

        m.begin()

        assertEquals(LoginPhase.NoCloudBackup(single = true), m.phase.first())
        assertFalse("no-backup must not open the account", app.isPaired.first())
        assertNull(server.lastRePairInitiate)
    }

    @Test fun begin_multiNoCloudBackup_flagsMultiCopy() = runTest {
        val server = MockFlagshipServerClient(simulatedLatencyMs = 0)
        val app = AppState()
        val m = vm(resolution("hilton", "multi", recoveryPresent = false, totpEnrolled = true), server, app)

        m.begin()

        assertEquals(LoginPhase.NoCloudBackup(single = false), m.phase.first())
        assertFalse(app.isPaired.first())
    }

    // ─── 2. single takeover ───────────────────────────────────────────

    @Test fun single_unwrap_landsOnTakeoverReady7d() = runTest {
        val server = MockFlagshipServerClient(simulatedLatencyMs = 0)
        seedRecoveryEnvelope(server)
        val app = AppState()
        val m = vm(resolution("harry", "single", recoveryPresent = true), server, app)

        m.begin()

        assertEquals(
            LoginPhase.TakeoverReady(AccountResolution.GraceModel.SevenDay),
            m.phase.first(),
        )
        // Nothing committed yet — the user can still back out.
        assertNull(server.lastRePairInitiate)
        assertFalse(app.isPaired.first())
    }

    @Test fun single_confirmTakeover_installsUmk_initiatesRePair_labelsAdmin() = runTest {
        val server = MockFlagshipServerClient(simulatedLatencyMs = 0)
        seedRecoveryEnvelope(server)
        val app = AppState()
        val m = vm(resolution("harry", "single", recoveryPresent = true), server, app)

        m.begin()
        m.confirmTakeover()

        assertEquals(LoginPhase.Opened, m.phase.first())

        // installUmk: the recovered seed is now this device's UMK.
        assertArrayEquals(recoveredSeed, Keystore.currentUmkSeed())

        // Onboarding completed with the RESOLVED username + ZERO pods —
        // NOT the legacy "recovered-user" placeholder.
        assertTrue(app.isPaired.first())
        assertEquals("harry", app.currentUser.first())
        assertTrue(app.pods.first().isEmpty())

        // This device is labelled "admin".
        assertEquals(ADMIN_DEVICE_LABEL, app.activeProfile?.deviceLabel)

        // Re-pair initiated for the resolved user, signed by the NEW IRK,
        // with NO totpProof (single is single-factor).
        val (user, body, _) = server.lastRePairInitiate!!
        assertEquals("harry", user)
        assertEquals("harry", body.request.username)
        assertNull("single takeover carries no totpProof", body.totpProof)
        // Signature verifies under the body's newIrkPub.
        assertTrue(verifyRePair(body))
        // A pending rotation is staged for the Phase-4 completion step.
        assertNotNull(Keystore.pendingIrkRotationVersion())
    }

    // ─── 3. multi takeover requires the second factor ─────────────────

    @Test fun multi_unwrap_gatesOnSecondFactor_beforeRePair() = runTest {
        val server = MockFlagshipServerClient(simulatedLatencyMs = 0)
        seedRecoveryEnvelope(server)
        val app = AppState()
        val m = vm(resolution("hilton", "multi", recoveryPresent = true, totpEnrolled = true), server, app)

        m.begin()

        // The passkey unwrapped, but the Worker requires a second factor
        // first — we must NOT have initiated re-pair yet.
        assertEquals(LoginPhase.AwaitingSecondFactor, m.phase.first())
        assertNull("multi must collect TOTP/recovery code BEFORE re-pair", server.lastRePairInitiate)
        assertFalse(app.isPaired.first())
    }

    @Test fun multi_confirmWithoutFactor_bouncesBackToAwaiting() = runTest {
        val server = MockFlagshipServerClient(simulatedLatencyMs = 0)
        seedRecoveryEnvelope(server)
        val app = AppState()
        val m = vm(resolution("hilton", "multi", recoveryPresent = true, totpEnrolled = true), server, app)

        m.begin()
        // Defensive: a confirm with no factor staged must not re-pair.
        m.confirmTakeover()

        assertEquals(LoginPhase.AwaitingSecondFactor, m.phase.first())
        assertNull(server.lastRePairInitiate)
        assertFalse(app.isPaired.first())
    }

    @Test fun multi_totpProof_carriesTotpMethod_andCompletesTakeover() = runTest {
        val server = MockFlagshipServerClient(simulatedLatencyMs = 0)
        seedRecoveryEnvelope(server)
        val app = AppState()
        val m = vm(resolution("hilton", "multi", recoveryPresent = true, totpEnrolled = true), server, app)

        m.begin()
        m.submitSecondFactor("123456", isRecoveryCode = false)
        assertEquals(
            LoginPhase.TakeoverReady(AccountResolution.GraceModel.TwentyFourHourTotp),
            m.phase.first(),
        )
        m.confirmTakeover()

        assertEquals(LoginPhase.Opened, m.phase.first())
        assertArrayEquals(recoveredSeed, Keystore.currentUmkSeed())
        assertEquals("hilton", app.currentUser.first())
        assertEquals(ADMIN_DEVICE_LABEL, app.activeProfile?.deviceLabel)

        val (_, body, _) = server.lastRePairInitiate!!
        assertNotNull("multi takeover MUST carry totpProof", body.totpProof)
        assertEquals("123456", body.totpProof?.code)
        assertEquals("totp", body.totpProof?.method)
        assertTrue(verifyRePair(body))
    }

    @Test fun multi_recoveryCode_tagsRecoveryMethod() = runTest {
        val server = MockFlagshipServerClient(simulatedLatencyMs = 0)
        seedRecoveryEnvelope(server)
        val app = AppState()
        val m = vm(resolution("hilton", "multi", recoveryPresent = true, totpEnrolled = true), server, app)

        m.begin()
        m.submitSecondFactor("AAAA-BBBB", isRecoveryCode = true)
        m.confirmTakeover()

        val (_, body, _) = server.lastRePairInitiate!!
        assertEquals("AAAA-BBBB", body.totpProof?.code)
        assertEquals("recovery", body.totpProof?.method)
    }

    @Test fun multi_emptyFactor_surfacesError_andDoesNotAdvance() = runTest {
        val server = MockFlagshipServerClient(simulatedLatencyMs = 0)
        seedRecoveryEnvelope(server)
        val app = AppState()
        val m = vm(resolution("hilton", "multi", recoveryPresent = true, totpEnrolled = true), server, app)

        m.begin()
        m.submitSecondFactor("   ", isRecoveryCode = false)

        assertTrue(m.phase.first() is LoginPhase.Failed)
        assertNull(server.lastRePairInitiate)
    }

    // ─── helper: re-pair signature verification ───────────────────────

    /** Verify the NEW IRK signed the re-pair canonical bytes. Mirrors
     *  the Worker's verifyRePairInitiate (signature checked against the
     *  body's newIrkPub). */
    private fun verifyRePair(body: com.flagshipserver.app.api.RePairInitiateRequest): Boolean {
        val canonical = com.flagshipserver.app.core.RePairInitiateClaim.canonicalBytes(
            username = body.request.username,
            newIrkPubHex = body.request.newIrkPub,
            oldIrkPubHex = body.request.oldIrkPub,
            issuedAt = body.request.issuedAt,
        )
        val verifier = com.google.crypto.tink.subtle.Ed25519Verify(
            HexUtil.decode(body.request.newIrkPub)!!,
        )
        return try {
            verifier.verify(HexUtil.decode(body.signature)!!, canonical)
            true
        } catch (t: Throwable) {
            false
        }
    }
}
