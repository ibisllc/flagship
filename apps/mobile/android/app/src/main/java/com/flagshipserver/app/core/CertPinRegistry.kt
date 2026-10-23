// Cert-fingerprint pin registry (cert-model A′, phase 4) — the phone-side
// half of "the client pins the box's real cert fingerprint and rejects
// anything else".
//
// Populated from `/pods` responses: each pod may carry the box's STK-signed
// daemon-status report relayed VERBATIM (`signedStatus`). A pin is recorded
// for the box FQDN only when ALL of these hold:
//   - the STK pubkey derived LOCALLY from the phone's UMK
//     (ServerKeys.deriveStkPub — `.com`'s identityPubKey echo is NOT a trust
//     input) verifies the report signature,
//   - the report's serverDomain matches the pod's domain,
//   - the report is fresh (issuedAt within MAX_REPORT_AGE_MS),
//   - the report carries a well-formed certSha256 (64 hex).
// Any failure ⇒ no FRESH pin for that box — but a previously-verified pin is
// RETAINED across a failed/missing/stale report while the pod stays listed
// (keep-last-known-good; see `update`), so a hostile or transient daemon-status
// can't downgrade a known box to default TLS where a CA-valid rogue cert would
// pass. A pin is dropped only on an explicit revoke or on the pod leaving the
// directory. The list rendering is never affected. With a pin, enforcement is
// HARD-FAIL (locked decision): see CertPinInterceptor.
//
// A service host `x.<server>.<user>.flagship.services` pins to the box's
// fingerprint — the per-box wildcard `*.<server>.<user>` is the same cert.

package com.flagshipserver.app.core

import com.flagshipserver.app.api.PodDirectoryEntry

class CertPinRegistry {
    companion object {
        /** Process-wide registry consulted by the shared OkHttp client. */
        val shared = CertPinRegistry()
        private val HEX64 = Regex("^[0-9a-f]{64}$")
    }

    /** box FQDN (lowercase) → leaf-cert DER SHA-256 (lowercase hex). */
    private val pins = mutableMapOf<String, String>()

    /** Every box in the directory the last time it was read: the hosts a request may not reach on ordinary web trust. */
    private val known = mutableSetOf<String>()

    /** host → epoch ms until which one named box may be reached before its first signed status (enrollment). */
    private val enrollment = mutableMapOf<String, Long>()

    /** Where pins and the known-box list survive a restart; null in tests. */
    interface Persistence {
        fun load(): Pair<Map<String, String>, Set<String>>
        fun save(pins: Map<String, String>, known: Set<String>)
    }

    private var persistence: Persistence? = null

    /** Load what the last run learned, so a cold start does not begin with no pins at all. */
    fun attach(store: Persistence) {
        synchronized(pins) {
            persistence = store
            val (p, k) = try { store.load() } catch (_: Throwable) { emptyMap<String, String>() to emptySet<String>() }
            for ((d, pin) in p) if (HEX64.matches(pin)) pins.putIfAbsent(d.lowercase(), pin.lowercase())
            known.addAll(k.map { it.lowercase() })
        }
    }

    private fun persistLocked() {
        try { persistence?.save(pins.toMap(), known.toSet()) } catch (_: Throwable) { /* best effort */ }
    }

    /** True when [host] is a box this phone knows (the box itself or any name under its wildcard). */
    fun isKnownBox(host: String, nowMs: Long = System.currentTimeMillis()): Boolean {
        val h = host.trim().trimEnd('.').lowercase()
        if (h.isEmpty()) return false
        synchronized(pins) {
            if (nowMs < (enrollment[h] ?: 0L)) return false
            return known.any { h == it || h.endsWith(".$it") }
        }
    }

    /** The one narrow window for reaching a freshly created box before it has a signed status (SECURITY-HARDENING-PLAN.md 7.1). */
    fun allowUnpinnedEnrollment(host: String, forSeconds: Long = 120, nowMs: Long = System.currentTimeMillis()) {
        val h = host.trim().trimEnd('.').lowercase()
        if (h.isEmpty()) return
        synchronized(pins) { enrollment[h] = nowMs + minOf(forSeconds, 300L) * 1000 }
    }

    /**
     * Reconcile the registry against a fresh `/pods` response — the user's
     * FULL registered-server directory. Per pod, the outcome is one of three
     * (SEC: keep the last-known-good pin — a failed/absent verification of a
     * STILL-LISTED pod must NOT downgrade it to default TLS, or a CA-valid
     * rogue cert would pass on the next connection):
     *   - report VERIFIES ⇒ SET/REPLACE the pin (covers a legit renewal whose
     *     new fingerprint just verified).
     *   - report FAILS to verify / missing / stale, pod still LISTED ⇒ RETAIN
     *     the existing pin (a transient/tampered report can't strip a known
     *     box of its pin). This is the security fix.
     *   - pod REVOKED ⇒ DROP the pin (an explicit, signed-list drop signal).
     *   - pod ABSENT from the directory entirely (released / decommissioned)
     *     ⇒ DROP the pin (prune-on-absence; it is genuinely gone).
     * Never throws — a malformed entry is treated as "no fresh pin", i.e.
     * RETAIN if the pod is still listed.
     */
    fun update(
        pods: List<PodDirectoryEntry>,
        umkSeed: ByteArray,
        nowMs: Long = System.currentTimeMillis(),
    ) {
        synchronized(pins) {
            val next = mutableMapOf<String, String>()
            val listed = mutableSetOf<String>()
            for (pod in pods) {
                val domain = pod.serverDomain.trim().lowercase()
                if (domain.isEmpty()) continue
                listed.add(domain)

                if (pod.revokedAt != null) {
                    // Explicit drop signal — do NOT carry the old pin forward.
                    continue
                }

                val fresh = try {
                    verifiedPinFor(pod, umkSeed, nowMs)
                } catch (_: Throwable) {
                    null
                }
                when {
                    // Legit cert renewal (or first verification): set/replace.
                    fresh != null -> next[domain] = fresh
                    // Present but unverified/missing/stale: keep the
                    // last-known-good pin so a hostile/transient report can't
                    // strip a known box back to default TLS.
                    pins.containsKey(domain) -> next[domain] = pins.getValue(domain)
                    // Present, never had a pin, nothing to verify: stays
                    // unpinned (default TLS validation).
                }
            }
            // Anything not in `next` is either absent from the directory
            // (decommissioned) or revoked — both genuinely drop.
            pins.clear()
            pins.putAll(next)
            known.clear()
            known.addAll(listed - pods.filter { it.revokedAt != null }.map { it.serverDomain.trim().lowercase() }.toSet())
            persistLocked()
        }
    }

    private fun verifiedPinFor(pod: PodDirectoryEntry, umkSeed: ByteArray, nowMs: Long): String? {
        val signed = pod.signedStatus ?: return null
        val wire = signed.report ?: return null
        val sig = HexUtil.decode(signed.signatureHex) ?: return null
        // The signed report must be ABOUT this pod — a valid report for some
        // other box must not pin this one.
        if (!wire.serverDomain.equals(pod.serverDomain, ignoreCase = true)) return null
        val report = DaemonStatusReport.Report(
            serverDomain = wire.serverDomain,
            certSha256 = wire.certSha256,
            certValidUntil = wire.certValidUntil,
            certIssuer = wire.certIssuer,
            appsServed = wire.appsServed,
            nonce = wire.nonce,
            issuedAt = wire.issuedAt,
        )
        // Trust anchor: the STK derived from the phone's own UMK.
        val stkPub = ServerKeys.deriveStkPub(umkSeed, pod.serverDomain)
        if (!DaemonStatusReport.verify(report, sig, stkPub)) return null
        if (nowMs - report.issuedAt > DaemonStatusReport.MAX_REPORT_AGE_MS) return null
        val pin = report.certSha256?.lowercase() ?: return null
        if (!HEX64.matches(pin)) return null
        return pin
    }

    /**
     * The pin governing `host`, or null when no verified pin exists (⇒
     * default TLS validation stands). Matches the box FQDN exactly OR any
     * host under it (`<service>.<server>.<user>` rides the box wildcard).
     */
    fun pinFor(host: String): String? {
        val h = host.trim().trimEnd('.').lowercase()
        if (h.isEmpty()) return null
        synchronized(pins) {
            pins[h]?.let { return it }
            for ((domain, pin) in pins) {
                if (h.endsWith(".$domain")) return pin
            }
        }
        return null
    }

    /** One verified box name and its pin, for testing a relay address against a box that is known, or null. */
    fun anyPin(): Pair<String, String>? = synchronized(pins) { pins.entries.firstOrNull()?.let { it.key to it.value } }

    fun clear() {
        synchronized(pins) { pins.clear(); known.clear(); enrollment.clear(); persistLocked() }
    }
}

/** The pure accept/refuse decision, factored out of the TLS glue so it is
 *  unit-testable. HARD-FAIL semantics (locked): a host with a pin is refused
 *  unless the served leaf cert's DER SHA-256 equals the pin; a host with no
 *  pin keeps default validation. */
object CertPinDecision {
    /**
     * [isKnownBox] says the host is one of this phone's boxes. Such a host with no verified pin is
     * refused, never let through on ordinary web trust (SECURITY-HARDENING-PLAN.md 7.1).
     */
    fun accept(
        leafDerSha256Hex: String?,
        host: String,
        pinFor: (String) -> String?,
        isKnownBox: (String) -> Boolean = { false },
    ): Boolean {
        val pin = pinFor(host) ?: return !isKnownBox(host)
        val leaf = leafDerSha256Hex ?: return false
        return leaf.equals(pin, ignoreCase = true)
    }
}
