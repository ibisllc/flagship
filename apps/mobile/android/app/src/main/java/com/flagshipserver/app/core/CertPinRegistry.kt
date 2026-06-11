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
// Any failure ⇒ NO pin for that box (default TLS validation stands) and the
// list rendering is never affected. With a pin, enforcement is HARD-FAIL
// (locked decision): see CertPinInterceptor.
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

    /**
     * Reconcile the registry against a fresh `/pods` response — the user's
     * FULL registered-server directory, so this is a full replace: a pod
     * whose report fails verification loses its pin (a renewal whose new
     * report hasn't verified yet falls back to default validation rather
     * than hard-failing on the old pin), and a domain absent from the list
     * entirely (released / decommissioned) is unpinned too, so a stale pin
     * can never strand a hard-fail. Never throws — a malformed entry simply
     * yields no pin.
     */
    fun update(
        pods: List<PodDirectoryEntry>,
        umkSeed: ByteArray,
        nowMs: Long = System.currentTimeMillis(),
    ) {
        val next = mutableMapOf<String, String>()
        for (pod in pods) {
            val domain = pod.serverDomain.trim().lowercase()
            if (domain.isEmpty()) continue
            val pin = try {
                verifiedPinFor(pod, umkSeed, nowMs)
            } catch (_: Throwable) {
                null
            }
            if (pin != null) next[domain] = pin
        }
        synchronized(pins) {
            pins.clear()
            pins.putAll(next)
        }
    }

    private fun verifiedPinFor(pod: PodDirectoryEntry, umkSeed: ByteArray, nowMs: Long): String? {
        if (pod.revokedAt != null) return null
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

    fun clear() {
        synchronized(pins) { pins.clear() }
    }
}

/** The pure accept/refuse decision, factored out of the TLS glue so it is
 *  unit-testable. HARD-FAIL semantics (locked): a host with a pin is refused
 *  unless the served leaf cert's DER SHA-256 equals the pin; a host with no
 *  pin keeps default validation. */
object CertPinDecision {
    fun accept(
        leafDerSha256Hex: String?,
        host: String,
        pinFor: (String) -> String?,
    ): Boolean {
        val pin = pinFor(host) ?: return true
        val leaf = leafDerSha256Hex ?: return false
        return leaf.equals(pin, ignoreCase = true)
    }
}
