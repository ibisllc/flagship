// C3 Wave 2 (Android) — NfcPairViewModel state-machine + sealed-blob
// round-trip + failure-path tests.
//
// The reader is replaced with a MockNfcPairReader that returns a fixed
// outcome; the rendezvous client is a MockNfcRendezvousClient that
// captures the deposit + lets the test script the next outcome. Both
// avoid touching any real Android NFC API + the production Worker.
//
// One non-obvious bit: the VM expects `viewModelScope` to actually run
// the launched coroutine. Robolectric + kotlinx-coroutines-test give us
// a stable runTest dispatcher; we set the Main dispatcher to the test
// scheduler in @Before so viewModelScope.launch is observable from
// runTest blocks without needing TestScope-aware machinery in the VM.

package com.flagshipserver.app.viewmodels

import androidx.activity.ComponentActivity
import androidx.test.core.app.ApplicationProvider
import com.flagshipserver.app.api.MockNfcRendezvousClient
import com.flagshipserver.app.core.MockNfcPairReader
import com.flagshipserver.app.core.NfcPairReaderError
import com.flagshipserver.app.core.NfcPairReaderException
import com.flagshipserver.app.core.PAIR_PROTOCOL_VERSION
import com.flagshipserver.app.core.PairHint
import com.flagshipserver.app.core.PairPayload
import com.flagshipserver.app.core.ReadPairResult
import com.flagshipserver.app.core.deriveSessionKey
import com.flagshipserver.app.core.deriveSharedSecret
import com.flagshipserver.app.core.openWiFiConfig
import com.flagshipserver.app.core.signPair
import com.google.crypto.tink.subtle.Ed25519Sign
import com.google.crypto.tink.subtle.X25519
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class NfcPairViewModelTest {

    private val dispatcher = StandardTestDispatcher()

    @Before fun setUp() {
        Dispatchers.setMain(dispatcher)
    }

    @After fun tearDown() {
        Dispatchers.resetMain()
    }

    /** Stand up a host activity Robolectric can hand to the VM. The
     *  Mock reader ignores it; the type checker still wants a real
     *  ComponentActivity instance. */
    private fun activity(): ComponentActivity =
        Robolectric.buildActivity(ComponentActivity::class.java).create().get()

    /** Build a fully-signed PAIR + capture the box-side eBoxPriv so a
     *  test can re-derive K_session and openWiFiConfig the sealed blob. */
    private data class Fixture(
        val payload: PairPayload,
        val signature: ByteArray,
        /** Box-side X25519 private key — the test "plays box" with this. */
        val eBoxPriv: ByteArray,
        /** STK keypair — kept so other tests could re-sign if they want. */
        val stkPriv: ByteArray,
    )

    private fun makeFixture(
        mdnsName: String = "flagship-test.local",
        cloudRendezvousId: String = "rndz-test-1234",
        suffix6: String = "abc123",
    ): Fixture {
        val stk = Ed25519Sign.KeyPair.newKeyPair()
        val eBoxPriv = X25519.generatePrivateKey()
        val eBoxPub = X25519.publicFromPrivate(eBoxPriv)
        val payload = PairPayload(
            v = PAIR_PROTOCOL_VERSION,
            stkPub = stk.publicKey,
            eBoxPub = eBoxPub,
            nonce = ByteArray(16) { 0x11.toByte() },
            sessionId = ByteArray(16) { 0x05.toByte() },
            hint = PairHint(mdnsName, cloudRendezvousId, suffix6),
        )
        val sig = signPair(payload, stk.privateKey)
        return Fixture(payload, sig, eBoxPriv, stk.privateKey)
    }

    /** Stable phone-side ephemeral keypair the VM will hand back when
     *  asked. Tests need a known pub on both sides so the box can
     *  re-derive K_session via deriveSharedSecret(eBoxPriv, ePhonePub). */
    private fun stableKeyGen(): Pair<Pair<ByteArray, ByteArray>, () -> Pair<ByteArray, ByteArray>> {
        val priv = X25519.generatePrivateKey()
        val pub = X25519.publicFromPrivate(priv)
        val pair = priv to pub
        return pair to { pair }
    }

    @Test fun startTap_happyPath_landsOnAskingForWifi() = runTest(dispatcher) {
        val fx = makeFixture()
        val reader = MockNfcPairReader(Result.success(ReadPairResult(fx.payload, fx.signature)))
        val rdz = MockNfcRendezvousClient()
        val vm = NfcPairViewModel(reader, rdz)

        vm.startTap(activity())
        advanceUntilIdle()

        val phase = vm.phase.first()
        assertTrue("expected AskingForWifi, got $phase", phase is NfcPairPhase.AskingForWifi)
        assertEquals("flagship-test.local", (phase as NfcPairPhase.AskingForWifi).boxLabel)
        assertEquals("reader fired exactly once", 1, reader.callCount)
    }

    @Test fun startTap_userCanceled_failureMessageReflectsCancel() = runTest(dispatcher) {
        val reader = MockNfcPairReader(
            Result.failure(NfcPairReaderException(NfcPairReaderError.UserCanceled, "cancel")),
        )
        val rdz = MockNfcRendezvousClient()
        val vm = NfcPairViewModel(reader, rdz)

        vm.startTap(activity())
        advanceUntilIdle()

        val phase = vm.phase.first()
        assertTrue("expected Failure, got $phase", phase is NfcPairPhase.Failure)
        val msg = (phase as NfcPairPhase.Failure).message.lowercase()
        assertTrue("cancel copy must say 'cancelled': $msg", msg.contains("cancel"))
    }

    @Test fun startTap_signatureMismatch_failsWithoutLeakingKsession() = runTest(dispatcher) {
        val reader = MockNfcPairReader(
            Result.failure(
                NfcPairReaderException(NfcPairReaderError.SignatureMismatch, "verify false"),
            ),
        )
        val rdz = MockNfcRendezvousClient()
        val vm = NfcPairViewModel(reader, rdz)

        vm.startTap(activity())
        advanceUntilIdle()

        val phase = vm.phase.first()
        assertTrue("expected Failure, got $phase", phase is NfcPairPhase.Failure)
        val msg = (phase as NfcPairPhase.Failure).message.lowercase()
        assertTrue(
            "signature-mismatch copy must mention signature / genuine: $msg",
            msg.contains("signature") || msg.contains("genuine"),
        )
        // sendSealedWifi must NOT proceed (no captured payload) — calling
        // it surfaces a Failure rather than firing a deposit. The
        // rendezvous client must see ZERO deposits even after a retry
        // attempt: a leaked K_session would manifest as the VM happily
        // sealing under the previous tap's materials.
        vm.ssid = "doesn't matter"
        vm.sendSealedWifi()
        advanceUntilIdle()
        val phase2 = vm.phase.first()
        assertTrue(
            "post-mismatch sendSealedWifi must fail closed: $phase2",
            phase2 is NfcPairPhase.Failure,
        )
        assertEquals("no deposit must reach rendezvous", 0, rdz.deposits.size)
    }

    @Test fun sendSealedWifi_happyPath_depositsAndRoundTrips() = runTest(dispatcher) {
        val fx = makeFixture(cloudRendezvousId = "rndz-happy-0001")
        val (keys, gen) = stableKeyGen()
        val reader = MockNfcPairReader(Result.success(ReadPairResult(fx.payload, fx.signature)))
        val rdz = MockNfcRendezvousClient()
        val vm = NfcPairViewModel(reader = reader, rendezvous = rdz, ephemeralKeyGen = gen)

        vm.startTap(activity())
        advanceUntilIdle()
        assertTrue(vm.phase.first() is NfcPairPhase.AskingForWifi)

        vm.ssid = "MyHomeNet"
        vm.psk = "correct horse battery staple"
        vm.regulatoryRegion = "US"
        vm.sendSealedWifi()
        advanceUntilIdle()

        val finalPhase = vm.phase.first()
        assertTrue("expected Success, got $finalPhase", finalPhase is NfcPairPhase.Success)

        // Exactly one deposit, to the slot the PAIR hint named.
        assertEquals("exactly one deposit", 1, rdz.deposits.size)
        val dep = rdz.deposits.single()
        assertEquals("rndz-happy-0001", dep.rendezvousId)

        // Round-trip the sealed blob through the BOX-side key — proves
        // the VM derived K_session from the right transcript on the
        // phone side, and that the seal is openable by the only party
        // that holds eBoxPriv.
        val (_, ePhonePub) = keys
        val ss = deriveSharedSecret(fx.eBoxPriv, ePhonePub)
        val k = deriveSessionKey(
            sharedSecret = ss,
            stkPub = fx.payload.stkPub,
            eBoxPub = fx.payload.eBoxPub,
            ePhonePub = ePhonePub,
            nonce = fx.payload.nonce,
            sessionId = fx.payload.sessionId,
            v = fx.payload.v,
        )
        val opened = openWiFiConfig(dep.sealed, k)
        assertEquals("MyHomeNet", opened.ssid)
        assertEquals("correct horse battery staple", opened.psk)
        assertEquals("US", opened.regulatoryRegion)
    }

    @Test fun sendSealedWifi_cloudRejects_failureWithoutCachedSealedMaterial() = runTest(dispatcher) {
        val fx = makeFixture(cloudRendezvousId = "rndz-fail-0002")
        val (_, gen) = stableKeyGen()
        val reader = MockNfcPairReader(Result.success(ReadPairResult(fx.payload, fx.signature)))
        val rdz = MockNfcRendezvousClient(
            nextOutcome = Result.failure(RuntimeException("HTTP 500: simulated")),
        )
        val vm = NfcPairViewModel(reader = reader, rendezvous = rdz, ephemeralKeyGen = gen)

        vm.startTap(activity())
        advanceUntilIdle()
        assertTrue(vm.phase.first() is NfcPairPhase.AskingForWifi)

        vm.ssid = "MyHomeNet"
        vm.psk = "pw"
        vm.sendSealedWifi()
        advanceUntilIdle()

        val phase = vm.phase.first()
        assertTrue("expected Failure, got $phase", phase is NfcPairPhase.Failure)
        assertEquals("deposit was attempted exactly once", 1, rdz.deposits.size)

        // A second sendSealedWifi must NOT silently re-deposit cached
        // sealed material — the captured state was cleared, so the
        // attempt fails closed with a "tap your box first" / similar
        // copy. This pins the no-cache invariant.
        vm.sendSealedWifi()
        advanceUntilIdle()
        val phase2 = vm.phase.first()
        assertTrue("post-failure resend must NOT silently retry: $phase2", phase2 is NfcPairPhase.Failure)
        assertEquals("rendezvous must NOT receive a second deposit", 1, rdz.deposits.size)
    }

    @Test fun reset_returnsToIdle() = runTest(dispatcher) {
        val reader = MockNfcPairReader(
            Result.failure(NfcPairReaderException(NfcPairReaderError.UserCanceled, "cancel")),
        )
        val rdz = MockNfcRendezvousClient()
        val vm = NfcPairViewModel(reader, rdz)

        vm.startTap(activity())
        advanceUntilIdle()
        assertTrue(vm.phase.first() is NfcPairPhase.Failure)

        vm.ssid = "foo"; vm.psk = "bar"; vm.regulatoryRegion = "US"
        vm.reset()
        val after = vm.phase.first()
        assertEquals(NfcPairPhase.Idle, after)
        assertEquals("ssid must be cleared", "", vm.ssid)
        assertEquals("psk must be cleared", "", vm.psk)
        assertEquals("region must be cleared", "", vm.regulatoryRegion)
    }

    @Test fun nfcUnavailable_humanizesToHardwareCopy() = runTest(dispatcher) {
        val reader = MockNfcPairReader(
            Result.failure(NfcPairReaderException(NfcPairReaderError.NfcUnavailable, "no adapter")),
        )
        val rdz = MockNfcRendezvousClient()
        val vm = NfcPairViewModel(reader, rdz)

        vm.startTap(activity())
        advanceUntilIdle()

        val phase = vm.phase.first()
        assertTrue(phase is NfcPairPhase.Failure)
        val msg = (phase as NfcPairPhase.Failure).message.lowercase()
        assertTrue(
            "no-NFC copy must point at LED fallback: $msg",
            msg.contains("nfc") || msg.contains("led"),
        )
        // Test exists primarily to pin that we ASSUME a no-NFC outcome
        // never silently advances; assertNotNull defends future drift.
        assertNotNull(msg)
    }

    @Test fun sendSealedWifi_blankSsid_failsBeforeAnyDeposit() = runTest(dispatcher) {
        val fx = makeFixture()
        val reader = MockNfcPairReader(Result.success(ReadPairResult(fx.payload, fx.signature)))
        val rdz = MockNfcRendezvousClient()
        val vm = NfcPairViewModel(reader, rdz)

        vm.startTap(activity())
        advanceUntilIdle()
        assertTrue(vm.phase.first() is NfcPairPhase.AskingForWifi)

        // No SSID set.
        vm.sendSealedWifi()
        advanceUntilIdle()

        val phase = vm.phase.first()
        assertTrue("blank ssid must fail closed: $phase", phase is NfcPairPhase.Failure)
        assertEquals("no deposit must be made", 0, rdz.deposits.size)
        // lastDeposit should be null even if a future regression caches.
        assertNull(rdz.deposits.firstOrNull())
    }
}
