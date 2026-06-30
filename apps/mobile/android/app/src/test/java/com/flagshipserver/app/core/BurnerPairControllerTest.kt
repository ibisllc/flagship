package com.flagshipserver.app.core

import com.google.crypto.tink.subtle.Ed25519Sign
import com.google.crypto.tink.subtle.X25519
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

    @Test fun peerGoneIsAdvisory_doesNotEndSession() = runTest {
        // Contract: peer-gone is ADVISORY (the burner holds + auto-resumes) — it
        // must NOT wipe/fail the phone's session. Mirror of iOS
        // test_peerGoneIsAdvisory_doesNotEndSession.
        val client = MockBurnerPairClient()
        val c = controller(this, client)
        c.begin("flagship://burner?c=AEBAGBAF&k=$burnerPk")
        c.onInbound(BurnerInbound.PeerGone)
        assertFalse("peer-gone must not fail the session", c.phase.value is BurnerPairController.Phase.Failed)
        assertTrue(c.burnerStepped.value)
        assertNull(c.leaveRequest.value)
        c.cancel()
    }

    // ── accepted / countdown / persistence ─────────────────────────

    @Test fun acceptedSetsDeadline_persists_andShowsCountdown() = runTest {
        val store = InMemoryBurnerPairingStore()
        val client = MockBurnerPairClient()
        val c = BurnerPairController(client, this, store = store) {
            BurnerPairController.MintedRecipe("R", "home.harry.flagship.services", "S")
        }
        c.begin("flagship://burner?c=AEBAGBAF&k=$burnerPk")
        val deadline = System.currentTimeMillis() + 65_000
        c.onInbound(BurnerInbound.Accepted(deadline))

        assertEquals(deadline, c.expiresAtMs.value)
        assertNotNull(c.countdownText.value)
        assertTrue(c.countdownText.value?.startsWith("Auto-locks in ") ?: false)
        // Session is now persisted for resume.
        assertNotNull(store.load())
        assertEquals("KW3_KaK0uN8rcrQCLmsOJXXfhr9EEpib", store.load()?.sid)
        c.cancel()
    }

    // ── disconnect / session-ended ─────────────────────────────────

    @Test fun disconnect_sendsSessionEnded_wipesStore_andLeaves() = runTest {
        val store = InMemoryBurnerPairingStore()
        val client = MockBurnerPairClient()
        val c = BurnerPairController(client, this, store = store) {
            BurnerPairController.MintedRecipe("R", "home.harry.flagship.services", "S")
        }
        c.begin("flagship://burner?c=AEBAGBAF&k=$burnerPk")
        c.onInbound(BurnerInbound.Accepted(System.currentTimeMillis() + 60_000))
        assertNotNull(store.load())

        c.disconnect()
        assertTrue(client.sentJson.any { it.contains("\"session-ended\"") })
        assertNull("disconnect must wipe the persisted session", store.load())
        assertEquals(BurnerPairController.LeaveReason.UserDisconnected, c.leaveRequest.value)
    }

    @Test fun incomingSessionEnded_wipesAndLeaves() = runTest {
        val store = InMemoryBurnerPairingStore()
        val client = MockBurnerPairClient()
        val c = BurnerPairController(client, this, store = store) {
            BurnerPairController.MintedRecipe("R", "home.harry.flagship.services", "S")
        }
        c.begin("flagship://burner?c=AEBAGBAF&k=$burnerPk")
        c.onInbound(BurnerInbound.Accepted(System.currentTimeMillis() + 60_000))

        c.onInbound(BurnerInbound.SessionEnded)
        assertEquals(BurnerPairController.LeaveReason.SessionEnded, c.leaveRequest.value)
        assertNull("an incoming session-ended must wipe the persisted session", store.load())
    }

    // ── Resume reuses the SAME keys + sid (no second SAS) ───────────

    @Test fun resumeFromStore_reconnectsSameSid_reusesEphemeralKey_andSkipsSAS() = runTest {
        // A previously-confirmed + delivered session persisted to the store.
        val phoneSk = X25519.generatePrivateKey()
        val burnerSk = X25519.generatePrivateKey()
        val burnerPub = X25519.publicFromPrivate(burnerSk)
        val rec = PersistedBurnerPairing(
            sid = "resumed-sid-123",
            phoneSkB64 = Base64URL.encode(phoneSk),
            burnerPkB64 = Base64URL.encode(burnerPub),
            confirmed = true,
            recipeDelivered = true,
            serverDomain = "home.tester.flagship.services",
            recipeWire = null,
            serial = "serial-xyz",
            expiresAtMs = System.currentTimeMillis() + 600_000,
        )
        val store = InMemoryBurnerPairingStore(rec)
        val client = MockBurnerPairClient()
        val c = BurnerPairController(client, this, store = store)

        val ok = c.resumeFromStore()

        assertTrue(ok)
        // Reconnected to the SAME relay session id.
        assertEquals("resumed-sid-123", client.connectedSid)
        assertTrue(client.connectCount >= 1)
        // A confirmed+delivered session lands straight on the delivered screen
        // (no SAS re-confirmation).
        assertEquals(
            BurnerPairController.Phase.Delivered("home.tester.flagship.services"),
            c.phase.value,
        )
        assertEquals("serial-xyz", c.lastDeliveredSerial)
        // The reused ephemeral PUBLIC key (derived from the stored private key)
        // is what the resumed phone-hello carries — that's how the burner
        // recognises the same peer + skips a second SAS.
        val expectedPk = Base64URL.encode(X25519.publicFromPrivate(phoneSk))
        assertTrue(
            "resume must re-send phone-hello with the ORIGINAL ephemeral pubkey",
            client.sentJson.any { it.contains("\"phone-hello\"") && it.contains(expectedPk) },
        )
        // No confirm-pairing on resume (the SAS was already confirmed).
        assertFalse(client.sentJson.any { it.contains("\"confirm-pairing\"") })
        c.cancel()
    }

    @Test fun resumeFromStore_expiredSession_isClearedAndNotResumed() = runTest {
        val phoneSk = X25519.generatePrivateKey()
        val rec = PersistedBurnerPairing(
            sid = "old",
            phoneSkB64 = Base64URL.encode(phoneSk),
            burnerPkB64 = null,
            confirmed = true,
            recipeDelivered = true,
            serverDomain = "x",
            recipeWire = null,
            serial = null,
            expiresAtMs = System.currentTimeMillis() - 1_000, // already past
        )
        val store = InMemoryBurnerPairingStore(rec)
        val c = BurnerPairController(MockBurnerPairClient(), this, store = store)
        val ok = c.resumeFromStore()
        assertFalse(ok)
        assertNull("an expired persisted session must be cleared", store.load())
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
