// Phase 5 (login redesign) — never-404 audit + decision-matrix
// conformance for Android.
//
// HARDENING pass: the single/multi/demo/unknown flows already convert
// every "absent" server state into a rendered in-app STATE (see
// LoginFlowTest, AccountResolveTest, DevicePairingFlowTest). This file
// pins the FULL decision matrix from
// docs/login-and-account-redesign.md "The unified login decision tree"
// as one cohesive contract so a future edit can't silently regress a
// branch, and asserts the two invariants the audit turned up:
//
//   A. The login space NEVER 404s. `resolveAccount` returns 200-shaped
//      data for a missing account (kind="unknown"); a transport OUTAGE
//      is distinct from a missing account and must land on Failed, not
//      masquerade as "unknown". (Mirror of the iOS
//      test_login_transportFailure_landsOnFailedNotUnknown contract.)
//
//   B. Every absent FACTOR (recovery.present==false, no second factor,
//      forged/quarantined admit) renders a clean STATE, never a raw
//      error card or crash.
//
// The matrix is asserted at two layers:
//   1. resolveAccount → the (kind, graceModel, recovery, totp) tuple
//      the Worker derives (packages/control-plane/src/accountResolve.ts).
//   2. The branch each tuple drives — demo→activate, unknown→clean
//      state, single→7d takeover, multi→TOTP-gated 24h takeover,
//      recovery.present=false→clean state, quarantined-admit→countdown.
//
// Mock parity: every resolveAccount / admitDevice assertion here doubles
// as a Worker-wire conformance check (iOS-Mock-matches-Worker-wire
// invariant) — the field names + values match accountResolve.ts and the
// admit handler in push.ts byte-for-byte.

package com.flagshipserver.app.viewmodels

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import com.flagshipserver.app.api.AccountResolution
import com.flagshipserver.app.api.DemoServerBlock
import com.flagshipserver.app.api.DeviceAdmitRequest
import com.flagshipserver.app.api.MockFlagshipServerClient
import com.flagshipserver.app.api.PushTokenRegisterRequest
import com.flagshipserver.app.api.RecoveryEnvelopeRequest
import com.flagshipserver.app.api.TrustedDevice
import com.flagshipserver.app.api.UsernameClaimRequest
import com.flagshipserver.app.core.AppState
import com.flagshipserver.app.core.DemoFixtures
import com.flagshipserver.app.core.HexUtil
import com.flagshipserver.app.core.PodInfo
import com.flagshipserver.app.keystore.Keystore
import com.flagshipserver.app.keystore.MockWebAuthnProvider
import com.flagshipserver.app.keystore.Recovery
import com.flagshipserver.app.ui.screens.quarantineCopy
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import org.junit.After
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
class LoginDecisionMatrixConformanceTest {

    private val credentialId = "ab".repeat(32)
    private val recoveredSeed = ByteArray(32) { (it + 7).toByte() }
    private val webauthn = MockWebAuthnProvider()

    @Before
    fun setUp() {
        val ctx = ApplicationProvider.getApplicationContext<Context>()
        Keystore.attachForTest(ctx.getSharedPreferences("login-conformance-test", Context.MODE_PRIVATE))
        Keystore.wipeAllProfiles()
    }

    @After
    fun tearDown() {
        Keystore.wipeAllProfiles()
    }

    // ── helpers ───────────────────────────────────────────────────────

    private suspend fun claim(server: MockFlagshipServerClient, username: String) {
        server.claimUsername(
            UsernameClaimRequest(
                request = UsernameClaimRequest.Inner(username, "ab".repeat(32), 0L),
                signature = "00",
            ),
        )
    }

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

    private fun loginVm(res: AccountResolution, server: MockFlagshipServerClient, app: AppState) =
        LoginViewModel(resolution = res, server = server, app = app, webauthn = webauthn, now = { 1_000L })

    // ════════════════════════════════════════════════════════════════
    //  Layer 1 — resolveAccount derives the canonical decision tuple.
    //  Mirror of accountResolve.ts: demo first, then unknown for any
    //  miss/invalid, then single|multi with the graceModel matrix.
    // ════════════════════════════════════════════════════════════════

    @Test fun matrix_demo_resolvesInstantNoFactors() = runTest {
        val server = MockFlagshipServerClient(simulatedLatencyMs = 0).apply {
            demoServers = mutableMapOf(
                "demoalice" to DemoServerBlock("home.demoalice.flagship.services", "up", 30),
            )
        }
        val r = server.resolveAccount("demoalice")
        assertEquals(AccountResolution.AccountKind.Demo, r.accountKind)
        assertEquals(AccountResolution.GraceModel.Instant, r.grace)
        assertFalse(r.recovery.present)
        assertFalse(r.totpEnrolled)
        assertEquals(0, r.trustedDeviceCount)
        assertNotNull("demo carries its sandbox device block", r.demoServer)
    }

    @Test fun matrix_unknown_resolvesNoneZeroed_neverThrows() = runTest {
        val server = MockFlagshipServerClient(simulatedLatencyMs = 0)
        // INVARIANT A: a missing account is a value, not a 404. This must
        // not throw — the call below would propagate an exception if it did.
        val r = server.resolveAccount("definitelymissing")
        assertFalse(r.exists)
        assertEquals(AccountResolution.AccountKind.Unknown, r.accountKind)
        assertEquals(AccountResolution.GraceModel.None, r.grace)
        assertFalse(r.recovery.present)
        assertNull(r.recovery.credentialId)
        assertNull(r.demoServer)
    }

    @Test fun matrix_single_resolvesThreeDay() = runTest {
        val server = MockFlagshipServerClient(simulatedLatencyMs = 0)
        claim(server, "harry")
        val r = server.resolveAccount("harry")
        assertEquals(AccountResolution.AccountKind.Single, r.accountKind)
        assertEquals(AccountResolution.GraceModel.ThreeDay, r.grace)
    }

    @Test fun matrix_multi_resolves24hTotp() = runTest {
        val server = MockFlagshipServerClient(simulatedLatencyMs = 0)
        claim(server, "hilton")
        server.accountTypeByUser["hilton"] = "multi"
        server.totpEnrolledAtByUser["hilton"] = 99L
        val r = server.resolveAccount("hilton")
        assertEquals(AccountResolution.AccountKind.Multi, r.accountKind)
        assertEquals(AccountResolution.GraceModel.TwentyFourHourTotp, r.grace)
        assertTrue(r.totpEnrolled)
    }

    @Test fun matrix_single_withRecoveryAndDevices_projectsFactors() = runTest {
        // accountResolve.ts projects recovery-presence + trustedDeviceCount
        // straight through. Pin both so a future Mock edit can't drift the
        // wire away from the Worker.
        val server = MockFlagshipServerClient(simulatedLatencyMs = 0)
        claim(server, "dana")
        server.cloudRecoveryByUser = mapOf("dana" to true)
        server.devicesByUser = mapOf(
            "dana" to listOf(
                TrustedDevice("tok_1", "to", "Pixel", "fcm", 1L, 1L),
                TrustedDevice("tok_2", "to", "iPad", "apns", 2L, 2L),
            ),
        )
        val r = server.resolveAccount("dana")
        assertTrue(r.recovery.present)
        assertEquals(2, r.trustedDeviceCount)
    }

    // ════════════════════════════════════════════════════════════════
    //  Layer 2 — each tuple drives the right branch + state. These are
    //  the audit's "every absent renders a STATE" assertions.
    // ════════════════════════════════════════════════════════════════

    // ── demo → activate (opens the account, no credential) ────────────

    @Test fun branch_demo_activatesAccountWithOneDevice() = runTest {
        val server = MockFlagshipServerClient(simulatedLatencyMs = 0).apply {
            demoServers = mutableMapOf(
                "demoalice" to DemoServerBlock("home.demoalice.flagship.services", "up", 30),
            )
        }
        val app = AppState()
        val r = server.resolveAccount("demoalice")
        // The JoinAccountContainer demo branch: DemoFixtures.activate.
        DemoFixtures.activate(app, r.username, demoServer = r.demoServer)
        assertTrue(app.isPaired.first())
        assertEquals("demoalice", app.currentUser.first())
        val pods = app.pods.first()
        assertEquals(1, pods.size)
        assertEquals(PodInfo.Status.ONLINE, pods.first().status)
    }

    // ── unknown → clean state, NOT an open account ────────────────────

    @Test fun branch_unknown_rendersStateAndDoesNotOpen() = runTest {
        val server = MockFlagshipServerClient(simulatedLatencyMs = 0)
        val app = AppState()
        val r = server.resolveAccount("nobody")
        // The container branches on accountKind==Unknown → NoAccountView;
        // it never calls activate. Assert the precondition + that nothing
        // opened.
        assertEquals(AccountResolution.AccountKind.Unknown, r.accountKind)
        assertNull(r.demoServer)
        assertFalse(app.isPaired.first())
        assertNull(app.currentUser.first())
    }

    // ── single → 3-day takeover, becomes admin ────────────────────────

    @Test fun branch_single_takeoverReachesAdmin() = runTest {
        val server = MockFlagshipServerClient(simulatedLatencyMs = 0)
        seedRecoveryEnvelope(server)
        val app = AppState()
        val r = AccountResolution(
            username = "harry",
            exists = true,
            kind = "single",
            recovery = AccountResolution.RecoveryState(true, false, credentialId),
            totpEnrolled = false,
            trustedDeviceCount = 0,
            graceModel = "3d",
            // A rotated (mismatched) registered IRK forces the Phase-B
            // re-pair-with-grace path this branch pins. The instant-pair
            // (Phase A) path is covered in LoginFlowTest.
            registeredIrkPubHex = "ab".repeat(32),
        )
        val m = loginVm(r, server, app)
        m.begin()
        assertEquals(
            LoginPhase.TakeoverReady(AccountResolution.GraceModel.ThreeDay),
            m.phase.first(),
        )
        m.confirmTakeover()
        assertTrue("single confirm initiates the 7d grace", m.phase.first() is LoginPhase.Grace)
        assertNull("single carries no second factor", server.lastRePairInitiate!!.second.totpProof)
        m.completeTakeover()
        assertEquals(LoginPhase.Opened, m.phase.first())
        assertEquals(ADMIN_DEVICE_LABEL, app.activeProfile?.deviceLabel)
    }

    // ── multi → TOTP-gated 24h takeover ───────────────────────────────

    @Test fun branch_multi_gatesOnSecondFactorBeforeRePair() = runTest {
        val server = MockFlagshipServerClient(simulatedLatencyMs = 0)
        seedRecoveryEnvelope(server)
        val app = AppState()
        val r = AccountResolution(
            username = "hilton",
            exists = true,
            kind = "multi",
            recovery = AccountResolution.RecoveryState(true, false, credentialId),
            totpEnrolled = true,
            trustedDeviceCount = 0,
            graceModel = "24h-totp",
        )
        val m = loginVm(r, server, app)
        m.begin()
        // INVARIANT B: the Worker REQUIRES the second factor for multi; the
        // client must collect it BEFORE touching re-pair.
        assertEquals(LoginPhase.AwaitingSecondFactor, m.phase.first())
        assertNull(server.lastRePairInitiate)
        m.submitSecondFactor("123456", isRecoveryCode = false)
        m.confirmTakeover()
        val proof = server.lastRePairInitiate!!.second.totpProof
        assertNotNull("multi takeover MUST carry the second factor", proof)
        assertEquals("totp", proof?.method)
    }

    // ── recovery.present == false → STATE, not a 404/error ────────────

    @Test fun branch_singleNoCloudBackup_rendersStateNotError() = runTest {
        val server = MockFlagshipServerClient(simulatedLatencyMs = 0)
        val app = AppState()
        val r = AccountResolution(
            username = "harry",
            exists = true,
            kind = "single",
            recovery = AccountResolution.RecoveryState(false, false),
            totpEnrolled = false,
            trustedDeviceCount = 0,
            graceModel = "3d",
        )
        val m = loginVm(r, server, app)
        m.begin()
        // The single-with-no-working-device dead end is a node in the
        // tree, NOT an error card — and it must NOT open the account or
        // touch the server.
        assertEquals(LoginPhase.NoCloudBackup(single = true), m.phase.first())
        assertFalse(app.isPaired.first())
        assertNull(server.lastRePairInitiate)
    }

    @Test fun branch_multiNoCloudBackup_flagsMultiCopyState() = runTest {
        val server = MockFlagshipServerClient(simulatedLatencyMs = 0)
        val app = AppState()
        val r = AccountResolution(
            username = "hilton",
            exists = true,
            kind = "multi",
            recovery = AccountResolution.RecoveryState(false, false),
            totpEnrolled = true,
            trustedDeviceCount = 0,
            graceModel = "24h-totp",
        )
        val m = loginVm(r, server, app)
        m.begin()
        assertEquals(LoginPhase.NoCloudBackup(single = false), m.phase.first())
        assertFalse(app.isPaired.first())
    }

    // ════════════════════════════════════════════════════════════════
    //  INVARIANT A — a transport OUTAGE is distinct from a missing
    //  account. A failed resolve must surface as a real error, never
    //  masquerade as kind="unknown". (Mirror of the iOS contract.)
    // ════════════════════════════════════════════════════════════════

    @Test fun resolve_transportFailure_throws_isDistinctFromUnknown() = runTest {
        val server = MockFlagshipServerClient(simulatedLatencyMs = 0).apply { shouldFail = true }
        var threw = false
        var resolvedUnknown = false
        try {
            val r = server.resolveAccount("harry")
            resolvedUnknown = r.accountKind == AccountResolution.AccountKind.Unknown
        } catch (t: Throwable) {
            threw = true
        }
        assertTrue("a transport outage must surface as an error", threw)
        assertFalse("an outage must NOT masquerade as a missing account", resolvedUnknown)
    }

    @Test fun login_recoveryEnvelopeRace_landsOnFailedNotCrash() = runTest {
        // Audit edge: preflight said recovery.present==true, but the
        // envelope is gone server-side (a rare race). The unwrap 404s;
        // the VM must land on Failed (a STATE), never crash.
        val server = MockFlagshipServerClient(simulatedLatencyMs = 0)
        // NB: NO seedRecoveryEnvelope — fetchRecoveryEnvelope will 404.
        val app = AppState()
        val r = AccountResolution(
            username = "harry",
            exists = true,
            kind = "single",
            recovery = AccountResolution.RecoveryState(true, false, credentialId),
            totpEnrolled = false,
            trustedDeviceCount = 0,
            graceModel = "3d",
        )
        val m = loginVm(r, server, app)
        m.begin()
        assertTrue("a missing envelope is a Failed STATE, not a crash", m.phase.first() is LoginPhase.Failed)
        assertFalse(app.isPaired.first())
    }

    // ════════════════════════════════════════════════════════════════
    //  Mock-matches-Worker-wire — admitDevice quarantine + reject paths.
    // ════════════════════════════════════════════════════════════════

    @Test fun admit_returnsQuarantineUntil_andRendersCountdown() = runTest {
        val server = MockFlagshipServerClient(simulatedLatencyMs = 0)
        val resp = server.admitDevice(
            account = "acme",
            req = DeviceAdmitRequest(
                admit = DeviceAdmitRequest.AdmitEnvelope("acme", "cd".repeat(32), 1L),
                admitSig = "00".repeat(64),
                request = PushTokenRegisterRequest.Inner(
                    username = "acme",
                    platform = "fcm",
                    providerToken = "tok",
                    pushX25519Pub = "ab".repeat(32),
                    label = "acme (new device)",
                    issuedAt = 1L,
                ),
                signature = "00".repeat(64),
            ),
        )
        assertTrue(resp.ok)
        assertNotNull("a vouched admit lands quarantined (~14d)", resp.quarantineUntil)
        // The quarantine countdown copy renders a clean STATE (not an
        // error) on the joined panel.
        val copy = quarantineCopy(resp.quarantineUntil, now = 0L)
        assertTrue("countdown mentions non-admin window", copy.contains("non-admin"))
        assertTrue("countdown surfaces the day count", copy.contains("day"))
    }

    @Test fun admit_rejectedProof_failsClosed() = runTest {
        val server = MockFlagshipServerClient(simulatedLatencyMs = 0).apply { admitShouldRejectProof = true }
        var threw = false
        try {
            server.admitDevice(
                account = "acme",
                req = DeviceAdmitRequest(
                    admit = DeviceAdmitRequest.AdmitEnvelope("acme", "cd".repeat(32), 1L),
                    admitSig = "00".repeat(64),
                    request = PushTokenRegisterRequest.Inner(
                        "acme", "fcm", "tok", "ab".repeat(32), "acme (new device)", 1L,
                    ),
                    signature = "00".repeat(64),
                ),
            )
        } catch (t: Throwable) {
            threw = true
        }
        // A bad admit proof is a security failure (401), surfaced as an
        // error the JoinDeviceViewModel humanizes — NOT a silent open.
        assertTrue("a forged/stale admit must fail closed", threw)
    }

    // ════════════════════════════════════════════════════════════════
    //  Forward-compat — an unknown future kind/grace from a newer Worker
    //  resolves to the safe Unknown/None branch (renders the clean "no
    //  account" state rather than crashing an older binary).
    // ════════════════════════════════════════════════════════════════

    @Test fun forwardCompat_unknownFutureKindAndGrace_parseSafely() {
        val r = AccountResolution(
            username = "x",
            exists = true,
            kind = "enterprise-sso",
            recovery = AccountResolution.RecoveryState(false, false),
            totpEnrolled = false,
            trustedDeviceCount = 0,
            graceModel = "quantum",
        )
        assertEquals(AccountResolution.AccountKind.Unknown, r.accountKind)
        assertEquals(AccountResolution.GraceModel.None, r.grace)
    }
}
