// Mirror of FlagshipMobileTests/AuthCodeCancelTests + PushRegistrarTests
// on iOS, exercising MockFlagshipServerClient against the wire shapes
// the Worker expects.

package com.flagship.api

import com.flagship.core.HttpException
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
                issuedAt = 100L,
            ),
            signature = "00",
        ))
        assertTrue(resp.ok)
        assertNotNull(c.registeredPushTokens[resp.tokenId])
        c.revokePushToken(resp.tokenId)
        assertNull(c.registeredPushTokens[resp.tokenId])
        // revoking a missing tokenId is a no-op (no throw)
        c.revokePushToken(resp.tokenId)
    }

    @Test fun usernameAvailable_rejectsReservedAndShort() = runTest {
        val c = make()
        assertTrue(c.usernameAvailable("admin").available.not())
        assertTrue(c.usernameAvailable("a").available.not())
        assertTrue(c.usernameAvailable("kamdemharry").available)
    }

    @Test fun recoveryEnvelope_registerThenFetch() = runTest {
        val c = make()
        c.registerRecoveryEnvelope(RecoveryEnvelopeRequest("cid", "WRAPPED", "NONCE"))
        val fetched = c.fetchRecoveryEnvelope("cid")
        assertEquals("WRAPPED", fetched.wrappedUmkBase64)
        assertEquals("NONCE", fetched.nonceBase64)
        try {
            c.fetchRecoveryEnvelope("missing")
            fail("expected 404")
        } catch (e: HttpException) {
            assertEquals(404, e.status)
        }
    }
}
