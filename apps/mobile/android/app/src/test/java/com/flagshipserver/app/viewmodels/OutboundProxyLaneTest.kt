// The outbound proxy's failure handling on the phone (docs/outbound-proxy.md "Failure handling"): the box's
// failure code in the owner's words, the alert's source, and the fallback lane through `.com` when the box can't
// be reached (never with a password).

package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.api.MockScreensClient
import com.flagshipserver.app.api.OutboundProxySetRequest
import com.flagshipserver.app.api.OutboundProxySetResponse
import com.flagshipserver.app.api.OutboundProxySetting
import com.flagshipserver.app.api.OutboundProxyStatus
import com.flagshipserver.app.api.OutboundProxySummary
import com.flagshipserver.app.api.ProxyAlertWire
import com.flagshipserver.app.api.ScreensClient
import com.flagshipserver.app.api.ScreensError
import com.flagshipserver.app.core.BoxProxyDraft
import com.flagshipserver.app.core.BoxProxyProtocol
import com.flagshipserver.app.core.BoxProxyWire
import com.flagshipserver.app.core.OutboundProxyCopy
import com.flagshipserver.app.core.OutboundProxyLane
import com.flagshipserver.app.core.ProxyAlert
import com.flagshipserver.app.core.ServerKeys
import com.google.crypto.tink.subtle.Ed25519Sign
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class OutboundProxyLaneTest {
    private val seed = ServerKeys.deriveProtocolIrkSeed(ByteArray(32) { 0x2a })
    private val pub = Ed25519Sign.KeyPair.newKeyPairFromSeed(seed).publicKey
    private val domain = "home.plucky-avocet.flagship.services"

    private class Box(private val fail: Throwable? = null) : ScreensClient by MockScreensClient(simulatedLatencyMs = 0) {
        val sent = mutableListOf<OutboundProxySetRequest>()
        override suspend fun outboundProxySet(req: OutboundProxySetRequest): OutboundProxySetResponse {
            fail?.let { throw it }
            sent += req
            return OutboundProxySetResponse(ok = true)
        }
    }

    private val laneSent = mutableListOf<Pair<String, BoxProxyWire>>()
    private val signed = mutableListOf<String>()
    private fun order(box: ScreensClient?) = OutboundProxyOrder(
        box,
        lane = { d, w -> laneSent += d to w },
        signer = { r -> signed += r; Ed25519Sign(seed) },
        now = { 1_760_000_000_000L },
        randomBytes = { ByteArray(it) { 3 } },
    )

    private val kept = OutboundProxySummary(
        proxy = OutboundProxySetting("socks5", "10.0.0.2", 1080, auth = true),
        hasCredentials = true,
        status = OutboundProxyStatus("failing", 1, null, "auth"),
    )

    @Test fun codeSentences() {
        assertEquals("Can't reach the proxy.", OutboundProxyCopy.reason("unreachable"))
        assertEquals("The proxy refused the username or password.", OutboundProxyCopy.reason("auth"))
        assertEquals("The proxy refused the connection.", OutboundProxyCopy.reason("refused"))
        assertEquals("The proxy gave an answer the server doesn't understand.", OutboundProxyCopy.reason("protocol"))
        assertEquals("Can't reach the proxy.", OutboundProxyCopy.reason(null))
        assertEquals("Can't reach the proxy.", OutboundProxyCopy.reason("martian"))
        assertEquals("The outbound proxy isn't working: The proxy refused the connection.", OutboundProxyCopy.line(ProxyAlert("failing", "refused")))
        assertEquals(
            "The outbound proxy isn't working, so this server is connecting directly: Can't reach the proxy.",
            OutboundProxyCopy.line(ProxyAlert("fallback", null)),
        )
        assertNull(OutboundProxyCopy.line(null))
    }

    @Test fun theBoxsStatusWinsOverPods() {
        val pods = ProxyAlertWire("failing", "auth", 5)
        assertEquals(ProxyAlert("failing", "auth"), OutboundProxyCopy.alertOf(null, pods))
        assertNull(OutboundProxyCopy.alertOf(OutboundProxyStatus("ok"), pods))
        assertEquals(ProxyAlert("fallback", "protocol"), OutboundProxyCopy.alertOf(OutboundProxyStatus("fallback", code = "protocol"), pods))
        assertNull(OutboundProxyCopy.alertOf(null, null))
    }

    @Test fun laneDecision() {
        assertEquals(OutboundProxyLane.Decision.ALLOWED, OutboundProxyLane.decide(BoxProxyDraft()))
        assertEquals(OutboundProxyLane.Decision.ALLOWED, OutboundProxyLane.decide(BoxProxyDraft("http", "10.0.0.3", "3128")))
        assertEquals(OutboundProxyLane.Decision.ALLOWED, OutboundProxyLane.decide(BoxProxyDraft.from(kept)))
        assertEquals(
            OutboundProxyLane.Decision.NEEDS_PASSWORD,
            OutboundProxyLane.decide(BoxProxyDraft("socks5", "10.0.0.9", "1080", "alice", "pw")),
        )
        assertEquals(
            OutboundProxyLane.Decision.NEEDS_PASSWORD,
            OutboundProxyLane.decide(BoxProxyDraft.from(kept).copy(username = "alice", password = "new")),
        )
        assertTrue(OutboundProxyLane.isUnreachable(java.net.SocketTimeoutException()))
        assertFalse(OutboundProxyLane.isUnreachable(ScreensError.Http(502, "")))
    }

    @Test fun unreachableBoxSendsTheSameOrderToTheLane() = runTest {
        val box = Box(java.net.UnknownHostException("home"))
        val r = order(box).save(domain, BoxProxyDraft.from(kept), kept)
        assertEquals(OutboundProxyOrder.QUEUED, (r as OutboundProxyOrder.Outcome.Queued).message)
        val (d, wire) = laneSent.single()
        assertEquals(domain, d)
        assertTrue(wire.proxy.auth)
        assertTrue(BoxProxyProtocol.verify(wire.proxy, wire.signature, pub))
        assertEquals(1, signed.size)
    }

    @Test fun aBoxRefusalNeverUsesTheLane() = runTest {
        val box = Box(ScreensError.Http(422, """{"error":"Can't reach the proxy."}"""))
        val r = order(box).save(domain, BoxProxyDraft(), kept)
        assertEquals("Can't reach the proxy.", (r as OutboundProxyOrder.Outcome.Failed).message)
        assertTrue(laneSent.isEmpty())
    }

    @Test fun knownUnreachableGoesStraightToTheLane() = runTest {
        val box = Box()
        val r = order(box).save(domain, BoxProxyDraft(), kept, boxUnreachable = true)
        assertTrue(r is OutboundProxyOrder.Outcome.Queued)
        assertTrue(box.sent.isEmpty())
        assertEquals("none", laneSent.single().second.proxy.kind)
    }

    @Test fun aNewPasswordIsRefusedWithoutAPrompt() = runTest {
        val draft = BoxProxyDraft("socks5", "10.0.0.9", "1080", "alice", "pw")
        val r = order(Box()).save(domain, draft, kept, boxUnreachable = true)
        assertEquals(OutboundProxyOrder.LANE_NEEDS_PASSWORD, (r as OutboundProxyOrder.Outcome.Failed).message)
        assertTrue(signed.isEmpty())
        assertTrue(laneSent.isEmpty())

        // Tried on the box first, the box unreachable: still never through the lane.
        val r2 = order(Box(java.io.IOException("down"))).save(domain, draft, kept)
        assertEquals(OutboundProxyOrder.LANE_NEEDS_PASSWORD, (r2 as OutboundProxyOrder.Outcome.Failed).message)
        assertTrue(laneSent.isEmpty())
    }
}
