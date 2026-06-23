// SecuredSessionsViewModel — lists authorized browser sessions, refreshes a
// row's online/offline (≥60s debounce; 429 keeps last-known), and stops a
// session (close on the box + drop locally).

package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.api.ServiceAccessClient
import com.flagshipserver.app.core.HttpException
import com.flagshipserver.app.core.HttpResponse
import com.flagshipserver.app.core.JsonHttpTransport
import com.flagshipserver.app.core.SecuredSession
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.KSerializer
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SecuredSessionsViewModelTest {
    private val server = "home.alice.flagship.services"
    private val sid = "ab".repeat(32)
    private fun session(id: String = sid) = SecuredSession(
        secretId = id, serverId = server, serviceRef = "alice--notes",
        serviceUrl = "https://notes.$server", browserAgent = "Firefox", startedAt = 1_000L,
    )

    private val removed = ArrayList<String>()

    private fun makeVM(t: JsonHttpTransport, sessions: List<SecuredSession>, now: () -> Long = { 0L }) =
        SecuredSessionsViewModel(
            client = ServiceAccessClient(boxTransport = t, comTransport = t),
            now = now,
            load = { sessions },
            removeFromStore = { removed.add(it) },
        )

    @Test fun reload_populatesRows() = runTest {
        val vm = makeVM(StatusTransport("online"), listOf(session()))
        vm.reload()
        assertEquals(1, vm.rows.value.size)
        assertEquals(SessionLiveness.UNKNOWN, vm.rows.value[0].liveness)
    }

    @Test fun refresh_online_setsLiveness_andPostsBodySecretId() = runTest {
        val t = StatusTransport("online")
        val vm = makeVM(t, listOf(session()), now = { 100_000L })
        vm.reload()
        vm.refresh(sid)
        assertEquals(SessionLiveness.ONLINE, vm.rows.value[0].liveness)
        assertTrue(t.lastUrl!!.endsWith("/api/service-access/session/status"))
        assertTrue(t.lastBody!!.contains(sid)) // secretId in the BODY
    }

    @Test fun refresh_offlineForUnknown() = runTest {
        val vm = makeVM(StatusTransport("offline"), listOf(session()), now = { 100_000L })
        vm.reload()
        vm.refresh(sid)
        assertEquals(SessionLiveness.OFFLINE, vm.rows.value[0].liveness)
    }

    @Test fun refresh_debouncedWithin60s() = runTest {
        var clock = 100_000L
        val t = StatusTransport("online")
        val vm = makeVM(t, listOf(session()), now = { clock })
        vm.reload()
        vm.refresh(sid)
        assertEquals(SessionLiveness.ONLINE, vm.rows.value[0].liveness)
        assertEquals(1, t.calls)
        // 30s later — still debounced; no second call, liveness unchanged.
        clock += 30_000L
        assertFalse(vm.canRefresh(sid))
        vm.refresh(sid)
        assertEquals(1, t.calls)
        // 61s after the first — debounce elapsed, a second call goes out.
        clock += 31_000L
        assertTrue(vm.canRefresh(sid))
        vm.refresh(sid)
        assertEquals(2, t.calls)
    }

    @Test fun refresh_429KeepsLastKnown() = runTest {
        var clock = 100_000L
        val t = StatusTransport("online")
        val vm = makeVM(t, listOf(session()), now = { clock })
        vm.reload()
        vm.refresh(sid) // online
        assertEquals(SessionLiveness.ONLINE, vm.rows.value[0].liveness)
        // Next allowed window, but the box rate-limits (429): keep ONLINE.
        clock += 61_000L
        t.nextStatus = 429
        vm.refresh(sid)
        assertEquals(SessionLiveness.ONLINE, vm.rows.value[0].liveness)
        assertFalse(vm.rows.value[0].refreshing)
    }

    @Test fun stop_closesOnBox_andDropsLocally() = runTest {
        val t = StatusTransport("online")
        val vm = makeVM(t, listOf(session()))
        vm.reload()
        vm.stop(sid)
        assertTrue(vm.rows.value.isEmpty())
        assertTrue(removed.contains(sid))
        assertTrue(t.lastUrl!!.endsWith("/api/service-access/session/close"))
    }

    /** Returns `{"status":<online|offline>}` (200) by default; flips to a 429
     *  HttpException when `nextStatus = 429`. Counts calls + records the body. */
    class StatusTransport(private val status: String) : JsonHttpTransport {
        override val json: Json = Json { ignoreUnknownKeys = true }
        var lastUrl: String? = null
        var lastBody: String? = null
        var calls = 0
        var nextStatus = 200
        override suspend fun execute(method: String, url: String, body: ByteArray?, contentType: String?, extraHeaders: Map<String, String>, accept: Set<Int>): HttpResponse {
            calls++
            lastUrl = url; lastBody = body?.let { String(it, Charsets.UTF_8) }
            if (nextStatus == 429) throw HttpException(429, """{"error":"rate limited"}""")
            return HttpResponse(200, """{"status":"$status"}""".toByteArray(), emptyMap())
        }
        override suspend fun <T> postJson(url: String, body: T, serializer: KSerializer<T>, accept: Set<Int>, extraHeaders: Map<String, String>) = error("unused")
        override suspend fun <T, R> postJsonForResponse(url: String, body: T, serializer: KSerializer<T>, responseSerializer: KSerializer<R>, extraHeaders: Map<String, String>): R = error("unused")
        override suspend fun <R> getJson(url: String, responseSerializer: KSerializer<R>, extraHeaders: Map<String, String>): R = error("unused")
        override suspend fun deleteJson(url: String, accept: Set<Int>, extraHeaders: Map<String, String>) = error("unused")
    }
}
