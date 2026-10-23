// The owner's commitment to a workload key carried in an offline recipe
// (SECURITY-HARDENING-PLAN.md 3.13, SEC-RECIPE-001). Kotlin mirror of
// FlagshipCore/OfflineSecrets.swift and @flagship/protocol offlineSecrets.ts; the shared vectors
// are packages/protocol/test-vectors/offline-secrets/vectors.json.

package com.flagshipserver.app.core

import java.security.MessageDigest
import kotlinx.serialization.Serializable

@Serializable
data class OfflineSecretsCommitment(
    val serverDomain: String,
    val serial: String,
    val swkSha256Hex: String,
    val issuedAt: Long,
    val signatureHex: String,
) {
    companion object {
        const val TAG = "flagship/offline-secrets/v1"

        private fun guard(name: String, v: String) {
            require(v.isNotEmpty() && v.none { it == '|' || it.code <= 0x1f || it.code == 0x7f }) { "bad $name" }
        }

        fun commitmentTo(swkHex: String): String {
            val bytes = HexUtil.decode(swkHex.lowercase())
            require(bytes != null && bytes.size == 32) { "bad swkHex" }
            return HexUtil.encode(MessageDigest.getInstance("SHA-256").digest(bytes))
        }

        /** `flagship/offline-secrets/v1|<serverDomain lowercase>|<serial>|<swkSha256Hex>|<issuedAt>` */
        fun canonicalBytes(serverDomain: String, serial: String, swkSha256Hex: String, issuedAt: Long): ByteArray {
            guard("serverDomain", serverDomain)
            guard("serial", serial)
            require(Regex("^[0-9a-f]{64}$").matches(swkSha256Hex)) { "bad swkSha256Hex" }
            require(issuedAt >= 0) { "bad issuedAt" }
            return listOf(TAG, serverDomain.lowercase(), serial, swkSha256Hex, issuedAt.toString())
                .joinToString("|").toByteArray(Charsets.UTF_8)
        }

        fun sign(
            serverDomain: String,
            serial: String,
            swkHex: String,
            issuedAt: Long,
            signer: (ByteArray) -> ByteArray,
        ): OfflineSecretsCommitment {
            val sha = commitmentTo(swkHex)
            val sig = signer(canonicalBytes(serverDomain, serial, sha, issuedAt))
            return OfflineSecretsCommitment(serverDomain.lowercase(), serial, sha, issuedAt, HexUtil.encode(sig))
        }
    }
}
