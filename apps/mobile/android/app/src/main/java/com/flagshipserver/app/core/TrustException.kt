// Kotlin mirror of FlagshipCore/TrustException.swift.
//
// An owner-signed, per-cert trust EXCEPTION — the recovery primitive for the
// maintainer-trust gate. When the control-server (or relay) blessing fails
// verification and the owner deliberately chooses to proceed anyway, the
// granting phone signs this with its device key (the biometric-gated IRK),
// scoped to EXACTLY one cert-hash. Safe to route through a possibly-rogue
// `.com`: device-key-signed + cert-hash-scoped, so `.com` can drop/replay but
// not forge it (replaying "accept cert X" is harmless).
//
// Canonical bytes (byte-identical TS / Swift / Kotlin):
//
//   flagship/trust-exception/v1|<certClass>|<certHash>|<grantedAt>|<grantedByDevicePub>

package com.flagshipserver.app.core

import java.security.MessageDigest

/** Which blessing an exception covers — control-server or relay. */
enum class TrustCertClass(val wire: String) {
    CONTROL("control"),
    RELAY("relay"),
}

object TrustException {
    const val CANONICAL_TAG = "flagship/trust-exception/v1"

    /** sha256hex(utf8(caPubkey)) — the cert-hash slug source. Lower-case hex. */
    fun certHashForCaPubkey(caPubkey: String): String =
        MessageDigest.getInstance("SHA-256")
            .digest(caPubkey.toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it) }

    fun canonicalBytes(
        certClass: TrustCertClass,
        certHash: String,
        grantedAt: Long,
        grantedByDevicePub: String,
    ): ByteArray = listOf(
        CANONICAL_TAG,
        certClass.wire,
        certHash,
        grantedAt.toString(),
        grantedByDevicePub,
    ).joinToString("|").toByteArray(Charsets.UTF_8)
}
