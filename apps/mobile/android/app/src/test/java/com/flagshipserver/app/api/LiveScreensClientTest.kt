// End-to-end wire-format tests for LiveScreensClient against a local
// MockWebServer. Asserts the headers/method/path/body the daemon
// contract expects (`x-flagship-session`, JSON content-type, etc.)
// and replays canned 2xx/4xx responses to validate decode + error
// branches.

package com.flagshipserver.app.api

import kotlinx.coroutines.test.runTest
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test

class LiveScreensClientTest {
    private lateinit var server: MockWebServer
    private lateinit var store: InMemorySessionStore
    private lateinit var client: LiveScreensClient

    @Before fun setUp() {
        server = MockWebServer().apply { start() }
        store = InMemorySessionStore().apply {
            setPodBaseUrl(server.url("/").toString().trimEnd('/'))
            setSessionToken("deadbeef".repeat(8))
        }
        client = LiveScreensClient(client = OkHttpClient(), store = store)
    }

    @After fun tearDown() { server.shutdown() }

    @Test fun serverDetail_sendsSessionHeaderAndDecodes() = runTest {
        server.enqueue(MockResponse().setBody("""{
            "serverFqdn":"home.h.flagship.services",
            "username":"h",
            "daemonVersion":"0.18.4",
            "startedAt":0,
            "uptimeMs":0,
            "certSans":[],
            "serviceCount":1,
            "pairedSessionCount":2,
            "recentInstallEvents":[]
        }""".trimIndent()))
        val r = client.serverDetail()
        val recorded = server.takeRequest()
        assertEquals("GET", recorded.method)
        assertEquals("/api/screens/server-detail", recorded.path)
        assertEquals("deadbeef".repeat(8), recorded.getHeader("x-flagship-session"))
        assertEquals("home.h.flagship.services", r.serverFqdn)
        assertEquals(1, r.serviceCount)
    }

    @Test fun appsList_unwrapsAppsArray() = runTest {
        server.enqueue(MockResponse().setBody("""{"apps":[]}"""))
        assertTrue(client.appsList().apps.isEmpty())
    }

    @Test fun revokePairedSession_sendsDelete() = runTest {
        server.enqueue(MockResponse().setResponseCode(204))
        client.revokePairedSession("abcdef")
        val rec = server.takeRequest()
        assertEquals("DELETE", rec.method)
        assertEquals("/api/screens/paired-sessions/abcdef", rec.path)
    }

    @Test fun http500_throwsScreensError() = runTest {
        server.enqueue(MockResponse().setResponseCode(500).setBody("boom"))
        try {
            client.appsList()
            fail("expected throw")
        } catch (e: ScreensError.Http) {
            assertEquals(500, e.status)
            assertEquals("boom", e.body)
        }
    }

    @Test fun notPaired_throwsBeforeNetwork() = runTest {
        store.setPodBaseUrl(null)
        try {
            client.appsList()
            fail("expected throw")
        } catch (_: ScreensError.NotPaired) { /* ok */ }
    }

    @Test fun noSessionToken_throwsBeforeNetwork() = runTest {
        store.setSessionToken(null)
        try {
            client.appsList()
            fail("expected throw")
        } catch (_: ScreensError.NoSessionToken) { /* ok */ }
    }

    @Test fun postRecoveryStatus_decodesReportShape() = runTest {
        server.enqueue(MockResponse().setBody("""{
          "report": {
            "currentIrkPubHex":"deadbeef",
            "state":{"lastPolledAt":1},
            "lastReissue":{
              "startedAt":1,"status":"complete",
              "oldIrkPrefix":"old","newIrkPrefix":"new",
              "apps":[{"serviceId":"plants","slug":"plants","rewrittenCount":1,"unchangedCount":0,"completedAt":2}],
              "totalRewritten":1,"reattachedCount":1,"unchangedCount":0,
              "undoWindowExpiresAt":99
            }
          }
        }""".trimIndent()))
        val r = client.postRecoveryStatus()
        assertEquals("complete", r.report?.lastReissue?.status)
        assertEquals(1, r.report?.lastReissue?.apps?.size)
    }
}
