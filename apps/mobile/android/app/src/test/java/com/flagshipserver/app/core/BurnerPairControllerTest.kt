package com.flagshipserver.app.core

import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * BurnerPairController handshake logic, driven by a MockBurnerPairClient.
 * Minting is injected as a stub (the real one needs the Keystore/biometric),
 * so connect → SAS → phone-hello → confirm → deliver are all exercised.
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

    @Test fun peerGoneFails() = runTest {
        val client = MockBurnerPairClient()
        val c = controller(this, client)
        c.begin("AEBA-GBAF")
        c.onInbound(BurnerInbound.PeerGone)
        assertTrue(c.phase.value is BurnerPairController.Phase.Failed)
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
}
