// loadReleaseCatalog: a box too old to list its own releases (404) falls back
// to `.com`'s GET /api/releases; every other box answer is used or thrown as is.

package com.flagshipserver.app.api

import com.flagshipserver.app.core.HttpResponse
import com.flagshipserver.app.core.JsonHttpTransport
import com.flagshipserver.app.core.OkHttpJsonTransport
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.KSerializer
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class ReleaseCatalogFallbackTest {
    private val cur = "a".repeat(40)
    private val newest = "b".repeat(40)

    private fun entry(commit: String, tag: String, relation: String) =
        """{"commit":"$commit","releaseId":"r-$tag","tag":"$tag","endorsedAt":"2026-10-11T12:00:00.000Z","relation":"$relation"}"""

    private val comBody = """{"checkedAt":1760000000000,"currentCommit":"$cur","latest":${entry(newest, "v3", "newer")},"releases":[${entry(newest, "v3", "newer")},${entry(cur, "v1", "current")}],"source":"flagship"}"""

    private class BoxStub(val answer: suspend (Boolean) -> ReleaseCatalogResponse) :
        ScreensClient by MockScreensClient(simulatedLatencyMs = 0) {
        val calls = mutableListOf<Boolean>()
        override suspend fun serverUpdates(refresh: Boolean): ReleaseCatalogResponse {
            calls.add(refresh)
            return answer(refresh)
        }
    }

    private class ComTransport(private val body: String) : JsonHttpTransport {
        override val json: Json = OkHttpJsonTransport.defaultJson
        val urls = mutableListOf<String>()
        override suspend fun execute(method: String, url: String, body: ByteArray?, contentType: String?, extraHeaders: Map<String, String>, accept: Set<Int>): HttpResponse = error("unused")
        override suspend fun <T> postJson(url: String, body: T, serializer: KSerializer<T>, accept: Set<Int>, extraHeaders: Map<String, String>) = error("unused")
        override suspend fun <T, R> postJsonForResponse(url: String, body: T, serializer: KSerializer<T>, responseSerializer: KSerializer<R>, extraHeaders: Map<String, String>): R = error("unused")
        override suspend fun <R> getJson(url: String, responseSerializer: KSerializer<R>, extraHeaders: Map<String, String>): R {
            urls.add(url)
            return json.decodeFromString(responseSerializer, body)
        }
        override suspend fun deleteJson(url: String, accept: Set<Int>, extraHeaders: Map<String, String>) = error("unused")
    }

    private fun com(transport: ComTransport) =
        LiveSecretMailboxClient(transport, baseUrl = "https://flagshipserver.com/")

    @Test
    fun boxNotFoundAsksComWithTheRunningCommit() = runTest {
        val box = BoxStub { throw ScreensError.Http(404, "not found") }
        val transport = ComTransport(comBody)
        val c = loadReleaseCatalog(box, com(transport), cur, refresh = false)
        assertEquals(listOf("https://flagshipserver.com/api/releases?current=$cur"), transport.urls)
        assertEquals("v3", c.latest?.tag)
        assertEquals("v1", c.currentTag)
    }

    @Test
    fun refreshIsPassedToCom() = runTest {
        val box = BoxStub { throw ScreensError.Http(404, "not found") }
        val transport = ComTransport(comBody)
        loadReleaseCatalog(box, com(transport), cur, refresh = true)
        assertEquals(listOf(true), box.calls)
        assertEquals(listOf("https://flagshipserver.com/api/releases?current=$cur&refresh=1"), transport.urls)
    }

    @Test
    fun otherBoxErrorsAreThrownWithoutAskingCom() = runTest {
        val box = BoxStub { throw ScreensError.Http(502, """{"error":"bad gateway"}""") }
        val mailbox = MockSecretMailboxClient()
        try {
            loadReleaseCatalog(box, mailbox, cur, refresh = false)
            fail("expected the box error")
        } catch (e: ScreensError.Http) {
            assertEquals(502, e.status)
        }
        assertTrue(mailbox.releaseFetches.isEmpty())
    }

    @Test
    fun boxNotFoundWithoutAReportedCommitIsThrown() = runTest {
        val box = BoxStub { throw ScreensError.Http(404, "not found") }
        val mailbox = MockSecretMailboxClient()
        for (commit in listOf(null, "", "abc123", "A".repeat(40))) {
            try {
                loadReleaseCatalog(box, mailbox, commit, refresh = false)
                fail("expected the box 404 for $commit")
            } catch (e: ScreensError.Http) {
                assertEquals(404, e.status)
            }
        }
        assertTrue(mailbox.releaseFetches.isEmpty())
    }

    @Test
    fun boxListIsUsedWithoutAskingCom() = runTest {
        val list = ReleaseCatalogResponse(checkedAt = 1, currentCommit = cur)
        val box = BoxStub { list }
        val mailbox = MockSecretMailboxClient()
        assertSame(list, loadReleaseCatalog(box, mailbox, cur, refresh = true))
        assertTrue(mailbox.releaseFetches.isEmpty())
    }

    @Test
    fun decodesComBodyWithSourceAndWithoutStale() {
        val c = OkHttpJsonTransport.defaultJson.decodeFromString(ReleaseCatalogResponse.serializer(), comBody)
        assertEquals(cur, c.currentCommit)
        assertEquals(newest, c.latest?.commit)
        assertEquals(2, c.releases.size)
        assertNull(c.stale)
    }
}
