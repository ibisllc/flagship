// The security sliver (SECURITY-HARDENING-PLAN.md 18.14) and the owner's answer to a waiting
// publisher key (18.11). Kotlin mirror of FlagshipAPI/SecuritySliver.swift; vectors are
// packages/protocol/test-vectors/publisher-trust/vectors.json.

package com.flagshipserver.app.core

import com.flagshipserver.app.R
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
        for ((n, v) in listOf("oldKeyHex" to oldKeyHex, "newKeyHex" to newKeyHex)) {
            require(v.none { it == '|' || it.code <= 0x1f || it.code == 0x7f }) { "bad $n" }
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
    val TRUST get() = FSStrings.get(R.string.trust_this_new_key_for_this)
    val REJECT get() = FSStrings.get(R.string.reject_and_pause_updates)
    val CHAIN get() = FSStrings.get(R.string.the_old_key_vouched_for_the)
    val NO_CHAIN get() = FSStrings.get(R.string.the_old_key_did_not_vouch)
    val WARNING get() = FSStrings.get(R.string.if_this_is_unusual_do_not)
    val LOST_HISTORY get() = FSStrings.get(R.string.this_server_lost_its_list_of)

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
        fun count(id: Int, n: Long) = FSStrings.plural(id, n.toInt(), n)
        val body = when {
            a >= day -> count(R.plurals.days_count, a / day) + " " + count(R.plurals.hours_count, (a % day) / hour)
            a >= hour -> count(R.plurals.hours_count, a / hour) + " " + count(R.plurals.minutes_count, (a % hour) / min)
            else -> count(R.plurals.minutes_count, maxOf(1L, a / min))
        }
        return if (ms >= 0) FSStrings.get(R.string.left, body) else FSStrings.get(R.string.overdue_by, body)
    }
}
