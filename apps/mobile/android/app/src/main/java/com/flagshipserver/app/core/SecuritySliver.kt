// The security sliver (SECURITY-HARDENING-PLAN.md 18.14) and the owner's answer to a waiting
// publisher key (18.11). Kotlin mirror of FlagshipAPI/SecuritySliver.swift; vectors are
// packages/protocol/test-vectors/publisher-trust/vectors.json.

package com.flagshipserver.app.core

import kotlinx.serialization.Serializable
import kotlin.math.abs

@Serializable
data class SliverLine(
    val eventId: String,
    val issueKey: String,
    val kind: String,
    val severity: String,
    val target: String,
    val state: String,
    val summary: String,
    val updatedAt: Long,
    val remainingMs: Long? = null,
    val action: String? = null,
) {
    val isActive: Boolean get() = state == "active"
}

@Serializable
data class SecuritySliverResponse(
    val lines: List<SliverLine> = emptyList(),
    val lostHistory: Boolean = false,
)

@Serializable
data class PublisherTrust(
    val serviceId: String,
    val appId: String,
    val identityGeneration: Int,
    val oldKeyHex: String,
    val newKeyHex: String,
    val newEpoch: Int,
    val issuedAt: Long,
) {
    fun canonicalBytes(): ByteArray {
        for ((n, v) in listOf("serviceId" to serviceId, "appId" to appId)) {
            require(v.isNotEmpty() && v.none { it == '|' || it.code <= 0x1f || it.code == 0x7f }) { "bad $n" }
        }
        return listOf(TAG, serviceId, appId, identityGeneration.toString(), oldKeyHex, newKeyHex, newEpoch.toString(), issuedAt.toString())
            .joinToString("|").toByteArray(Charsets.UTF_8)
    }

    fun sign(signer: (ByteArray) -> ByteArray): String = HexUtil.encode(signer(canonicalBytes()))

    companion object {
        const val TAG = "flagship/publisher-trust/v1"
    }
}

@Serializable
data class WaitingPublisherResponse(
    val pinned: Pinned? = null,
    val waiting: Waiting? = null,
) {
    @Serializable
    data class Pinned(val fingerprint: String, val epoch: Int)

    @Serializable
    data class Waiting(
        val continuity: String,
        val oldFingerprint: String,
        val newFingerprint: String,
        val newEpoch: Int,
        val rejected: Boolean = false,
        val trust: PublisherTrust? = null,
    )
}

@Serializable
data class PublisherTrustBody(val trust: PublisherTrust, val signatureHex: String)

object SliverWords {
    const val HEADING = "Security"
    const val TRUST = "Trust this new key for this service"
    const val REJECT = "Reject and pause updates"
    const val CHAIN = "The old key vouched for the new one."
    const val NO_CHAIN = "The old key did not vouch for the new one. Treat this as a different publisher using the same name."
    const val WARNING = "If this is unusual, do not trust the new key. Updates from this publisher stay paused until you decide."
    const val LOST_HISTORY = "This server lost its list of security notices and started over. Check each service and your recovery settings."

    fun severityLabel(s: String): String = when (s) {
        "critical" -> "Critical"
        "high" -> "High"
        "moderate" -> "Moderate"
        "low" -> "Low"
        else -> s
    }

    fun remaining(ms: Long?): String {
        if (ms == null) return ""
        val a = abs(ms)
        val day = 86_400_000L
        val hour = 3_600_000L
        val min = 60_000L
        val body = when {
            a >= day -> "${a / day} day${if (a / day == 1L) "" else "s"} ${(a % day) / hour} hours"
            a >= hour -> "${a / hour} hour${if (a / hour == 1L) "" else "s"} ${(a % hour) / min} minutes"
            else -> { val m = maxOf(1L, a / min); "$m minute${if (m == 1L) "" else "s"}" }
        }
        return if (ms >= 0) "$body left" else "overdue by $body"
    }
}
