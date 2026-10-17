package com.flagshipserver.app.core

import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * BuilderPairController one-shot handshake logic, driven by a MockBuilderPairClient.
 * Minting is injected as a stub (the real one needs the Keystore/biometric), so
 * connect → SAS → phone-hello → confirm → deliver → desktop receipt are all exercised.
 * Mirror of the iOS BuilderPairViewModelTests (one-shot model).
 */
@OptIn(ExperimentalCoroutinesApi::class)
class BuilderPairControllerTest {
    private val builderPk = "pOCSkrZRwni5dyxWn1-puxPZBrRqtoyd-dwrRAn4ogk"

    private fun controller(scope: kotlinx.coroutines.CoroutineScope, client: MockBuilderPairClient) =
        BuilderPairController(client, scope) {
            BuilderPairController.MintedRecipe("RECIPE", "home.harry.flagship.services", "SER123")
        }

    @Test fun connectsToSessionIdDerivedFromCode() = runTest {
        val client = MockBuilderPairClient()
        val c = controller(this, client)
        c.begin("AEBA-GBAF")
        assertEquals("F2x43pqWEQ9rjC9jLfItSh4RE0K3Izzb", client.connectedSid)
        c.cancel()
    }

    @Test fun builderHelloDerivesSasAndSendsPhoneHello() = runTest {
        val client = MockBuilderPairClient()
        val c = controller(this, client)
        c.begin("AEBA-GBAF") // typed: no pubkey yet
        c.onInbound(BuilderInbound.BuilderHello(builderPk))
        val p = c.phase.value
        assertTrue("expected Matching, got $p", p is BuilderPairController.Phase.Matching)
        assertEquals(6, (p as BuilderPairController.Phase.Matching).matchCode.length)
        assertTrue(client.sentJson.any { it.contains("\"phone-hello\"") })
        c.cancel()
    }

    @Test fun peerGoneEndsSession() = runTest {
        // One-shot model: a peer-gone before delivery ends the session (the
        // builder stepped away). Mirror of iOS test_peerGoneEndsSession.
        val client = MockBuilderPairClient()
        val c = controller(this, client)
        c.begin("flagship://builder?c=AEBAGBAF&k=$builderPk")
        c.onInbound(BuilderInbound.PeerGone)
        assertTrue("peer-gone must fail the session", c.phase.value is BuilderPairController.Phase.Failed)
    }

    @Test fun qrPathDerivesThenConfirmDelivers() = runTest {
        val client = MockBuilderPairClient()
        val c = controller(this, client)
        c.begin("flagship://builder?c=AEBAGBAF&k=$builderPk")
        c.onInbound(BuilderInbound.Accepted)
        assertTrue(c.phase.value is BuilderPairController.Phase.Matching)

        c.confirmAndDeliver()
        assertTrue(c.phase.value is BuilderPairController.Phase.Delivering)
        assertTrue("pending row must wait for the desktop receipt", !client.didClose)
        c.onInbound(BuilderInbound.RecipeAccepted)
        assertEquals(
            BuilderPairController.Phase.Delivered("home.harry.flagship.services"),
            c.phase.value,
        )
        assertEquals("SER123", c.lastDeliveredSerial)
        assertTrue("phone socket must close after the desktop receipt", client.didClose)
        assertTrue(client.sentJson.any { it.contains("\"confirm-pairing\"") })
        assertTrue(client.sentJson.any { it.contains("\"deliver\"") })
        c.cancel()
    }

    @Test fun postDeliveryInboundIsIgnored() = runTest {
        // One-shot: after delivery the phone has no further role — a later
        // peer-gone / expired must NOT move it off the Delivered terminal state.
        val client = MockBuilderPairClient()
        val c = controller(this, client)
        c.begin("flagship://builder?c=AEBAGBAF&k=$builderPk")
        c.onInbound(BuilderInbound.Accepted)
        c.confirmAndDeliver()
        c.onInbound(BuilderInbound.RecipeAccepted)
        assertTrue(c.phase.value is BuilderPairController.Phase.Delivered)

        c.onInbound(BuilderInbound.PeerGone)
        c.onInbound(BuilderInbound.Expired)
        assertEquals(
            BuilderPairController.Phase.Delivered("home.harry.flagship.services"),
            c.phase.value,
        )
        c.cancel()
    }

    @Test fun qrPathWaitsForRelayAcceptanceBeforeSendingHello() = runTest {
        val client = MockBuilderPairClient()
        val c = controller(this, client)
        c.begin("flagship://builder?c=AEBAGBAF&k=$builderPk")
        assertTrue(c.phase.value is BuilderPairController.Phase.Connecting)
        assertTrue(client.sentJson.none { it.contains("\"phone-hello\"") })

        c.onInbound(BuilderInbound.Accepted)
        assertTrue(c.phase.value is BuilderPairController.Phase.Matching)
        assertTrue(client.sentJson.any { it.contains("\"phone-hello\"") })
        c.cancel()
    }

    @Test fun missingDesktopReceiptDoesNotSpinForever() = runTest {
        val client = MockBuilderPairClient()
        val c = controller(this, client)
        c.begin("flagship://builder?c=AEBAGBAF&k=$builderPk")
        c.onInbound(BuilderInbound.Accepted)
        c.confirmAndDeliver()

        advanceTimeBy(20_000)
        runCurrent()

        val failed = c.phase.value as BuilderPairController.Phase.Failed
        assertTrue(failed.message.contains("didn't confirm receipt"))
    }
}
