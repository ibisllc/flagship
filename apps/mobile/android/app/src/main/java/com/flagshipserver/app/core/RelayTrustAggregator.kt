// Per-cert RELAY-trust aggregation (maintainer-trust Layer 3) — the Kotlin
// mirror of FlagshipCore/RelayTrustAggregator.swift.
//
// The unit is the FAULTY CERTIFICATE (cert-hash), NOT the box. Each box signs a
// `flagship/box-trust-status/v1` verdict with its STK; `.com` relays it on
// `/pods` as `trustStatus`. This aggregator re-verifies EACH under the pod's
// `identityPubKey` (the registered STK) — a relayed report whose signature does
// not verify is DROPPED, so a rogue `.com` can drop but not forge a verdict —
// then folds the untrusted ones BY `failingCertHash` across all pods into ONE
// entry per DISTINCT faulty relay authority, spanning every affected server.
// One owner exception for the cert-hash is fanned out by `.com` and satisfies
// all of them at once.

package com.flagshipserver.app.core

import com.flagshipserver.app.api.PodDirectoryEntry
import com.flagshipserver.app.core.BoxTrustStatusReport.RelayVerdict

/** One DISTINCT faulty relay authority, aggregated across a user's pods. */
data class RelayCertFailure(
    /** relay-class cert-hash of the failing hub key (64-hex). */
    val certHash: String,
    /** The affected server domains (sorted, deduped) — "which/how-many servers". */
    val servers: List<String>,
    /** Standing "operating under admin override" marker, driven from the
     *  RELAYED wire field `coveringExceptionCertHash` (a covered box keeps
     *  reporting `untrusted` for the cert but names it as covered). Persists
     *  until a fresh valid blessing clears the box's verdict. */
    val overridden: Boolean,
) {
    val id: String get() = "relay:$certHash"
    val serverCount: Int get() = servers.size
    /** First 8 hex — the sliver slug (shared cross-surface contract). */
    val slug: String get() = certHash.take(8)
    val label: String get() = "Relay certificate expired · $slug"

    /** The failing cert as a TrustException-signable descriptor (certClass
     *  RELAY; caPubkey is unused for relay — the cert-hash IS the anchor). */
    val trustFailure: TrustFailure
        get() = TrustFailure(certClass = TrustCertClass.RELAY, certHash = certHash, caPubkey = "")
}

object RelayTrustAggregator {
    private val HEX64 = Regex("^[0-9a-fA-F]{64}$")

    /** Verify + aggregate the per-box relay verdicts across a `/pods` list. */
    fun aggregate(pods: List<PodDirectoryEntry>): List<RelayCertFailure> {
        val servers = LinkedHashMap<String, MutableList<String>>()
        val overridden = HashMap<String, Boolean>()

        for (pod in pods) {
            val ts = pod.trustStatus ?: continue
            val wire = ts.report ?: continue
            val stk = HexUtil.decode(pod.identityPubKey)
            if (stk == null || stk.size != 32) continue
            val sig = HexUtil.decode(ts.signatureHex) ?: continue
            val verdict = RelayVerdict.fromWire(wire.relayVerdict) ?: continue
            val report = BoxTrustStatusReport.Report(
                serverDomain = wire.serverDomain,
                relayVerdict = verdict,
                lockedDown = wire.lockedDown,
                failingCertHash = wire.failingCertHash,
                coveringExceptionCertHash = wire.coveringExceptionCertHash,
                nonce = wire.nonce,
                issuedAt = wire.issuedAt,
            )
            // A box's trust claim must be AUTHENTICATED, not trusted blindly.
            if (!BoxTrustStatusReport.verify(report, sig, stk)) continue
            if (verdict != RelayVerdict.UNTRUSTED) continue
            val certHash = report.failingCertHash ?: continue
            if (!HEX64.matches(certHash)) continue

            val list = servers.getOrPut(certHash) { mutableListOf() }
            val domain = report.serverDomain.ifEmpty { pod.serverDomain }
            if (domain.isNotEmpty() && domain !in list) list.add(domain)
            // Wire-driven standing override marker.
            if (report.coveringExceptionCertHash == certHash) {
                overridden[certHash] = true
            } else {
                overridden.putIfAbsent(certHash, false)
            }
        }

        return servers.keys.sorted().map { certHash ->
            RelayCertFailure(
                certHash = certHash,
                servers = (servers[certHash] ?: emptyList()).sorted(),
                overridden = overridden[certHash] ?: false,
            )
        }
    }
}
