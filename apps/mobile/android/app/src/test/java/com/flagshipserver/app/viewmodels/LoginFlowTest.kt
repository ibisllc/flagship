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
import com.flagshipserver.app.core.AcmeAccountKey
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

    private companion object {
        const val GATED_PASSPHRASE = "correct horse battery staple"
    }

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
        val wrapped = Recovery.wrap(recoveredSeed, prfSecret)
        server.registerRecoveryEnvelope(
            RecoveryEnvelopeRequest(
                request = RecoveryEnvelopeRequest.Inner(
                    username = "demo",
                    credentialId = credentialId,
                    wrappedUmk = wrapped,
                    issuedAt = 0L,
                ),
                signature = "00",
            ),
        )
    }

    /** Seed an envelope that ALSO escrows an ACME account key (#28),
     *  wrapped under the same Mock PRF secret. Returns the raw scalar so
     *  the caller can assert it's restored into the Keystore. */
    private suspend fun seedRecoveryEnvelopeWithAcme(server: MockFlagshipServerClient): ByteArray {
        val prfSecret = webauthn.prfAssert(credentialId)
        val wrapped = Recovery.wrap(recoveredSeed, prfSecret)
        val acmeScalar = AcmeAccountKey.generateScalar()
        server.registerRecoveryEnvelope(
            RecoveryEnvelopeRequest(
                request = RecoveryEnvelopeRequest.Inner(
                    username = "demo",
                    credentialId = credentialId,
                    wrappedUmk = wrapped,
                    issuedAt = 0L,
                    wrappedAcmeAccountKey = AcmeAccountKey.wrapForEscrow(acmeScalar, prfSecret),
                ),
                signature = "00",
            ),
        )
        return acmeScalar
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

    // ─── 1b. passphrase-gated takeover (Task #74) ─────────────────────

    /** Enroll a passphrase-gated record through the shared ceremony so the
     *  Mock stores the fetchToken / prfSalt gate hashes; the passkey
     *  ceremony folds the prfSalt into the secret exactly like
     *  MockWebAuthnProvider.prfAssertWithSalt, so the restore round-trips. */
    private suspend fun enrollGated(server: MockFlagshipServerClient, username: String) {
        val ceremony = object : com.flagshipserver.app.keystore.CloudRecoveryEnrollment.PasskeyCeremony {
            override suspend fun create(username: String, prfEvalInput: ByteArray) =
                credentialId to webauthn.prfAssertWithSalt(credentialId, prfEvalInput)
            override suspend fun assert(credentialId: String, prfEvalInput: ByteArray) =
                webauthn.prfAssertWithSalt(credentialId, prfEvalInput)
        }
        com.flagshipserver.app.keystore.CloudRecoveryEnrollment.enroll(
            server = server,
            passkeys = ceremony,
            irk = com.google.crypto.tink.subtle.Ed25519Sign(ByteArray(32) { 0x03 }),
            username = username,
            umkSeed = recoveredSeed,
            passphrase = GATED_PASSPHRASE,
            passphraseConfirm = GATED_PASSPHRASE,
            acmeScalar = null,
            now = 1_000L,
        )
    }

    private fun gatedResolution(username: String, kind: String) = AccountResolution(
        username = username,
        exists = true,
        kind = kind,
        recovery = AccountResolution.RecoveryState(
            present = true,
            hasFetchGate = true,
            credentialId = credentialId,
        ),
        totpEnrolled = kind == "multi",
        trustedDeviceCount = 0,
        graceModel = if (kind == "multi") "24h-totp" else "7d",
    )

    @Test fun begin_gatedRecord_awaitsPassphrase_doesNotFetch() = runTest {
        val server = MockFlagshipServerClient(simulatedLatencyMs = 0)
        enrollGated(server, "harry")
        val m = vm(gatedResolution("harry", "single"), server, AppState())

        m.begin()

        assertEquals(LoginPhase.AwaitingPassphrase(single = true), m.phase.first())
    }

    @Test fun gated_correctPassphrase_unwraps_landsOnTakeoverReady() = runTest {
        val server = MockFlagshipServerClient(simulatedLatencyMs = 0)
        enrollGated(server, "harry")
        val app = AppState()
        val m = vm(gatedResolution("harry", "single"), server, app)

        m.begin()
        m.submitPassphrase(GATED_PASSPHRASE)

        assertEquals(
            LoginPhase.TakeoverReady(AccountResolution.GraceModel.SevenDay),
            m.phase.first(),
        )
        assertNull("nothing committed before confirm", server.lastRePairInitiate)
        assertFalse(app.isPaired.first())
    }

    @Test fun gated_wrongPassphrase_failsAtGate() = runTest {
        val server = MockFlagshipServerClient(simulatedLatencyMs = 0)
        enrollGated(server, "harry")
        val m = vm(gatedResolution("harry", "single"), server, AppState())

        m.begin()
        m.submitPassphrase("the wrong passphrase entirely")

        assertTrue(m.phase.first() is LoginPhase.Failed)
    }

    @Test fun gated_multi_unwraps_thenGatesOnSecondFactor() = runTest {
        val server = MockFlagshipServerClient(simulatedLatencyMs = 0)
        enrollGated(server, "hilton")
        val m = vm(gatedResolution("hilton", "multi"), server, AppState())

        m.begin()
        assertEquals(LoginPhase.AwaitingPassphrase(single = false), m.phase.first())
        m.submitPassphrase(GATED_PASSPHRASE)

        // Multi must still collect the second factor BEFORE re-pair.
        assertEquals(LoginPhase.AwaitingSecondFactor, m.phase.first())
        assertNull(server.lastRePairInitiate)
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

    @Test fun single_confirm_initiates_thenComplete_pairsAndLabelsAdmin() = runTest {
        val server = MockFlagshipServerClient(simulatedLatencyMs = 0)
        seedRecoveryEnvelope(server)
        val app = AppState()
        val m = vm(resolution("harry", "single", recoveryPresent = true), server, app)

        m.begin()
        m.confirmTakeover()

        // Phase 4: confirm INITIATES + installs UMK + stages the rotation,
        // but does NOT pair — the grace clock is running server-side.
        assertTrue("confirm lands on Grace", m.phase.first() is LoginPhase.Grace)
        assertArrayEquals(recoveredSeed, Keystore.currentUmkSeed())
        assertFalse("not paired during grace", app.isPaired.first())
        val (user, body, _) = server.lastRePairInitiate!!
        assertEquals("harry", user)
        assertEquals("harry", body.request.username)
        assertNull("single takeover carries no totpProof", body.totpProof)
        assertTrue(verifyRePair(body))
        assertNotNull("pending rotation staged for completion", Keystore.pendingIrkRotationVersion())

        // Phase 4: completeTakeover finalizes — pairs, labels admin,
        // activates the staged IRK rotation (pending → current).
        m.completeTakeover()
        assertEquals(LoginPhase.Opened, m.phase.first())
        assertTrue(app.isPaired.first())
        assertEquals("harry", app.currentUser.first())
        assertTrue(app.pods.first().isEmpty())
        assertEquals(ADMIN_DEVICE_LABEL, app.activeProfile?.deviceLabel)
        assertNull("pending rotation cleared after completion", Keystore.pendingIrkRotationVersion())
    }

    // #28 — a takeover from an envelope that escrowed the ACME account key
    // restores BOTH the UMK and the account-key scalar into the recovered
    // profile's Keystore slot. confirmTakeover switches to the "harry"
    // profile (setActiveProfile) before installing, so the scalar lands
    // there.
    @Test fun single_confirm_restoresEscrowedAcmeAccountKey() = runTest {
        val server = MockFlagshipServerClient(simulatedLatencyMs = 0)
        val escrowedScalar = seedRecoveryEnvelopeWithAcme(server)
        val app = AppState()
        val m = vm(resolution("harry", "single", recoveryPresent = true), server, app)

        m.begin()
        // No account key on this fresh device before the takeover.
        Keystore.setActiveProfile("harry")
        assertFalse(Keystore.hasAcmeAccountKey())
        Keystore.setActiveProfile(null)

        m.confirmTakeover()

        // UMK restored + the ACME account key restored into the active
        // (recovered) profile.
        assertArrayEquals(recoveredSeed, Keystore.currentUmkSeed())
        assertEquals("harry", Keystore.activeProfile())
        assertTrue("account key restored", Keystore.hasAcmeAccountKey())
        assertArrayEquals(escrowedScalar, Keystore.acmeAccountKeyScalar())
    }

    // A takeover from a legacy envelope WITHOUT an escrowed account key
    // still succeeds and simply restores no account key (backward-compat).
    @Test fun single_confirm_withoutEscrowedAcme_restoresNoAccountKey() = runTest {
        val server = MockFlagshipServerClient(simulatedLatencyMs = 0)
        seedRecoveryEnvelope(server)
        val app = AppState()
        val m = vm(resolution("harry", "single", recoveryPresent = true), server, app)

        m.begin()
        m.confirmTakeover()

        assertArrayEquals(recoveredSeed, Keystore.currentUmkSeed())
        assertFalse("no account key when none was escrowed", Keystore.hasAcmeAccountKey())
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

        // confirm INITIATES (with totpProof) and lands on Grace.
        assertTrue(m.phase.first() is LoginPhase.Grace)
        assertArrayEquals(recoveredSeed, Keystore.currentUmkSeed())
        val (_, body, _) = server.lastRePairInitiate!!
        assertNotNull("multi takeover MUST carry totpProof", body.totpProof)
        assertEquals("123456", body.totpProof?.code)
        assertEquals("totp", body.totpProof?.method)
        assertTrue(verifyRePair(body))

        // completeTakeover finalizes — pairs + admin label.
        m.completeTakeover()
        assertEquals(LoginPhase.Opened, m.phase.first())
        assertEquals("hilton", app.currentUser.first())
        assertEquals(ADMIN_DEVICE_LABEL, app.activeProfile?.deviceLabel)
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
