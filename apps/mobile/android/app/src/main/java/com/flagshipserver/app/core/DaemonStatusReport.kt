// Kotlin mirror of packages/protocol/src/daemonStatus.ts — the STK-signed
// daemon-status report, the cert-fingerprint pinning primitive (cert-model
// A′, phase 4).
//
// The box signs the tuple with its STK (Ed25519); `.com` relays it VERBATIM
// on `/pods` (`signedStatus: { report, signatureHex }`). A phone that derives
// the box STK locally (ServerKeys.deriveStkPub — NOT `.com`'s identityPubKey
// echo) re-verifies the leaf-cert fingerprint end-to-end, so a rogue `.com`
// can DROP a report but cannot FORGE one.
//
// Canonical bytes MUST match the TS implementation byte-for-byte (pinned
// cross-platform vector in packages/protocol/tests/daemonStatus.test.ts +
// DaemonStatusReportTest here):
//
//   flagship/daemon-status/v1|<serverDomain>|<certSha256 or "">|
//   <certValidUntil or "">|<certIssuer or "">|<appsServed sorted, ","-joined>|
//   <nonce>|<issuedAt>

package com.flagshipserver.app.core

import com.google.crypto.tink.subtle.Ed25519Verify

object DaemonStatusReport {
    const val CANONICAL_TAG = "flagship/daemon-status/v1"

    /** Freshness bound on a relayed report: older than this and the
     *  fingerprint is NOT pinned (a stale fingerprint must never pin a
     *  legitimately renewed cert out of existence). */
    const val MAX_REPORT_AGE_MS: Long = 7L * 24 * 60 * 60 * 1000

    data class Report(
        val serverDomain: String,
        /** Leaf-cert SHA-256 fingerprint: lowercase hex, no colons. Null when
         *  the box has no cert yet (liveness-only report). */
        val certSha256: String?,
        val certValidUntil: Long?,
        val certIssuer: String?,
        val appsServed: List<String>,
        val nonce: String,
        val issuedAt: Long,
    )

    fun canonicalBytes(r: Report): ByteArray = listOf(
        CANONICAL_TAG,
        r.serverDomain,
        r.certSha256 ?: "",
        r.certValidUntil?.toString() ?: "",
        r.certIssuer ?: "",
        r.appsServed.sorted().joinToString(","),
        r.nonce,
        r.issuedAt.toString(),
    ).joinToString("|").toByteArray(Charsets.UTF_8)

    /** Verify the box's signature under its (locally derived) STK pubkey.
     *  Returns false — never throws — on malformed input, mirroring the TS
     *  verifyDaemonStatusReport. */
    fun verify(r: Report, signature: ByteArray, stkPub: ByteArray): Boolean = try {
        Ed25519Verify(stkPub).verify(signature, canonicalBytes(r))
        true
    } catch (_: Throwable) {
        false
    }
}
