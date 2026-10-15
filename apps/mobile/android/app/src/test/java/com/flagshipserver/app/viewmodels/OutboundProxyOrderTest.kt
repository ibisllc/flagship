// The server page's outbound proxy change (docs/outbound-proxy.md): the form
// becomes a signed `flagship/box-proxy/v1` order, credentials ride beside it
// (or stay on the box), and the box's refusal reaches the owner in its words.

package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.api.OutboundProxySetRequest
import com.flagshipserver.app.api.OutboundProxySetResponse
import com.flagshipserver.app.api.OutboundProxySetting
import com.flagshipserver.app.api.OutboundProxyStatus
import com.flagshipserver.app.api.OutboundProxySummary
import com.flagshipserver.app.api.MockScreensClient
import com.flagshipserver.app.api.ScreensClient
import com.flagshipserver.app.api.ScreensError
import com.flagshipserver.app.core.BoxProxyDraft
import com.flagshipserver.app.core.BoxProxyProtocol
import com.flagshipserver.app.core.ServerKeys
import com.google.crypto.tink.subtle.Ed25519Sign
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class OutboundProxyOrderTest {
    private val seed = ServerKeys.deriveProtocolIrkSeed(ByteArray(32) { 0x2a })
    private val pub = Ed25519Sign.KeyPair.newKeyPairFromSeed(seed).publicKey
    private val now = 1_760_000_000_000L
    private val domain = "home.plucky-avocet.flagship.services"

    private class Box(private val fail: ScreensError.Http? = null) : ScreensClient by MockScreensClient(simulatedLatencyMs = 0) {
        val sent = mutableListOf<OutboundProxySetRequest>()
        override suspend fun outboundProxySet(req: OutboundProxySetRequest): OutboundProxySetResponse {
            fail?.let { throw it }
            sent += req
            return OutboundProxySetResponse(ok = true)
        }
    }

    private fun order(box: ScreensClient, reasons: MutableList<String> = mutableListOf()) =
        OutboundProxyOrder(box, signer = { r -> reasons += r; Ed25519Sign(seed) }, now = { now }, randomBytes = { ByteArray(it) { 7 } })

    @Test fun signsTheOrderAndSendsTypedCredentials() = runTest {
        val box = Box()
        val reasons = mutableListOf<String>()
        val draft = BoxProxyDraft(kind = "socks5", host = " Proxy.Example.NET ", port = "1080", username = "alice", password = "pw")
        val r = order(box, reasons).save(domain, draft, null)
        assertEquals(OutboundProxyOrder.SAVED_PROXY, (r as OutboundProxyOrder.Outcome.Saved).message)
        assertEquals(listOf(OutboundProxyOrder.REASON), reasons)
        val sent = box.sent.single()
        assertEquals("proxy.example.net", sent.proxy.host)
        assertTrue(sent.proxy.auth)
        assertEquals("alice", sent.credentials?.username)
        assertTrue(BoxProxyProtocol.verify(sent.proxy, sent.signature, pub))
    }

    @Test fun keepsTheBoxCredentialsWhenTheFieldsStayEmptyOnTheSameProxy() = runTest {
        val box = Box()
        val current = OutboundProxySummary(
            proxy = OutboundProxySetting("http", "10.0.0.2", 3128, auth = true),
            hasCredentials = true,
            status = OutboundProxyStatus("ok"),
        )
        val draft = BoxProxyDraft.from(current).copy(fallbackDirect = true)
        order(box).save(domain, draft, current)
        val sent = box.sent.single()
        assertTrue(sent.proxy.auth)
        assertTrue(sent.proxy.fallbackDirect)
        assertNull(sent.credentials)

        // A different host needs its own credentials: auth is off unless typed.
        order(box).save(domain, draft.copy(host = "10.0.0.3"), current)
        assertFalse(box.sent.last().proxy.auth)
    }

    @Test fun turningOffSignsAnEmptyOrder() = runTest {
        val box = Box()
        val r = order(box).save(domain, BoxProxyDraft(), null)
        assertEquals(OutboundProxyOrder.SAVED_DIRECT, (r as OutboundProxyOrder.Outcome.Saved).message)
        val p = box.sent.single().proxy
        assertEquals(listOf("none", "", "0"), listOf(p.kind, p.host, p.port.toString()))
        assertTrue(BoxProxyProtocol.verify(p, box.sent.single().signature, pub))
    }

    @Test fun showsTheBoxRefusalAndValidatesBeforeSigning() = runTest {
        val refused = Box(ScreensError.Http(422, """{"error":"Can't reach the proxy."}"""))
        val r = order(refused).save(domain, BoxProxyDraft(kind = "socks5", host = "proxy.example.net", port = "1080"), null)
        assertEquals("Can't reach the proxy.", (r as OutboundProxyOrder.Outcome.Failed).message)

        val reasons = mutableListOf<String>()
        val bad = order(Box(), reasons).save(domain, BoxProxyDraft(kind = "http", host = "proxy.example.net/path", port = "1080"), null)
        assertEquals(
            "Use a host name or an IP address, without a scheme, path or port.",
            (bad as OutboundProxyOrder.Outcome.Failed).message,
        )
        assertTrue(reasons.isEmpty())
        val half = order(Box()).save(domain, BoxProxyDraft(kind = "http", host = "x.example", port = "3128", username = "a"), null)
        assertEquals("Enter a username and password.", (half as OutboundProxyOrder.Outcome.Failed).message)
    }

    @Test fun labelsTheSummary() {
        assertEquals("Off", OutboundProxySummary().label)
        val s = OutboundProxySummary(proxy = OutboundProxySetting("socks5", "2001:db8::7", 9050, auth = true))
        assertEquals("SOCKS5 · [2001:db8::7]:9050 · needs a password", s.label)
        assertEquals(
            "Not working: Can't reach the proxy.",
            s.copy(status = OutboundProxyStatus("failing", 1, "Can't reach the proxy.")).statusLine,
        )
        assertEquals("Using a direct connection: the proxy isn't answering", s.copy(status = OutboundProxyStatus("fallback")).statusLine)
        assertNull(OutboundProxySummary().statusLine)
    }

    @Test fun switchingKindMovesTheDefaultPort() {
        val d = BoxProxyDraft().withKind("socks5")
        assertEquals("1080", d.port)
        assertEquals("3128", d.withKind("http").port)
        assertEquals("8080", d.copy(port = "8080").withKind("http").port)
    }
}
