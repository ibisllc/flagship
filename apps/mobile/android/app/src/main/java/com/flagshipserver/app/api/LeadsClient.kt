// Direct (box-read) per-service leadership — the Kotlin mirror of iOS
// `LeadsClient.swift`.
//
// Today the phone learns which box LEADS which service from the `.com` `/pods`
// `leadsServices` relay (Phase 6) — fresh to ~5 min and `.com`-dependent. When
// a box is reachable the phone can instead read leadership STRAIGHT from a box,
// over the same box-pinned canonical pipe as `GET /api/services`:
//
//   GET https://<podFqdn>/api/leads   (unauthenticated)
//     → { asOf, self, gossipActive, leads: { <slug>: { leaderFqdn, leaderStkHex, live } } }
//
// This is GLOBAL (every slug the box's gossip view knows a leader for, keyed by
// slug → the leading fqdn), so the caller INVERTS it into the per-pod
// "fqdn → slugs it leads" shape the UI already renders (see
// [DirectLeadsInversion]). The read is best-effort and on-demand: a
// pre-`/api/leads` box 404s, a box with gossip off reports `gossipActive:false`,
// and either yields `null` so the caller falls back to the `.com` relay — it
// must never regress the existing badge.

package com.flagshipserver.app.api

import com.flagshipserver.app.core.HttpClientFactory
import com.flagshipserver.app.core.JsonHttpTransport
import com.flagshipserver.app.core.OkHttpJsonTransport
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull

/** One slug's leadership, from a box's gossip view. */
data class LeadEntry(
    /** The fqdn of the box currently leading this service. */
    val leaderFqdn: String,
    /** The leader's STK pubkey (hex) — informational; the client matches by fqdn. */
    val leaderStkHex: String,
    /** Whether the leader is a live runner (vs a stale/elected-but-down view). */
    val live: Boolean,
)

/** The decoded `/api/leads` body. [leads] is keyed by service slug. */
data class LeadsMap(
    /** Box clock (ms) when this view was taken — informational. */
    val asOf: Long,
    /** The responding box's own fqdn. */
    val selfFqdn: String,
    /** Whether gossip is active on the box. A `false` here is treated by the live
     *  client as "no fresher source" (returns null), since the box's leadership
     *  view is meaningless without an active gossip loop. */
    val gossipActive: Boolean,
    /** slug → who leads it. */
    val leads: Map<String, LeadEntry>,
)

interface LeadsClient {
    /** Fetch `/api/leads` from one box. Returns the decoded map, or `null` on any
     *  error / non-2xx (incl. a pre-`/api/leads` 404) / `gossipActive == false`.
     *  NEVER throws — leadership is a best-effort optimization over the relay. */
    suspend fun fetchLeads(podFqdn: String): LeadsMap?
}

/** Live reader. Rides the BOX-pinned transport (hard-fail cert pinning) exactly
 *  like [FrontPageClient]/[ServiceAccessClient] — [HttpClientFactory.build]
 *  carries the box cert-fingerprint interceptor. */
class LiveLeadsClient(
    private val transport: JsonHttpTransport = OkHttpJsonTransport(HttpClientFactory.build()),
    private val podBaseUrl: (podFqdn: String) -> String = { "https://${it.trim().trim('/')}" },
) : LeadsClient {
    override suspend fun fetchLeads(podFqdn: String): LeadsMap? {
        // A pre-`/api/leads` box 404s (and any non-2xx) → fall back to relay.
        // Accept the whole status range here so a non-2xx doesn't throw via
        // HttpException; we gate on it ourselves.
        val resp = runCatching {
            transport.execute(
                method = "GET",
                url = "${podBaseUrl(podFqdn)}/api/leads",
                accept = (100..599).toSet(),
            )
        }.getOrNull() ?: return null // cert-pin mismatch / network / DNS — no throw.
        if (resp.status < 200 || resp.status >= 300) return null
        return decode(String(resp.body, Charsets.UTF_8), transport.json)
    }

    companion object {
        private val LENIENT = Json { ignoreUnknownKeys = true; isLenient = true }

        /** Lenient decode. Tolerates missing/garbled fields (a per-entry default
         *  keeps one bad slug from dropping the whole map) and returns null when
         *  the body isn't a leads object or gossip is off. */
        fun decode(body: String, json: Json = LENIENT): LeadsMap? {
            val root: JsonObject = runCatching {
                json.parseToJsonElement(body).jsonObject
            }.getOrNull() ?: return null
            // Gossip off ⇒ the box's leadership view is not authoritative; defer
            // to the `.com` relay rather than render a possibly-empty/stale view.
            val gossipActive = root["gossipActive"]?.jsonPrimitive?.booleanOrNull ?: false
            if (!gossipActive) return null
            val asOf = root["asOf"]?.jsonPrimitive?.longOrNull ?: 0L
            val selfFqdn = runCatching { root["self"]?.jsonPrimitive?.content }.getOrNull() ?: ""
            val leads = mutableMapOf<String, LeadEntry>()
            val raw = root["leads"] as? JsonObject
            if (raw != null) {
                for ((slug, v) in raw) {
                    val e = v as? JsonObject ?: continue
                    val leaderFqdn = runCatching { e["leaderFqdn"]?.jsonPrimitive?.content }.getOrNull() ?: ""
                    if (leaderFqdn.isEmpty()) continue
                    leads[slug] = LeadEntry(
                        leaderFqdn = leaderFqdn,
                        leaderStkHex = runCatching { e["leaderStkHex"]?.jsonPrimitive?.content }.getOrNull() ?: "",
                        live = e["live"]?.jsonPrimitive?.booleanOrNull ?: false,
                    )
                }
            }
            return LeadsMap(asOf = asOf, selfFqdn = selfFqdn, gossipActive = gossipActive, leads = leads)
        }
    }
}

/** Inverts the GLOBAL box view (slug → leaderFqdn) into the per-pod model the UI
 *  reads (lowercased fqdn → the slugs that box leads). Only slugs whose
 *  `leaderFqdn` matches a KNOWN pod fqdn are kept (an unknown leader is a box
 *  this account doesn't show, so it can't render a badge for it). Slug lists are
 *  sorted for a stable, churn-free badge. Mirror of iOS `DirectLeadsInversion`. */
object DirectLeadsInversion {
    fun invert(leads: Map<String, LeadEntry>, knownFqdns: List<String>): Map<String, List<String>> {
        val known = knownFqdns.map { it.lowercase() }.toSet()
        val out = mutableMapOf<String, MutableList<String>>()
        for ((slug, entry) in leads) {
            val target = entry.leaderFqdn.lowercase()
            if (target !in known) continue
            out.getOrPut(target) { mutableListOf() }.add(slug)
        }
        return out.mapValues { (_, slugs) -> slugs.sorted() }
    }
}

/** In-memory mock: returns a configurable map (default null = "no fresher
 *  source"). Mirror of iOS `MockLeadsClient`. */
class MockLeadsClient(var result: LeadsMap? = null) : LeadsClient {
    val requested = mutableListOf<String>()
    override suspend fun fetchLeads(podFqdn: String): LeadsMap? {
        requested.add(podFqdn)
        return result
    }
}
