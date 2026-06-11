// A′ phase 4 — `/pods` wire decode of the relayed STK-signed daemon-status
// tuple (`signedStatus`), plus the LiveSecretMailboxClient onPods observer
// the pin registry rides. Absent / null / partial signedStatus must always
// decode (and merely fail VERIFICATION later) — pin maintenance can never
// break the directory fetch.

package com.flagshipserver.app.api

import com.flagshipserver.app.core.OkHttpJsonTransport
import kotlinx.coroutines.test.runTest
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test

class PodsSignedStatusDecodeTest {
    private lateinit var server: MockWebServer

    @Before fun setUp() {
        server = MockWebServer().apply { start() }
    }

    @After fun tearDown() { server.shutdown() }

    private fun client(onPods: ((PodsDirectoryResponse) -> Unit)? = null) =
        LiveSecretMailboxClient(
            OkHttpJsonTransport(),
            baseUrl = server.url("/").toString().trimEnd('/'),
            onPods = onPods,
        )

    private val signedPodJson = """
        {
          "username": "harry1",
          "pods": [{
            "serverDomain": "abc5.harry1.flagship.services",
            "identityPubKey": "0a1eaaad1e4f57435b95e2339654618e121b2b84d3ac595c64f73520fde90d47",
            "registeredAt": 1700000000000,
            "lastReported": 1700000000000,
            "signedStatus": {
              "report": {
                "serverDomain": "abc5.harry1.flagship.services",
                "certSha256": "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
                "certValidUntil": 1800000000000,
                "certIssuer": "C=US, O=Let's Encrypt, CN=YR1",
                "appsServed": ["wiki.abc5.harry1.flagship.services"],
                "nonce": "00112233445566778899aabbccddeeff",
                "issuedAt": 1700000000000
              },
              "signatureHex": "367b"
            },
            "state": "online"
          }]
        }
    """.trimIndent()

    @Test fun decodesTheRelayedSignedStatus() = runTest {
        server.enqueue(MockResponse().setResponseCode(200).setBody(signedPodJson))
        val pod = client().fetchPods("harry1").pods.single()
        val signed = pod.signedStatus!!
        assertEquals("367b", signed.signatureHex)
        val report = signed.report!!
        assertEquals("abc5.harry1.flagship.services", report.serverDomain)
        assertEquals(
            "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
            report.certSha256,
        )
        assertEquals(1_800_000_000_000L, report.certValidUntil)
        assertEquals("C=US, O=Let's Encrypt, CN=YR1", report.certIssuer)
        assertEquals(listOf("wiki.abc5.harry1.flagship.services"), report.appsServed)
        assertEquals("00112233445566778899aabbccddeeff", report.nonce)
        assertEquals(1_700_000_000_000L, report.issuedAt)
    }

    @Test fun toleratesAbsentAndNullSignedStatus() = runTest {
        server.enqueue(
            MockResponse().setResponseCode(200).setBody(
                """
                {
                  "username": "harry1",
                  "pods": [
                    {"serverDomain": "a.harry1.flagship.services", "identityPubKey": "00"},
                    {"serverDomain": "b.harry1.flagship.services", "identityPubKey": "00",
                     "signedStatus": null}
                  ]
                }
                """.trimIndent(),
            ),
        )
        val pods = client().fetchPods("harry1").pods
        assertNull(pods[0].signedStatus)
        assertNull(pods[1].signedStatus)
    }

    @Test fun toleratesAPartialReport() = runTest {
        // A liveness-only report (null cert fields) and a garbled relay
        // (missing fields → defaults) both decode; verification rejects them.
        server.enqueue(
            MockResponse().setResponseCode(200).setBody(
                """
                {
                  "username": "harry1",
                  "pods": [{
                    "serverDomain": "c.harry1.flagship.services",
                    "identityPubKey": "00",
                    "signedStatus": {"report": {"serverDomain": "c.harry1.flagship.services"}}
                  }]
                }
                """.trimIndent(),
            ),
        )
        val signed = client().fetchPods("harry1").pods.single().signedStatus!!
        assertNull(signed.report!!.certSha256)
        assertEquals(emptyList<String>(), signed.report!!.appsServed)
        assertEquals("", signed.signatureHex)
    }

    @Test fun fetchPodsInvokesTheOnPodsObserver() = runTest {
        server.enqueue(MockResponse().setResponseCode(200).setBody(signedPodJson))
        var observed: PodsDirectoryResponse? = null
        client(onPods = { observed = it }).fetchPods("harry1")
        assertEquals(
            "abc5.harry1.flagship.services",
            observed!!.pods.single().serverDomain,
        )
    }

    @Test fun aThrowingObserverDoesNotBreakTheFetch() = runTest {
        server.enqueue(MockResponse().setResponseCode(200).setBody(signedPodJson))
        val response = client(onPods = { error("pin maintenance blew up") }).fetchPods("harry1")
        assertEquals(1, response.pods.size)
    }
}
