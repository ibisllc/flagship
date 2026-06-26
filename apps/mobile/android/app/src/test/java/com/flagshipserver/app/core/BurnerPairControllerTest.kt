package com.flagshipserver.app.core

import com.google.crypto.tink.subtle.Ed25519Sign
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
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

    // Phase 4 consent: a consent-request surfaces pendingConsent; approving
    // signs an owner-IRK debug-access grant and sends a consent-result frame
    // whose grant VERIFIES under the IRK pub; denying sends one with NO grant.
    private val irkPub =
        HexUtil.decode("ea4a6c63e29c520abef5507b132ec5f9954776aebebe7b92421eea691446d22c")!!

    @Test fun consentApproveSignsAndSendsVerifiableGrant() = runTest {
        val client = MockBurnerPairClient()
        val irk = Ed25519Sign(ByteArray(32) { 7 }) // pub == irkPub above
        val c = BurnerPairController(
            client = client,
            scope = this,
            mint = { BurnerPairController.MintedRecipe("R", "home.harry.flagship.services", "S") },
            signConsentGrant = { g -> DebugAccess.sign(g, irk) },
        )
        c.begin("flagship://burner?c=AEBAGBAF&k=$burnerPk")
        c.onInbound(
            BurnerInbound.ConsentRequest("debug", "home.harry.flagship.services", "Debug exposes a shell."),
        )
        assertNotNull(c.pendingConsent.value)

        c.approveConsent()
        assertNull(c.pendingConsent.value)

        val frame = client.sentJson.last { it.contains("\"consent-result\"") }
        val obj = Json.parseToJsonElement(frame).jsonObject
        assertEquals("consent-result", obj["kind"]!!.jsonPrimitive.content)
        assertEquals("debug", obj["setting"]!!.jsonPrimitive.content)
        val envelope = obj["grant"]!!.jsonObject
        val gObj = envelope["grant"]!!.jsonObject
        val grant = DebugAccess.Grant(
            serverDomain = gObj["serverDomain"]!!.jsonPrimitive.content,
            sshAuthorizedKey = gObj["sshAuthorizedKey"]!!.jsonPrimitive.content,
            issuedAt = gObj["issuedAt"]!!.jsonPrimitive.content.toLong(),
        )
        assertEquals("home.harry.flagship.services", grant.serverDomain)
        assertTrue(
            DebugAccess.verify(grant, envelope["signatureHex"]!!.jsonPrimitive.content, irkPub),
        )
        c.cancel()
    }

    @Test fun consentDenySendsNoGrant() = runTest {
        val client = MockBurnerPairClient()
        val c = controller(this, client) // default signer never used on deny
        c.begin("flagship://burner?c=AEBAGBAF&k=$burnerPk")
        c.onInbound(
            BurnerInbound.ConsentRequest("debug", "home.harry.flagship.services", "warn"),
        )
        assertNotNull(c.pendingConsent.value)

        c.denyConsent()
        assertNull(c.pendingConsent.value)

        val frame = client.sentJson.last { it.contains("\"consent-result\"") }
        val obj = Json.parseToJsonElement(frame).jsonObject
        assertEquals("debug", obj["setting"]!!.jsonPrimitive.content)
        assertFalse(obj.containsKey("grant"))
        c.cancel()
    }

    @Test fun consentApproveWithCancelledBiometricFallsBackToDeny() = runTest {
        val client = MockBurnerPairClient()
        val c = BurnerPairController(
            client = client,
            scope = this,
            mint = { BurnerPairController.MintedRecipe("R", "home.harry.flagship.services", "S") },
            signConsentGrant = { null }, // cancelled biometric
        )
        c.begin("flagship://burner?c=AEBAGBAF&k=$burnerPk")
        c.onInbound(
            BurnerInbound.ConsentRequest("debug", "home.harry.flagship.services", "warn"),
        )
        c.approveConsent()
        assertNull(c.pendingConsent.value)
        val frame = client.sentJson.last { it.contains("\"consent-result\"") }
        assertFalse(Json.parseToJsonElement(frame).jsonObject.containsKey("grant"))
        c.cancel()
    }
}
