package com.flagshipserver.app.core

import com.flagshipserver.app.core.pq.BoxClaim
import com.google.crypto.tink.subtle.Ed25519Sign
import com.google.crypto.tink.subtle.Ed25519Verify
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.util.concurrent.Executors

/** The retail claim flow against the scripted box: every stop the screens show, the receipt pin,
 *  the one-key registration, the internet check and the certificate check (§4, §7). */
class RetailClaimFlowTest {
    private val executor = Executors.newSingleThreadExecutor()
    private val ui = executor.asCoroutineDispatcher()
    private val scope = CoroutineScope(SupervisorJob() + ui)
    private val domain = "home.alice.flagship.services"

    @After fun tearDown() { executor.shutdownNow() }

    class World {
        val registered = mutableListOf<BoxClaim.ClaimKey>()
        val signatures = mutableListOf<ByteArray>()
        val pinned = mutableMapOf<String, String>()
        val claimed = mutableListOf<String>()
        val untrusted = mutableListOf<String>()
        @Volatile var comStk: String? = MockBoxClaimRadio.stkPubHex
        @Volatile var tls: Boolean? = true
        @Volatile var noCertificateFor = 0
        @Volatile var tlsChecks = 0
        var signer: RetailClaimSigner? = null
        val adminSeed = ByteArray(32) { 0x3c }
        val adminPub: ByteArray = Ed25519Sign.KeyPair.newKeyPairFromSeed(adminSeed).publicKey
    }

    private fun make(scenario: MockBoxClaimRadio.Scenario, w: World = World()): Triple<RetailClaimViewModel, MockBoxClaimRadio, World> {
        val radio = MockBoxClaimRadio(scenario, appearAfterMs = 150, pressAfterArmMs = 400)
        val recipe = """{"blob":{"serverDomain":"$domain","authCode":{"serial":"retail-serial-0001"}},"blobSignature":"00"}"""
        val deps = RetailClaimDeps(
            username = "alice",
            radio = radio,
            mailboxLink = { error("no mailbox in these tests") },
            mintRecipe = {
                val s = RetailClaimSigner.fromSeed(w.adminSeed.copyOf())
                w.signer = s
                RetailClaimRecipe(recipe, domain, "retail-serial-0001", s)
            },
            registerKey = { k, sig -> w.registered += k; w.signatures += sig },
            pinStk = { d, k -> w.pinned[d] = k },
            registeredStk = { w.comStk },
            tlsCheck = { w.tlsChecks++; if (w.tlsChecks <= w.noCertificateFor) null else w.tls },
            onClaimed = { d, _ -> w.claimed += d },
            markUntrusted = { w.untrusted += it },
            region = "DE",
            pauseMs = { if (scenario == MockBoxClaimRadio.Scenario.EARLY_PRESS) 1_500 else 200 },
            baselineMs = 80,
            pollMs = 20,
            onlineTimeoutMs = 300,
            certificateSlowMs = 200,
            certificateGiveUpMs = 400,
        )
        return Triple(RetailClaimViewModel(deps, scope), radio, w)
    }

    private fun on(f: () -> Unit) = runBlocking { withContext(ui) { f() } }

    private fun until(vm: RetailClaimViewModel, what: String, timeoutMs: Long = 15_000, ok: (RetailClaimViewModel.Phase) -> Boolean) {
        val end = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < end) {
            if (ok(vm.phase.value)) return
            Thread.sleep(20)
        }
        fail("$what: still ${vm.phase.value}")
    }

    @Test fun cableClaimEndsWithThePadlockAfterOneSignature() {
        val (vm, radio, w) = make(MockBoxClaimRadio.Scenario.NORMAL)
        on { vm.startBluetooth() }
        until(vm, "network step") { it == RetailClaimViewModel.Phase.ChooseNetwork }
        assertEquals(MockBoxClaimRadio.stkPubHex, w.registered.single().stkPubHex)
        assertEquals(MockBoxClaimRadio.stkPubHex, w.pinned[domain])
        assertEquals(listOf(domain), w.claimed)
        Ed25519Verify(w.adminPub).verify(w.signatures.single(), w.registered.single().canonical)
        assertFalse("The admin key is dropped right after the registration.", w.signer!!.isHeld)
        on { vm.useCable() }
        until(vm, "done") { it == RetailClaimViewModel.Phase.Done(domain) }
        assertTrue(radio.sentNetwork != null && !radio.sentNetwork!!.isPresent)
    }

    @Test fun wifiWarnsThenRetriesAfterAWrongPassword() {
        val (vm, radio, _) = make(MockBoxClaimRadio.Scenario.WRONG_PASSWORD)
        on { vm.startBluetooth() }
        until(vm, "network step") { it == RetailClaimViewModel.Phase.ChooseNetwork }
        on { vm.useWifi() }
        until(vm, "list") { (it as? RetailClaimViewModel.Phase.WifiList)?.networks?.firstOrNull()?.ssid == "Home Wi-Fi" }
        on { vm.pickNetwork("Home Wi-Fi") }
        runBlocking { withContext(ui) {
            assertFalse(vm.submitPassword("Home Wi-Fi", "short"))
            assertTrue(vm.submitPassword("Home Wi-Fi", "correct horse"))
        } }
        assertEquals(RetailClaimViewModel.Phase.WifiWarning("Home Wi-Fi"), vm.phase.value)
        assertNull("Nothing leaves before the warning.", radio.sentNetwork)
        on { vm.sendWifi() }
        until(vm, "wrong password") { it == RetailClaimViewModel.Phase.NetworkFailed("wrong-password") }
        on { vm.retryNetwork(); vm.useWifi() }
        until(vm, "list again") { it is RetailClaimViewModel.Phase.WifiList }
        on { vm.submitPassword("Home Wi-Fi", "correct horse"); vm.sendWifi() }
        until(vm, "done") { it == RetailClaimViewModel.Phase.Done(domain) }
        assertEquals("DE", radio.sentNetwork!!.get().regulatoryRegion)
    }

    @Test fun stops() {
        val cases = listOf(
            MockBoxClaimRadio.Scenario.BOX_ALREADY_NEARBY to RetailClaimStop.ANOTHER_BOX_NEARBY,
            MockBoxClaimRadio.Scenario.SECOND_BOX to RetailClaimStop.TWO_BOXES,
            MockBoxClaimRadio.Scenario.EARLY_PRESS to RetailClaimStop.EARLY,
            MockBoxClaimRadio.Scenario.CONTENTION to RetailClaimStop.CONTENTION,
            MockBoxClaimRadio.Scenario.DOUBLE_PRESS to RetailClaimStop.BURST,
            MockBoxClaimRadio.Scenario.RELAY_RECEIPT to RetailClaimStop.BAD_RECEIPT,
        )
        for ((scenario, stop) in cases) {
            val (vm, _, w) = make(scenario)
            on { vm.startBluetooth() }
            until(vm, scenario.wire) { it == RetailClaimViewModel.Phase.Stopped(stop) }
            if (scenario == MockBoxClaimRadio.Scenario.RELAY_RECEIPT) {
                assertTrue("A bad receipt registers nothing.", w.registered.isEmpty())
                assertFalse("A stop drops the admin key.", w.signer!!.isHeld)
            }
        }
    }

    @Test fun alarmWhenComHoldsAnotherKeyMarksTheServerUntrusted() {
        val w = World().apply { comStk = "ee".repeat(32) }
        val (vm, _, _) = make(MockBoxClaimRadio.Scenario.NORMAL, w)
        on { vm.startBluetooth() }
        until(vm, "network step") { it == RetailClaimViewModel.Phase.ChooseNetwork }
        on { vm.useCable() }
        until(vm, "alarm") { it == RetailClaimViewModel.Phase.Alarm(RetailClaimAlarm.KEY_MISMATCH, domain) }
        assertEquals(listOf(domain), w.untrusted)
        assertEquals("ee".repeat(32), vm.alarmStk)
    }

    @Test fun alarmWhenTheBoxNeverRegisters() {
        val w = World().apply { comStk = null }
        val (vm, _, _) = make(MockBoxClaimRadio.Scenario.NORMAL, w)
        on { vm.startBluetooth() }
        until(vm, "network step") { it == RetailClaimViewModel.Phase.ChooseNetwork }
        on { vm.useCable() }
        until(vm, "alarm") { it == RetailClaimViewModel.Phase.Alarm(RetailClaimAlarm.NEVER_ONLINE, domain) }
        assertTrue("Only a key mismatch marks the server untrusted.", w.untrusted.isEmpty())
    }

    @Test fun alarmWhenTheCertificateDoesNotMatch() {
        val w = World().apply { tls = false }
        val (vm, _, _) = make(MockBoxClaimRadio.Scenario.NORMAL, w)
        on { vm.startBluetooth() }
        until(vm, "network step") { it == RetailClaimViewModel.Phase.ChooseNetwork }
        on { vm.useCable() }
        until(vm, "alarm") { it == RetailClaimViewModel.Phase.Alarm(RetailClaimAlarm.KEY_MISMATCH, domain) }
    }

    @Test fun doneWaitsForTheCertificate() {
        val w = World().apply { noCertificateFor = 3 }
        val (vm, _, _) = make(MockBoxClaimRadio.Scenario.NORMAL, w)
        on { vm.startBluetooth() }
        until(vm, "network step") { it == RetailClaimViewModel.Phase.ChooseNetwork }
        on { vm.useCable() }
        until(vm, "certificate") { it == RetailClaimViewModel.Phase.GettingCertificate(domain) }
        until(vm, "done") { it == RetailClaimViewModel.Phase.Done(domain) }
        assertEquals(4, w.tlsChecks)
    }

    @Test fun noCertificateIsNeverDone() {
        val w = World().apply { tls = null }
        val (vm, _, _) = make(MockBoxClaimRadio.Scenario.NORMAL, w)
        on { vm.startBluetooth() }
        until(vm, "network step") { it == RetailClaimViewModel.Phase.ChooseNetwork }
        on { vm.useCable() }
        until(vm, "slow") { it == RetailClaimViewModel.Phase.CertificateSlow(domain) }
        Thread.sleep(600)
        assertEquals("Without the TLS check it never says done.", RetailClaimViewModel.Phase.CertificateSlow(domain), vm.phase.value)
        w.tls = true
        on { vm.checkCertificateAgain() }
        until(vm, "done") { it == RetailClaimViewModel.Phase.Done(domain) }
    }

    @Test fun presenceRule() {
        val a = BoxClaimAdvert("p1", "aa", BoxClaim.AdvertState.UNCLAIMED)
        val b = BoxClaimAdvert("p2", "bb", BoxClaim.AdvertState.UNCLAIMED)
        val p = BoxClaimPresence()
        assertEquals(BoxClaimPresence.Verdict.Waiting, p.baseline(emptyList()))
        p.endBaseline()
        assertEquals(BoxClaimPresence.Verdict.Waiting, p.observe(emptyList()))
        assertEquals(BoxClaimPresence.Verdict.One(a), p.observe(listOf(a)))
        assertEquals("A box dropping out of one scan is fine.", BoxClaimPresence.Verdict.One(a), p.observe(emptyList()))
        assertEquals(BoxClaimPresence.Verdict.TwoBoxes, p.observe(listOf(b)))
        assertEquals(BoxClaimPresence.Verdict.TwoBoxes, p.observe(listOf(a)))
        assertEquals(BoxClaimPresence.Verdict.AnotherBoxNearby, BoxClaimPresence().baseline(listOf(a)))
    }

    @Test fun badSetupLinkStops() {
        val (vm, _, _) = make(MockBoxClaimRadio.Scenario.NORMAL)
        on { vm.startWithCode("https://flagshipserver.com/claim#c=NOPE&v=1") }
        assertEquals(RetailClaimViewModel.Phase.Stopped(RetailClaimStop.BAD_LINK), vm.phase.value)
    }

    @Test fun signerZeroesItsSeed() {
        val seed = ByteArray(32) { 7 }
        val s = RetailClaimSigner.fromSeed(seed)
        assertTrue("The caller's copy is wiped at once.", seed.all { it == 0.toByte() })
        s.sign(byteArrayOf(1))
        s.discard()
        assertFalse(s.isHeld)
        try { s.sign(byteArrayOf(1)); fail("signed after discard") } catch (e: RetailClaimKeyException) {
            assertEquals(RetailClaimKeyException.Kind.SIGNER_GONE, e.kind)
        }
    }
}
