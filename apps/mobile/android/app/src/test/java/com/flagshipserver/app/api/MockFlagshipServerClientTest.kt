// Mirror of FlagshipMobileTests/AuthCodeCancelTests + PushRegistrarTests
// on iOS, exercising MockFlagshipServerClient against the wire shapes
// the Worker expects.

package com.flagshipserver.app.api

import com.flagshipserver.app.core.HttpException
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class MockFlagshipServerClientTest {

    private fun make() = MockFlagshipServerClient(simulatedLatencyMs = 0)

    @Test fun claimUsername_isIdempotentUnderSameIrk() = runTest {
        val c = make()
        c.claimUsername(UsernameClaimRequest(
            request = UsernameClaimRequest.Inner("harry", "deadbeef", 1L),
            signature = "00",
        ))
        // Second claim with same irk should not throw
        c.claimUsername(UsernameClaimRequest(
            request = UsernameClaimRequest.Inner("harry", "deadbeef", 2L),
            signature = "00",
        ))
        assertEquals("deadbeef", c.claimedUsernames["harry"])
    }

    @Test fun claimUsername_rejectsCollisionByDifferentIrk() = runTest {
        val c = make()
        c.claimUsername(UsernameClaimRequest(
            request = UsernameClaimRequest.Inner("harry", "aaa", 1L),
            signature = "00",
        ))
        try {
            c.claimUsername(UsernameClaimRequest(
                request = UsernameClaimRequest.Inner("harry", "bbb", 2L),
                signature = "00",
            ))
            fail("expected collision")
        } catch (e: HttpException) {
            assertEquals(409, e.status)
        }
    }

    @Test fun revokeAuthCode_marksSerial() = runTest {
        val c = make()
        c.issueAuthCode(AuthCodeIssueRequest(
            code = AuthCodeWire(
                version = 1, serial = "01abc", username = "harry",
                serverName = "home", serverDomain = "home.harry.flagship.services",
                delegatedPubKey = "00", userPubKey = "00",
                issuedAt = 1L, expiresAt = 2L,
            ),
            signature = "00",
        ))
        c.revokeAuthCode(AuthCodeRevokeRequest(
            request = AuthCodeRevokeRequest.Inner("01abc", "harry", 3L),
            signature = "00",
        ))
        assertTrue("01abc" in c.revokedAuthCodes)
    }

    @Test fun registerPushToken_returnsTokenIdAndPersistsInner() = runTest {
        val c = make()
        val resp = c.registerPushToken(PushTokenRegisterRequest(
            request = PushTokenRegisterRequest.Inner(
                username = "harry", platform = "fcm",
                providerToken = "FCM:abc", pushX25519Pub = "ee",
                label = "Pixel 8 — kitchen",
                issuedAt = 100L,
            ),
            signature = "00",
        ))
        assertTrue(resp.ok)
        assertNotNull(c.registeredPushTokens[resp.tokenId])
        assertEquals("Pixel 8 — kitchen", c.registeredPushTokens[resp.tokenId]?.label)
        c.revokePushToken(revokeReq(resp.tokenId))
        assertNull(c.registeredPushTokens[resp.tokenId])
        // revoking a missing tokenId is a no-op (no throw)
        c.revokePushToken(revokeReq(resp.tokenId))
    }

    private fun revokeReq(tokenId: String) = PushTokenRevokeRequest(
        request = PushTokenRevokeRequest.Inner(tokenId = tokenId, issuedAt = 100L),
        signature = "00",
    )

    @Test fun usernameAvailable_rejectsReservedAndShort() = runTest {
        val c = make()
        assertTrue(c.usernameAvailable("admin").available.not())
        assertTrue(c.usernameAvailable("a").available.not())
        assertTrue(c.usernameAvailable("kamdemharry").available)
    }

    @Test fun usernameAvailable_enforces3to30Length() = runTest {
        // Mirror of validateUserLabel: 3–30 chars, interior single dashes OK,
        // no leading/trailing dash, no `--` (docs/service-addressing-double-dash.md).
        val c = make()
        assertTrue(c.usernameAvailable("ab").available.not())            // too short
        assertTrue(c.usernameAvailable("abc").available)                 // min
        assertTrue(c.usernameAvailable("a".repeat(30)).available)        // max
        assertTrue(c.usernameAvailable("a".repeat(31)).available.not())  // too long
        assertTrue(c.usernameAvailable("media-server").available)        // interior single dash OK
        assertTrue(c.usernameAvailable("media--server").available.not()) // `--` is the reserved delimiter
        assertTrue(c.usernameAvailable("-media").available.not())        // leading dash
        assertTrue(c.usernameAvailable("media-").available.not())        // trailing dash
    }

    @Test fun recoveryEnvelope_registerThenFetch() = runTest {
        val c = make()
        c.registerRecoveryEnvelope(
            RecoveryEnvelopeRequest(
                request = RecoveryEnvelopeRequest.Inner(
                    username = "demo1234",
                    credentialId = "cid",
                    wrappedUmk = "WRAPPED",
                    issuedAt = 1700000000000L,
                ),
                signature = "00",
            ),
        )
        val fetched = c.fetchRecoveryEnvelope("cid")
        assertEquals("WRAPPED", fetched.wrappedUmk)
        try {
            c.fetchRecoveryEnvelope("missing")
            fail("expected 404")
        } catch (e: HttpException) {
            assertEquals(404, e.status)
        }
    }
}
