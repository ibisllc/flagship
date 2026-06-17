// Kotlin mirror of FlagshipCore/TrustCenter.swift.
//
// App-wide maintainer-trust verdict + the failing-cert registry that drives
// the red persistent sliver. Mirrors the ActiveOperationsCenter pattern: a
// StateFlow-backed singleton provided at the App scope, the single source of
// truth the trust sliver + the backend short-circuit read.

package com.flagshipserver.app.core

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/** One control-/relay-blessing failure — a single failing CA cert, slugged by
 *  its cert-hash. The red sliver renders ONE line per failing cert; the line
 *  persists even after the owner overrides (overriding only un-halts traffic). */
data class TrustFailure(
    val certClass: TrustCertClass,
    /** sha256hex(utf8(caPubkey)) — lower-case hex. */
    val certHash: String,
    /** The served CA pubkey (hex) this failure was raised against. */
    val caPubkey: String,
) {
    val id: String get() = "${certClass.wire}:$certHash"

    /** First 8 hex of the cert-hash — the sliver slug. */
    val slug: String get() = certHash.take(8)

    /** The sliver line — one canonical shape per class. */
    val label: String
        get() = when (certClass) {
            TrustCertClass.CONTROL -> "Control server certificate expired · $slug"
            TrustCertClass.RELAY -> "Relay certificate expired · $slug"
        }
}

enum class TrustVerdict { UNKNOWN, TRUSTED, UNTRUSTED }

/**
 * App-wide trust verdict + failing-cert registry.
 *
 * - UNKNOWN — no valid /api/maintainer-blessing response evaluated yet (cold
 *   start, or a NETWORK error). NOT a halt.
 * - TRUSTED — the last valid blessing verified.
 * - UNTRUSTED — the last valid blessing FAILED verification.
 *
 * [isServerTrusted] is false ONLY when the verdict is UNTRUSTED AND at least
 * one failing cert is un-overridden. While false, all backend interaction is
 * short-circuited.
 */
class TrustCenter {
    private val _verdict = MutableStateFlow(TrustVerdict.UNKNOWN)
    val verdict: StateFlow<TrustVerdict> = _verdict.asStateFlow()

    private val _failures = MutableStateFlow<List<TrustFailure>>(emptyList())
    val failures: StateFlow<List<TrustFailure>> = _failures.asStateFlow()

    private val _overridden = MutableStateFlow<Set<String>>(emptySet())
    val overriddenCertHashes: StateFlow<Set<String>> = _overridden.asStateFlow()

    /** True unless we positively know the control server is UNTRUSTED AND at
     *  least one failing cert is still un-overridden. UNKNOWN + TRUSTED both
     *  let traffic through. Overriding every failing cert flips this back to
     *  true (traffic resumes; the red sliver persists). */
    val isServerTrusted: Boolean
        get() {
            if (_verdict.value != TrustVerdict.UNTRUSTED) return true
            return _failures.value.none { it.certHash !in _overridden.value }
        }

    /** The sliver shows nothing once the verdict isn't UNTRUSTED; while
     *  untrusted it shows one line per failing cert, even after override. */
    val sliverFailures: List<TrustFailure>
        get() = if (_verdict.value == TrustVerdict.UNTRUSTED) _failures.value else emptyList()

    /** A valid blessing verified — clear the failure state. */
    fun markTrusted() {
        if (_verdict.value != TrustVerdict.TRUSTED) _verdict.value = TrustVerdict.TRUSTED
        if (_failures.value.isNotEmpty()) _failures.value = emptyList()
    }

    /** A valid blessing FAILED — record the failing cert(s). Idempotent; dedups
     *  by id (class+certHash); control + relay can both fail at once. Overrides
     *  for certs no longer failing are pruned. */
    fun markUntrusted(newFailures: List<TrustFailure>) {
        val merged = ArrayList<TrustFailure>()
        val seen = HashSet<String>()
        for (f in newFailures) {
            if (seen.add(f.id)) merged.add(f)
        }
        if (_verdict.value != TrustVerdict.UNTRUSTED) _verdict.value = TrustVerdict.UNTRUSTED
        if (merged != _failures.value) _failures.value = merged
        val live = merged.map { it.certHash }.toSet()
        val kept = _overridden.value.intersect(live)
        if (kept != _overridden.value) _overridden.value = kept
    }

    /** A NETWORK error — no verdict. Leaves any existing verdict UNTOUCHED so a
     *  previously-known UNTRUSTED keeps halting; never bricks on a network
     *  failure. */
    fun markNoVerdict() {}

    /** Record that the owner signed a TrustException for [certHash]. The
     *  failure line stays visible; traffic for that cert resumes. */
    fun recordOverride(certHash: String) {
        if (certHash !in _overridden.value) {
            _overridden.value = _overridden.value + certHash
        }
    }

    /** Is [certHash] still blocking traffic (failing AND not overridden)? */
    fun isBlocking(certHash: String): Boolean =
        _verdict.value == TrustVerdict.UNTRUSTED &&
            _failures.value.any { it.certHash == certHash } &&
            certHash !in _overridden.value
}
