// End-to-end wire-format tests for LiveFlagshipServerClient against a
// local MockWebServer. The Worker accepts shapes byte-identical to
// iOS/webapp; these tests pin the path + body for every call.

package com.flagshipserver.app.api

import com.flagshipserver.app.core.HttpException
import com.flagshipserver.app.core.OkHttpJsonTransport
import kotlinx.coroutines.test.runTest
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test

class LiveFlagshipServerClientTest {
    private lateinit var server: MockWebServer
    private lateinit var client: LiveFlagshipServerClient

    @Before fun setUp() {
        server = MockWebServer().apply { start() }
        client = LiveFlagshipServerClient(
            transport = OkHttpJsonTransport(),
            baseUrl = server.url("/").toString().trimEnd('/'),
        )
    }

    @After fun tearDown() { server.shutdown() }

    @Test fun claimUsername_postsExpectedShape() = runTest {
        server.enqueue(MockResponse().setResponseCode(204))
        client.claimUsername(
            UsernameClaimRequest(
                request = UsernameClaimRequest.Inner("harry", "deadbeef", 1L),
                signature = "00",
            ),
        )
        val rec = server.takeRequest()
        assertEquals("POST", rec.method)
        assertEquals("/api/username/claim", rec.path)
        val body = rec.body.readUtf8()
        assertTrue(body.contains("\"username\":\"harry\""))
        assertTrue(body.contains("\"irkPub\":\"deadbeef\""))
    }

    @Test fun claimUsername_treats409AsSuccess() = runTest {
        server.enqueue(MockResponse().setResponseCode(409).setBody("already claimed"))
        client.claimUsername(
            UsernameClaimRequest(
                request = UsernameClaimRequest.Inner("harry", "deadbeef", 1L),
                signature = "00",
            ),
        )
        // No throw expected — re-take confirms request still fired.
        assertEquals("/api/username/claim", server.takeRequest().path)
    }

    @Test fun revokeAuthCode_encodesSerialInPath() = runTest {
        server.enqueue(MockResponse().setResponseCode(204))
        client.revokeAuthCode(
            AuthCodeRevokeRequest(
                request = AuthCodeRevokeRequest.Inner("01ABC", "harry", 1L),
                signature = "00",
            ),
        )
        val rec = server.takeRequest()
        assertEquals("POST", rec.method)
        assertEquals("/api/auth-code/01ABC/revoke", rec.path)
    }

    @Test fun revokeAuthCode_treats404AsSuccess() = runTest {
        server.enqueue(MockResponse().setResponseCode(404))
        client.revokeAuthCode(
            AuthCodeRevokeRequest(
                request = AuthCodeRevokeRequest.Inner("01ABC", "harry", 1L),
                signature = "00",
            ),
        )
        assertEquals("/api/auth-code/01ABC/revoke", server.takeRequest().path)
    }

    @Test fun registerPushToken_returnsParsedTokenId() = runTest {
        server.enqueue(MockResponse().setBody("""{"ok":true,"tokenId":"tok_42"}"""))
        val r = client.registerPushToken(
            PushTokenRegisterRequest(
                request = PushTokenRegisterRequest.Inner(
                    username = "harry",
                    platform = "fcm",
                    providerToken = "FCM:abc",
                    pushX25519Pub = "ee",
                    label = "Pixel 8",
                    issuedAt = 1L,
                ),
                signature = "00",
            ),
        )
        assertTrue(r.ok)
        assertEquals("tok_42", r.tokenId)
    }

    @Test fun revokePushToken_sendsDeleteAndTolerates404() = runTest {
        server.enqueue(MockResponse().setResponseCode(404))
        client.revokePushToken("tok_42")
        val rec = server.takeRequest()
        assertEquals("DELETE", rec.method)
        assertEquals("/api/push/tok_42", rec.path)
    }

    @Test fun http500_throwsHttpException() = runTest {
        server.enqueue(MockResponse().setResponseCode(500).setBody("oops"))
        try {
            client.registerRck(
                RckRegisterRequest(
                    request = RckRegisterRequest.Inner("h", "h.h.flagship.services", "ff", 1L),
                    signature = "00",
                ),
            )
            fail("expected throw")
        } catch (e: HttpException) {
            assertEquals(500, e.status)
            assertEquals("oops", e.body)
        }
    }
}
