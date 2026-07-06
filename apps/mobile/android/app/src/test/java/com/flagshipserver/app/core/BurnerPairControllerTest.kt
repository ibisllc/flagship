package com.flagshipserver.app.core

import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * BurnerPairController one-shot handshake logic, driven by a MockBurnerPairClient.
 * Minting is injected as a stub (the real one needs the Keystore/biometric), so
 * connect → SAS → phone-hello → confirm → deliver-once are all exercised.
 * Mirror of the iOS BurnerPairViewModelTests (one-shot model).
 */
@OptIn(ExperimentalCoroutinesApi::class)
class BurnerPairControllerTest {
    private val burnerPk = "pOCSkrZRwni5dyxWn1-puxPZBrRqtoyd-dwrRAn4ogk"

    private fun controller(scope: kotlinx.coroutines.CoroutineScope, client: MockBurnerPairClient) =
        BurnerPairController(client, scope) {
            BurnerPairController.MintedRecipe("RECIPE", "home.harry.flagship.services", "SER123")
        }

    @Test fun connectsToSessionIdDerivedFromCode() = runTest {
        val client = MockBurnerPairClient()
        val c = controller(this, client)
        c.begin("AEBA-GBAF")
        assertEquals("KW3_KaK0uN8rcrQCLmsOJXXfhr9EEpib", client.connectedSid)
        c.cancel()
    }

    @Test fun burnerHelloDerivesSasAndSendsPhoneHello() = runTest {
        val client = MockBurnerPairClient()
        val c = controller(this, client)
        c.begin("AEBA-GBAF") // typed: no pubkey yet
        c.onInbound(BurnerInbound.BurnerHello(burnerPk))
        val p = c.phase.value
        assertTrue("expected Matching, got $p", p is BurnerPairController.Phase.Matching)
        assertEquals(6, (p as BurnerPairController.Phase.Matching).matchCode.length)
        assertTrue(client.sentJson.any { it.contains("\"phone-hello\"") })
        c.cancel()
    }

    @Test fun peerGoneEndsSession() = runTest {
        // One-shot model: a peer-gone before delivery ends the session (the
        // burner stepped away). Mirror of iOS test_peerGoneEndsSession.
        val client = MockBurnerPairClient()
        val c = controller(this, client)
        c.begin("flagship://burner?c=AEBAGBAF&k=$burnerPk")
        c.onInbound(BurnerInbound.PeerGone)
        assertTrue("peer-gone must fail the session", c.phase.value is BurnerPairController.Phase.Failed)
    }

    @Test fun qrPathDerivesThenConfirmDelivers() = runTest {
        val client = MockBurnerPairClient()
        val c = controller(this, client)
        c.begin("flagship://burner?c=AEBAGBAF&k=$burnerPk")
        assertTrue(c.phase.value is BurnerPairController.Phase.Matching)

        c.confirmAndDeliver()
        assertEquals(
            BurnerPairController.Phase.Delivered("home.harry.flagship.services"),
            c.phase.value,
        )
        assertEquals("SER123", c.lastDeliveredSerial)
        assertTrue(client.sentJson.any { it.contains("\"confirm-pairing\"") })
        assertTrue(client.sentJson.any { it.contains("\"deliver\"") })
        c.cancel()
    }

    @Test fun postDeliveryInboundIsIgnored() = runTest {
        // One-shot: after delivery the phone has no further role — a later
        // peer-gone / expired must NOT move it off the Delivered terminal state.
        val client = MockBurnerPairClient()
        val c = controller(this, client)
        c.begin("flagship://burner?c=AEBAGBAF&k=$burnerPk")
        c.confirmAndDeliver()
        assertTrue(c.phase.value is BurnerPairController.Phase.Delivered)

        c.onInbound(BurnerInbound.PeerGone)
        c.onInbound(BurnerInbound.Expired)
        assertEquals(
            BurnerPairController.Phase.Delivered("home.harry.flagship.services"),
            c.phase.value,
        )
        c.cancel()
    }
}
