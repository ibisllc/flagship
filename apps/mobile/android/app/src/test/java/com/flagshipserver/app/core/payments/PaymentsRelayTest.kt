// Spends through the private relay (docs/outbound-proxy.md "Failure handling"): a relay outage never lapses a plan.
// The spend the owner just asked for goes direct, a trickle spend waits with a backoff unless the plan would lapse
// within a day, an overage block waits, a relay success resets the record, and the Plan screen's privacy line follows.

package com.flagshipserver.app.core.payments

import com.flagshipserver.app.api.MockPaymentsClient
import com.flagshipserver.app.api.PaymentsClient
import com.flagshipserver.app.api.Redeemed
import com.flagshipserver.app.api.VoiciDeviceSigner
import com.flagshipserver.app.core.ohttp.OhttpPrivacy
import com.flagshipserver.app.core.ohttp.OhttpPublicConfig
import com.flagshipserver.app.core.ohttp.RelayUnavailableException
import com.flagshipserver.app.core.voici.VoiciJs
import com.google.crypto.tink.subtle.Ed25519Sign
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PaymentsRelayTest {
    private val DAY = PaymentsConfig.DAY_MS
    private var clock = 1_763_400_000_000L
    private val keyHex = "07002036dedf3ad3da392abb9d76a42b926584935422de695e9b941ea4fa5193c7cd37000400010001"

    /** `.com` with a relay that is up or down; a direct send records its reason. */
    private class RelayCom(val inner: MockPaymentsClient, var relays: List<Triple<String, String, Boolean>>) : PaymentsClient by inner {
        var relayUp = true
        val routes = mutableListOf<String>()
        var asked: Boolean? = null

        override suspend fun config(): JsonObject {
            val base = inner.config()
            val ohttp = JsonObject(
                mapOf(
                    "v" to JsonPrimitive(1),
                    "keyConfigHex" to JsonPrimitive("07002036dedf3ad3da392abb9d76a42b926584935422de695e9b941ea4fa5193c7cd37000400010001"),
                    "relays" to JsonArray(relays.map { (u, op, interim) -> JsonObject(mapOf("url" to JsonPrimitive(u), "operator" to JsonPrimitive(op), "interim" to JsonPrimitive(interim))) }),
                ),
            )
            return JsonObject(base + ("ohttp" to ohttp))
        }

        override suspend fun redeemPrivately(body: JsonObject, relay: OhttpPublicConfig, mayGoDirect: (String) -> Boolean): Redeemed {
            if (relay.relays.isEmpty()) {
                routes += "direct:unconfigured"
                return Redeemed(inner.redeem(body), "direct", "unconfigured")
            }
            if (relayUp) {
                routes += "ohttp"
                return Redeemed(inner.redeem(body), "ohttp")
            }
            val ok = mayGoDirect("relay-unreachable")
            asked = ok
            if (!ok) {
                routes += "waited"
                throw RelayUnavailableException("relay-unreachable")
            }
            routes += "direct:relay-unreachable"
            return Redeemed(inner.redeem(body), "direct", "relay-unreachable")
        }
    }

    private class Keys : PaymentsKeyring {
        override fun username() = "plucky-avocet"
        override fun umk() = ByteArray(32) { 0x7a }
        override fun device(): VoiciDeviceSigner {
            val kp = Ed25519Sign.KeyPair.newKeyPair()
            return VoiciDeviceSigner("d0".repeat(16), VoiciJs.hex(kp.publicKey), Ed25519Sign(kp.privateKey))
        }
        override fun isAdmin() = true
        override suspend fun confirm(reason: String) {}
    }

    private val local = MemoryPaymentsLocalStore()

    private fun setup(
        startPlan: String? = null,
        paidUntil: Long = 0,
        relays: List<Triple<String, String, Boolean>> = listOf(Triple("https://relay.example.net/x", "Example Relay Co", false)),
    ): Pair<RelayCom, PaymentsCenter> {
        val com = RelayCom(MockPaymentsClient(now = { clock }, startPlan = startPlan, startPaidUntil = paidUntil), relays)
        return com to PaymentsCenter(com, Keys(), local, { clock }, { 0.0 }, controlApex = { "flagshipserver.com" })
    }

    @Test fun theLineNamesAThirdPartyRelay() = runBlocking {
        val (_, c) = setup()
        c.refresh()
        assertEquals(RelayPrivacyLine.ThirdParty("Example Relay Co"), RelayPrivacyLine.of(c.state.value))
        val (_, interim) = setup(relays = listOf(Triple("https://flagship-ohttp-relay.fly.dev/", "Flagship (interim)", true)))
        interim.refresh()
        assertEquals(RelayPrivacyLine.Interim, RelayPrivacyLine.of(interim.state.value))
        // A relay on Cloudflare is dropped: no relay is left.
        val (_, cf) = setup(relays = listOf(Triple("https://privacy-gateway.cloudflare.com/x", "CF", false)))
        cf.refresh()
        assertEquals(RelayPrivacyLine.None, RelayPrivacyLine.of(cf.state.value))
    }

    @Test fun theSpendTheOwnerAskedForGoesDirectWhenTheRelayFails() = runBlocking {
        val (com, c) = setup()
        com.relayUp = false
        c.refresh()
        c.addTestVouchers()
        assertTrue(c.choosePlan("pro", delayStart = false, reason = "start"))
        assertEquals(listOf("direct:relay-unreachable"), com.routes)
        assertEquals("pro", c.state.value.plan)
        assertEquals(RelayPrivacyLine.WentDirect, RelayPrivacyLine.of(c.state.value))
        // The next spend through the relay clears it.
        com.relayUp = true
        clock += 3 * DAY
        c.refresh()
        c.tick()
        assertTrue(com.routes.last() == "ohttp")
        assertEquals(RelayPrivacyLine.ThirdParty("Example Relay Co"), RelayPrivacyLine.of(c.state.value))
    }

    @Test fun aTrickleSpendWaitsWithABackoffAndThePlanStays() = runBlocking {
        val (com, c) = setup(startPlan = "pro", paidUntil = clock + 2 * DAY)
        com.relayUp = false
        c.refresh()
        c.addTestVouchers()
        c.choosePlan("pro", delayStart = true, reason = "start")
        assertEquals(listOf("waited"), com.routes)
        assertEquals(false, com.asked)
        assertEquals(30, c.state.value.balance)
        assertEquals(1, c.state.value.relay.failures)
        assertEquals(clock + OhttpPrivacy.relayRetryAfterMs(1), c.state.value.relay.retryAt)
        assertEquals(RelayPrivacyLine.Waiting, RelayPrivacyLine.of(c.state.value))
        // Before the retry time nothing is tried.
        c.tick()
        assertEquals(1, com.routes.size)
        // After it, it tries again and backs off longer.
        clock += OhttpPrivacy.relayRetryAfterMs(1) + 1
        c.tick()
        assertEquals(2, c.state.value.relay.failures)
        // Close to lapsing, it goes direct rather than let the plan lapse.
        clock = com.inner.paidUntil + 72 * 3_600_000L - DAY + 60_000
        c.refresh()
        c.tick()
        assertEquals("direct:relay-unreachable", com.routes.last())
        assertTrue(c.state.value.relay.lastSpendDirect)
        assertTrue(com.inner.paidUntil > clock)
    }

    @Test fun anOverageBlockNeverGoesDirect() = runBlocking {
        val (com, c) = setup(startPlan = "pro", paidUntil = clock + 9 * DAY)
        com.inner.remainingBytes = 0
        c.refresh()
        c.addTestVouchers()
        c.setOverageCap(10)
        com.relayUp = false
        c.tick()
        assertEquals(listOf("waited"), com.routes)
        assertFalse(com.asked!!)
        assertEquals(30, c.state.value.balance)
    }

    @Test fun noRelayGoesDirectUnmarkedAndSaysSo() = runBlocking {
        val (com, c) = setup(relays = emptyList())
        c.refresh()
        c.addTestVouchers()
        assertTrue(c.choosePlan("pro", delayStart = false, reason = "start"))
        assertEquals(listOf("direct:unconfigured"), com.routes)
        assertFalse(c.state.value.relay.lastSpendDirect)
        assertEquals(RelayPrivacyLine.None, RelayPrivacyLine.of(c.state.value))
    }
}
