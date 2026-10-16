// The phone side of the QR-first remote ceremony + the connected-browsers
// list. Mirrors FlagshipMobileTests/CompanionDockViewModelTests.swift.
//   - a remote page's code joins the relay and shows the shared code;
//   - approval is biometric-gated, mints the ticket on the PICKED server and
//     seals it so only the browser's key opens it;
//   - revoke() records the tokenPrefix, removes the row optimistically,
//     and clears the per-row revokePending flag when done.

package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.api.CompanionListResponse
import com.flagshipserver.app.api.CompanionRevokeRequest
import com.flagshipserver.app.api.CompanionSummary
import com.flagshipserver.app.api.MockScreensClient
import com.flagshipserver.app.api.ScreensClient
import com.flagshipserver.app.api.ScreensError
import com.flagshipserver.app.core.Base64URL
import com.flagshipserver.app.core.PodInfo
import com.flagshipserver.app.core.QrRelay
import com.flagshipserver.app.core.QrRelayClient
import com.google.crypto.tink.subtle.X25519
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

private class FakeRelay : QrRelayClient {
    var hello: Pair<String, String>? = null
    var delivered: Pair<String, String>? = null
    var closed = 0
    override suspend fun openAndHello(sid: String, phonePkBase64Url: String) { hello = sid to phonePkBase64Url }
    override suspend fun deliver(ciphertextBase64Url: String, nonceBase64Url: String) {
        delivered = ciphertextBase64Url to nonceBase64Url
    }
    override fun close() { closed += 1 }
}

/** The browser's side: its key, its QR, and how it opens the phone's seal. */
private class FakeBrowser {
    val sk: ByteArray = X25519.generatePrivateKey()
    val sid: String = Base64URL.encode(ByteArray(16) { (it * 3).toByte() })
    val qr = "flagship://remote?s=$sid&k=${Base64URL.encode(X25519.publicFromPrivate(sk))}"

    private fun shared(phonePk: String) = X25519.computeSharedSecret(sk, Base64URL.decode(phonePk)!!)

    fun matchCode(phonePk: String): String = QrRelay.matchCodeFromBytes(
        QrRelay.hkdfSha256(shared(phonePk), QrRelay.HKDF_SALT, QrRelay.SAS_INFO, 4),
    )

    fun open(phonePk: String, sealed: Pair<String, String>): JsonObject {
        val key = QrRelay.hkdfSha256(shared(phonePk), QrRelay.HKDF_SALT, QrRelay.ENC_INFO, 32)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, Base64URL.decode(sealed.second)!!))
        val plain = cipher.doFinal(Base64URL.decode(sealed.first)!!)
        return Json.parseToJsonElement(String(plain, Charsets.UTF_8)) as JsonObject
    }
}

@OptIn(ExperimentalCoroutinesApi::class)
class CompanionDockViewModelTest {
    private val home = PodInfo(podId = "p1", name = "home", fqdn = "home.alice.flagship.services")
    private val office = PodInfo(podId = "p2", name = "office", fqdn = "office.alice.flagship.services")

    private fun TestScope.vm(
        servers: List<RemoteServer>,
        relay: QrRelayClient = FakeRelay(),
        authenticate: suspend (String) -> Unit = {},
    ) = CompanionDockViewModel(
        serversProvider = { servers },
        username = { "alice" },
        relayFactory = { relay },
        scope = backgroundScope,
        confirmGateMs = 0,
        authenticate = authenticate,
    )

    private fun TestScope.vm(client: ScreensClient) = vm(listOf(RemoteServer(home, client)))

    @Test fun approve_mintsOnThePickedServerAndSealsToTheBrowser() = runTest {
        val homeClient = MockScreensClient(simulatedLatencyMs = 0)
        val officeClient = MockScreensClient(simulatedLatencyMs = 0)
        val relay = FakeRelay()
        var gates = 0
        val vm = vm(
            listOf(RemoteServer(home, homeClient), RemoteServer(office, officeClient)),
            relay = relay,
            authenticate = { gates += 1 },
        )
        val browser = FakeBrowser()

        assertTrue(vm.stageApproval(browser.qr))
        runCurrent()
        val (sid, phonePk) = relay.hello!!
        assertEquals(browser.sid, sid)
        val matching = vm.phase.first() as CompanionDockViewModel.Phase.Matching
        assertEquals(browser.matchCode(phonePk), matching.matchCode)
        assertTrue(matching.gateOpen)

        vm.selectServer("p2")
        vm.approve().join()

        assertEquals(1, gates)
        assertTrue(homeClient.companionMintCalls.isEmpty())
        assertEquals(1, officeClient.companionMintCalls.size)
        val payload = browser.open(phonePk, relay.delivered!!)
        assertEquals("flagship/remote-ticket/v1", payload["kind"]!!.jsonPrimitive.content)
        assertEquals("https://office.alice.flagship.services", payload["podBaseUrl"]!!.jsonPrimitive.content)
        assertEquals("alice", payload["username"]!!.jsonPrimitive.content)
        assertTrue(Regex("^[0-9a-f]{32}$").matches(payload["ticketId"]!!.jsonPrimitive.content))
        assertTrue(Regex("^[0-9a-f]{64}$").matches(payload["ticketSecret"]!!.jsonPrimitive.content))
        assertEquals(CompanionDockViewModel.Phase.Connected("office"), vm.phase.first())
        assertTrue(relay.closed > 0)
    }

    @Test fun approve_failedBiometric_deliversNothing() = runTest {
        val client = MockScreensClient(simulatedLatencyMs = 0)
        val relay = FakeRelay()
        val vm = vm(listOf(RemoteServer(home, client)), relay = relay, authenticate = { error("cancelled") })
        assertTrue(vm.stageApproval(FakeBrowser().qr))
        runCurrent()
        vm.approve().join()
        assertTrue(client.companionMintCalls.isEmpty())
        assertNull(relay.delivered)
        assertEquals(CompanionDockViewModel.Phase.Idle, vm.phase.first())
        assertEquals("cancelled", vm.approvalError.first())
    }

    @Test fun stageApproval_rejectsTheOldDesktopLinkAndOtherCodes() = runTest {
        val relay = FakeRelay()
        val vm = vm(listOf(RemoteServer(home, MockScreensClient(simulatedLatencyMs = 0))), relay = relay)
        val request = "ab".repeat(16)
        val code = "cd".repeat(32)
        assertFalse(vm.stageApproval("flagship://dock?server=home.alice.flagship.services&request=$request&code=$code"))
        assertFalse(vm.stageApproval("https://flagshipserver.com/qr?s=${FakeBrowser().sid}&k=${Base64URL.encode(ByteArray(32))}"))
        runCurrent()
        assertNull(relay.hello)
        assertEquals(CompanionDockViewModel.Phase.Idle, vm.phase.first())
        assertTrue(vm.approvalError.first()!!.contains("isn't the code"))
    }

    @Test fun mockDefault_isHonestEmpty() = runTest {
        val client = MockScreensClient(simulatedLatencyMs = 0)
        val r = client.companionList()
        assertTrue(r.companions.isEmpty())
    }

    @Test fun load_defaultFixture_landsLoadedEmpty() = runTest {
        val client = MockScreensClient(simulatedLatencyMs = 0)
        val vm = vm(client)
        vm.load().join()
        val s = vm.state.first() as LoadingState.Loaded
        assertTrue(s.value.companions.isEmpty())
    }

    @Test fun load_pinnedFixture_isReturnedVerbatim() = runTest {
        val client = MockScreensClient(simulatedLatencyMs = 0).apply {
            companionListFixture = CompanionListResponse(
                companions = listOf(
                    CompanionSummary(
                        tokenPrefix = "a1b2c3d4",
                        redeemedAt = 1_700_000_000_000L,
                        lastSeenMs = 1_700_000_500_000L,
                        expiresAt = 1_700_014_400_000L,
                        userAgent = "Mozilla/5.0",
                    ),
                ),
            )
        }
        val vm = vm(client)
        vm.load().join()
        val s = vm.state.first() as LoadingState.Loaded
        assertEquals(1, s.value.companions.size)
        val c = s.value.companions.first()
        assertEquals("a1b2c3d4", c.tokenPrefix)
        assertEquals(1_700_000_500_000L, c.lastSeenMs)
        assertEquals("Mozilla/5.0", c.userAgent)
    }

    @Test fun revoke_recordsCallAndDropsRow() = runTest {
        val client = MockScreensClient(simulatedLatencyMs = 0).apply {
            companionListFixture = CompanionListResponse(
                companions = listOf(
                    CompanionSummary(
                        tokenPrefix = "deadbeef",
                        redeemedAt = 0L, lastSeenMs = 0L, expiresAt = 1L, userAgent = null,
                    ),
                    CompanionSummary(
                        tokenPrefix = "feedface",
                        redeemedAt = 0L, lastSeenMs = 0L, expiresAt = 1L, userAgent = null,
                    ),
                ),
            )
        }
        val vm = vm(client)
        vm.load().join()
        vm.revoke("deadbeef").join()
        assertEquals(listOf("deadbeef"), client.companionRevokeCalls)
        val s = vm.state.first() as LoadingState.Loaded
        assertEquals(1, s.value.companions.size)
        assertEquals("feedface", s.value.companions.first().tokenPrefix)
        assertTrue(vm.revokePending.first().isEmpty())
    }

    @Test fun load_transportError_landsInFailed() = runTest {
        val throwing = object : ScreensClient by MockScreensClient(simulatedLatencyMs = 0) {
            override suspend fun companionList(): CompanionListResponse =
                throw ScreensError.Http(503, "list down")
        }
        val vm = vm(throwing)
        vm.load().join()
        val s = vm.state.first()
        assertTrue("expected Failed, was $s", s is LoadingState.Failed)
        val msg = (s as LoadingState.Failed).message
        assertFalse(msg, msg.contains("503") || msg.contains("list down"))
        assertTrue(msg, msg.contains("try again", ignoreCase = true))
    }

    @Test fun revoke_transportError_landsInFailed() = runTest {
        val client = MockScreensClient(simulatedLatencyMs = 0).apply {
            companionListFixture = CompanionListResponse(
                companions = listOf(
                    CompanionSummary(
                        tokenPrefix = "deadbeef",
                        redeemedAt = 0L, lastSeenMs = 0L, expiresAt = 1L, userAgent = null,
                    ),
                ),
            )
        }
        val vm = vm(client)
        vm.load().join()
        client.shouldFail = true
        vm.revoke("deadbeef").join()
        val s = vm.state.first()
        assertTrue("expected Failed, was $s", s is LoadingState.Failed)
        assertFalse(vm.revokePending.first().contains("deadbeef"))
    }

    @Test fun mockRevoke_recordsRequest() = runTest {
        val client = MockScreensClient(simulatedLatencyMs = 0)
        val r = client.companionRevoke(CompanionRevokeRequest(tokenPrefix = "xyz"))
        assertTrue(r.ok)
        assertEquals(listOf("xyz"), client.companionRevokeCalls)
    }
}
