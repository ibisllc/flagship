// Direct (box-read) per-service leadership: the `/api/leads` decode + the
// global→per-pod inversion that lets the existing badge render from the fresher
// source while falling back to the `.com` relay on any failure. Kotlin mirror of
// iOS LeadsClientTests.
//
// Covers: decode map / null-on-404 / null-on-gossip-off / lenient; the
// global→per-pod inversion (grouping, unknown-leader drop, case-insensitive);
// and the AppState prefer-over-relay override.

package com.flagshipserver.app.api

import com.flagshipserver.app.core.AppState
import com.flagshipserver.app.core.HttpResponse
import com.flagshipserver.app.core.JsonHttpTransport
import com.flagshipserver.app.core.PodInfo
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.KSerializer
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class LeadsClientTest {

    // MARK: decode

    @Test fun decodeMapWithGossipActive() {
        val body = """
        {
          "asOf": 1700000000000,
          "self": "alpha.harry.flagship.services",
          "gossipActive": true,
          "leads": {
            "photos": { "leaderFqdn": "alpha.harry.flagship.services", "leaderStkHex": "aa", "live": true },
            "blog":   { "leaderFqdn": "beta.harry.flagship.services",  "leaderStkHex": "bb", "live": false }
          }
        }
        """.trimIndent()
        val map = LiveLeadsClient.decode(body)
        assertTrue(map != null)
        assertEquals(1700000000000L, map!!.asOf)
        assertEquals("alpha.harry.flagship.services", map.selfFqdn)
        assertTrue(map.gossipActive)
        assertEquals(2, map.leads.size)
        assertEquals("alpha.harry.flagship.services", map.leads["photos"]?.leaderFqdn)
        assertEquals(true, map.leads["photos"]?.live)
        assertEquals("beta.harry.flagship.services", map.leads["blog"]?.leaderFqdn)
        assertEquals(false, map.leads["blog"]?.live)
    }

    @Test fun decodeReturnsNullWhenGossipInactive() {
        val body = """
        { "asOf": 1, "self": "alpha.harry.flagship.services", "gossipActive": false,
          "leads": { "photos": { "leaderFqdn": "alpha.harry.flagship.services", "leaderStkHex": "aa", "live": true } } }
        """.trimIndent()
        assertNull(LiveLeadsClient.decode(body))
    }

    @Test fun decodeIsLenientDropsBadEntryKeepsGood() {
        // One entry missing leaderFqdn (dropped) + one garbled (not an object,
        // dropped) — the good one survives; the whole map does not fail.
        val body = """
        { "asOf": 5, "self": "alpha", "gossipActive": true,
          "leads": {
            "good": { "leaderFqdn": "alpha", "live": true },
            "nofqdn": { "leaderStkHex": "cc", "live": true },
            "garbled": "nope"
          } }
        """.trimIndent()
        val map = LiveLeadsClient.decode(body)
        assertTrue(map != null)
        assertEquals(1, map!!.leads.size)
        assertTrue(map.leads["good"] != null)
        // Missing leaderStkHex defaults to "" rather than failing.
        assertEquals("", map.leads["good"]?.leaderStkHex)
        assertNull(map.leads["nofqdn"])
        assertNull(map.leads["garbled"])
    }

    @Test fun decodeReturnsNullOnNonObject() {
        assertNull(LiveLeadsClient.decode("not json"))
        assertNull(LiveLeadsClient.decode("[1,2,3]"))
    }

    // MARK: live client — 404 / error → null (pre-/api/leads box, network blip)

    @Test fun fetchReturns404AsNull() = runTest {
        val client = LiveLeadsClient(transport = StubTransport(status = 404, body = "Not Found"))
        assertNull(client.fetchLeads("old.harry.flagship.services"))
    }

    @Test fun fetchReturnsNullOnNetworkError() = runTest {
        val client = LiveLeadsClient(transport = ThrowingTransport())
        assertNull(client.fetchLeads("alpha.harry.flagship.services"))
    }

    @Test fun fetchDecodesA200Map() = runTest {
        val body = """
        { "asOf": 9, "self": "alpha.harry.flagship.services", "gossipActive": true,
          "leads": { "photos": { "leaderFqdn": "alpha.harry.flagship.services", "leaderStkHex": "aa", "live": true } } }
        """.trimIndent()
        val transport = StubTransport(status = 200, body = body)
        val client = LiveLeadsClient(transport = transport)
        val map = client.fetchLeads("alpha.harry.flagship.services")
        assertTrue(map != null)
        assertEquals("alpha.harry.flagship.services", map!!.leads["photos"]?.leaderFqdn)
        assertEquals("https://alpha.harry.flagship.services/api/leads", transport.lastUrl)
    }

    // MARK: inversion (global slug→leaderFqdn  →  per-pod fqdn→[slugs])

    @Test fun inversionGroupsSlugsUnderMatchedFqdn() {
        val leads = mapOf(
            "photos" to LeadEntry("alpha.harry.flagship.services", "a", true),
            "notes" to LeadEntry("alpha.harry.flagship.services", "a", true),
            "blog" to LeadEntry("beta.harry.flagship.services", "b", true),
        )
        val known = listOf("alpha.harry.flagship.services", "beta.harry.flagship.services")
        val out = DirectLeadsInversion.invert(leads, known)
        // Slugs sorted, grouped under their leader's lowercased fqdn.
        assertEquals(listOf("notes", "photos"), out["alpha.harry.flagship.services"])
        assertEquals(listOf("blog"), out["beta.harry.flagship.services"])
    }

    @Test fun inversionDropsUnknownLeaderFqdn() {
        // A slug led by a box this account doesn't show is dropped (no pod to
        // badge), so the inversion is empty and applying it is a no-op.
        val leads = mapOf(
            "ghost" to LeadEntry("elsewhere.other.flagship.services", "z", true),
        )
        val out = DirectLeadsInversion.invert(leads, listOf("alpha.harry.flagship.services"))
        assertTrue(out.isEmpty())
    }

    @Test fun inversionMatchesCaseInsensitively() {
        val leads = mapOf(
            "photos" to LeadEntry("Alpha.Harry.Flagship.Services", "a", true),
        )
        val out = DirectLeadsInversion.invert(leads, listOf("alpha.harry.flagship.services"))
        assertEquals(listOf("photos"), out["alpha.harry.flagship.services"])
    }

    // MARK: AppState prefer-over-relay

    @Test fun applyDirectLeadsOverridesRelayValuePerPod() {
        val app = AppState()
        app.upsertRegisteredPod(
            fqdn = "alpha.harry.flagship.services", name = "Alpha",
            liveness = PodInfo.Liveness.LIVE, leadsServices = listOf("photos"),
        )
        app.upsertRegisteredPod(
            fqdn = "beta.harry.flagship.services", name = "Beta",
            liveness = PodInfo.Liveness.LIVE, leadsServices = listOf("blog"),
        )

        // Direct view: alpha now leads photos+notes; beta yielded blog (empty).
        app.applyDirectLeads(
            mapOf(
                "alpha.harry.flagship.services" to listOf("notes", "photos"),
                "beta.harry.flagship.services" to emptyList(),
            ),
        )

        val alpha = app.pods.value.first { it.fqdn == "alpha.harry.flagship.services" }
        val beta = app.pods.value.first { it.fqdn == "beta.harry.flagship.services" }
        assertEquals(listOf("notes", "photos"), alpha.leadsServices)
        // An empty direct list OVERRIDES the stale relay badge (yielded service).
        assertEquals(emptyList<String>(), beta.leadsServices)
    }

    @Test fun applyDirectLeadsLeavesUnmatchedPodsOnRelayValue() {
        val app = AppState()
        app.upsertRegisteredPod(
            fqdn = "alpha.harry.flagship.services", name = "Alpha",
            liveness = PodInfo.Liveness.LIVE, leadsServices = listOf("photos"),
        )
        // A map that says nothing about alpha — its relay value must stand.
        app.applyDirectLeads(mapOf("beta.harry.flagship.services" to listOf("blog")))
        val alpha = app.pods.value.first { it.fqdn == "alpha.harry.flagship.services" }
        assertEquals(listOf("photos"), alpha.leadsServices)
    }

    @Test fun applyDirectLeadsEmptyMapIsNoOp() {
        val app = AppState()
        app.upsertRegisteredPod(
            fqdn = "alpha.harry.flagship.services", name = "Alpha",
            liveness = PodInfo.Liveness.LIVE, leadsServices = listOf("photos"),
        )
        app.applyDirectLeads(emptyMap())
        val alpha = app.pods.value.first { it.fqdn == "alpha.harry.flagship.services" }
        assertEquals(listOf("photos"), alpha.leadsServices)
    }

    // MARK: stub transports

    /** Returns a canned status + body from execute(); records the URL. */
    private class StubTransport(
        private val status: Int,
        private val body: String,
    ) : JsonHttpTransport {
        override val json: Json = Json { ignoreUnknownKeys = true }
        var lastUrl: String? = null
        override suspend fun execute(method: String, url: String, body: ByteArray?, contentType: String?, extraHeaders: Map<String, String>, accept: Set<Int>): HttpResponse {
            lastUrl = url
            return HttpResponse(status, this.body.toByteArray(Charsets.UTF_8), emptyMap())
        }
        override suspend fun <T> postJson(url: String, body: T, serializer: KSerializer<T>, accept: Set<Int>, extraHeaders: Map<String, String>) = error("unused")
        override suspend fun <T, R> postJsonForResponse(url: String, body: T, serializer: KSerializer<T>, responseSerializer: KSerializer<R>, extraHeaders: Map<String, String>): R = error("unused")
        override suspend fun <R> getJson(url: String, responseSerializer: KSerializer<R>, extraHeaders: Map<String, String>): R = error("unused")
        override suspend fun deleteJson(url: String, accept: Set<Int>, extraHeaders: Map<String, String>) = error("unused")
    }

    /** execute() throws (cert-pin mismatch / network / DNS) — fetchLeads must
     *  swallow it and return null. */
    private class ThrowingTransport : JsonHttpTransport {
        override val json: Json = Json { ignoreUnknownKeys = true }
        override suspend fun execute(method: String, url: String, body: ByteArray?, contentType: String?, extraHeaders: Map<String, String>, accept: Set<Int>): HttpResponse = throw RuntimeException("cert pin mismatch")
        override suspend fun <T> postJson(url: String, body: T, serializer: KSerializer<T>, accept: Set<Int>, extraHeaders: Map<String, String>) = error("unused")
        override suspend fun <T, R> postJsonForResponse(url: String, body: T, serializer: KSerializer<T>, responseSerializer: KSerializer<R>, extraHeaders: Map<String, String>): R = error("unused")
        override suspend fun <R> getJson(url: String, responseSerializer: KSerializer<R>, extraHeaders: Map<String, String>): R = error("unused")
        override suspend fun deleteJson(url: String, accept: Set<Int>, extraHeaders: Map<String, String>) = error("unused")
    }
}
