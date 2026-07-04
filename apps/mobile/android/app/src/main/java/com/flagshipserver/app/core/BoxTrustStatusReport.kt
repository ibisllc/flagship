// Kotlin mirror of packages/protocol/src/boxTrustStatus.ts — the STK-signed
// PER-BOX relay-trust verdict.
//
// Each box independently verifies the ServiceBlessing it is handed by the
// `.services` hub; that verdict is genuinely per-box. The daemon signs this
// tuple with its STK (Ed25519); `.com` relays it VERBATIM on `/pods`
// (`trustStatus: { report, signatureHex }`). A phone that derives the box STK
// locally (ServerKeys.deriveStkPub — NOT `.com`'s echo) re-verifies it
// end-to-end, so a rogue `.com` can DROP a report but cannot FORGE one: the
// per-server warning a client renders is the box's own word.
//
// SIBLING of DaemonStatusReport — do NOT fold together. Canonical bytes MUST
// match the TS implementation byte-for-byte (pinned cross-platform vector in
// packages/protocol/tests/boxTrustStatus.test.ts + BoxTrustStatusReportTest):
//
//   flagship/box-trust-status/v1|<serverDomain>|<relayVerdict>|
//   <lockedDown "1"|"0">|<failingCertHash or "">|
//   <coveringExceptionCertHash or "">|<nonce>|<issuedAt>

package com.flagshipserver.app.core

import com.google.crypto.tink.subtle.Ed25519Verify

object BoxTrustStatusReport {
    const val CANONICAL_TAG = "flagship/box-trust-status/v1"

    /** Freshness bound on a relayed report, mirroring DaemonStatusReport. */
    const val MAX_REPORT_AGE_MS: Long = 7L * 24 * 60 * 60 * 1000

    /** The box's verdict on the relay-class (`.services` hub) blessing. */
    enum class RelayVerdict(val wire: String) {
        TRUSTED("trusted"),
        UNTRUSTED("untrusted"),
        UNKNOWN("unknown"),
        ;

        companion object {
            fun fromWire(s: String): RelayVerdict? = entries.firstOrNull { it.wire == s }
        }
    }

    data class Report(
        val serverDomain: String,
        val relayVerdict: RelayVerdict,
        val lockedDown: Boolean,
        /** relay-class cert-hash of the offending hub key, when untrusted. */
        val failingCertHash: String?,
        /** relay-class cert-hash of the owner TrustException that lifted the
         *  failing verdict, when an override is in force. */
        val coveringExceptionCertHash: String?,
        val nonce: String,
        val issuedAt: Long,
    )

    fun canonicalBytes(r: Report): ByteArray = listOf(
        CANONICAL_TAG,
        r.serverDomain,
        r.relayVerdict.wire,
        if (r.lockedDown) "1" else "0",
        r.failingCertHash ?: "",
        r.coveringExceptionCertHash ?: "",
        r.nonce,
        r.issuedAt.toString(),
    ).joinToString("|").toByteArray(Charsets.UTF_8)

    /** Verify the box's signature under its (locally derived) STK pubkey.
     *  Returns false — never throws — on malformed input. */
    fun verify(r: Report, signature: ByteArray, stkPub: ByteArray): Boolean = try {
        Ed25519Verify(stkPub).verify(signature, canonicalBytes(r))
        true
    } catch (_: Throwable) {
        false
    }
}
