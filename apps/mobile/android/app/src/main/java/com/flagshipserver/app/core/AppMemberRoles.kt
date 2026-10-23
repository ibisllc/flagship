package com.flagshipserver.app.core

import com.google.crypto.tink.subtle.Ed25519Sign

/**
 * Access control ranks (docs/service-access-gating.md, "Account members, ranks
 * and who may change them"): member < manager < master, ordered and
 * cumulative; there is no owner rank (a legacy "owner" from a server reads as
 * master). Apps enforce them. `wire` is what the box and the signed order
 * carry; [label] is the ONE place their display names live on Android. Master
 * is shown with a crown.
 */
enum class AppMemberRole(val wire: String) {
    MEMBER("member"),
    MANAGER("manager"),
    MASTER("master");

    val label: String
        get() = when (this) {
            MEMBER -> "Member"
            MANAGER -> "Manager"
            MASTER -> "Master"
        }

    val crowned: Boolean get() = this == MASTER

    /** Manager or Master: may invite (at Member) from a device that isn't an admin. */
    val managerClass: Boolean get() = this != MEMBER

    companion object {
        fun fromWire(s: String?): AppMemberRole? =
            if (s == "owner") MASTER else entries.firstOrNull { it.wire == s }
    }
}

/**
 * The admin-only orders over one app's access, naming the app (its
 * `serviceRef`, the same on every server of the account) and signed with the
 * admin root:
 *
 *   flagship/app-rank/v1|<serviceRef>|<target>|<rank>|<issuedAt>
 *   flagship/service-access-mode/v2|<serviceRef>|<open|restricted>|<issuedAt>
 *   flagship/service-allow-remove/v2|<serviceRef>|<aid hex>|<issuedAt>
 *   flagship/restored-access-approve/v1|<serviceRef>|<draftSha256 hex>|<issuedAt>
 *
 * packages/protocol/test-vectors/app-access-orders/vectors.json is the
 * reference; AppAccessOrdersVectorsTest runs every case and every refusal.
 */
object AppAccessOrders {
    const val TAG_RANK = "flagship/app-rank/v1"
    const val TAG_MODE = "flagship/service-access-mode/v2"
    const val TAG_REMOVE = "flagship/service-allow-remove/v2"
    const val TAG_RESTORED_APPROVE = "flagship/restored-access-approve/v1"
    const val REFUSED = "refused"

    data class Rank(val serviceRef: String, val target: String, val rank: String, val issuedAt: Long)
    data class Mode(val serviceRef: String, val mode: String, val issuedAt: Long)
    data class Remove(val serviceRef: String, val aid: String, val issuedAt: Long)

    /** An admin's approval of the permissions a restore held back: names the app and the exact draft's SHA-256. */
    data class RestoredApprove(val serviceRef: String, val draftSha256: String, val issuedAt: Long)

    private val SERVICE_REF = Regex("^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$")
    private val HEX64 = Regex("^[0-9a-f]{64}$")
    private val DEVICE = Regex("^device:[0-9a-f]{64}$")
    private val SHARE = Regex("^share:[0-9a-f]{32}$")
    private val AID = Regex("^aid:[0-9a-f]{64}$")
    private val INVITE = Regex("^invite:[A-Za-z0-9._-]{1,128}$")
    private val GRANT = Regex("^grant:[A-Za-z0-9._-]{1,128}/[0-9a-f]{64}$")

    fun deviceTarget(pubHex: String): String = "device:${pubHex.lowercase()}"
    fun shareTarget(shareId: String): String = "share:${shareId.lowercase()}"
    fun aidTarget(aidHex: String): String = "aid:${aidHex.lowercase()}"
    fun inviteTarget(inviteId: String): String = "invite:$inviteId"
    fun grantTarget(inviteId: String, aidHex: String): String = "grant:$inviteId/${aidHex.lowercase()}"

    private fun checkRef(ref: String) = require(SERVICE_REF.matches(ref)) { "bad serviceRef" }
    private fun checkAt(at: Long) = require(at >= 0) { "bad issuedAt" }
    private fun join(vararg parts: String) = parts.joinToString("|").toByteArray(Charsets.UTF_8)

    fun canonicalBytes(o: RestoredApprove): ByteArray {
        checkRef(o.serviceRef)
        require(HEX64.matches(o.draftSha256)) { "bad draftSha256" }
        checkAt(o.issuedAt)
        return join(TAG_RESTORED_APPROVE, o.serviceRef, o.draftSha256, o.issuedAt.toString())
    }

    /** Throws for an order the box would refuse (never sign one). */
    fun canonicalBytes(o: Rank): ByteArray {
        checkRef(o.serviceRef)
        val accountTarget = DEVICE.matches(o.target) || SHARE.matches(o.target)
        require(accountTarget || AID.matches(o.target) || INVITE.matches(o.target) || GRANT.matches(o.target)) { "bad target" }
        require(o.rank == REFUSED || AppMemberRole.entries.any { it.wire == o.rank }) { "bad rank" }
        require(o.rank != REFUSED || accountTarget) { "only a device or a co-manager can be refused" }
        checkAt(o.issuedAt)
        return join(TAG_RANK, o.serviceRef, o.target, o.rank, o.issuedAt.toString())
    }

    fun canonicalBytes(o: Mode): ByteArray {
        checkRef(o.serviceRef)
        require(o.mode == "open" || o.mode == "restricted") { "bad mode" }
        checkAt(o.issuedAt)
        return join(TAG_MODE, o.serviceRef, o.mode, o.issuedAt.toString())
    }

    fun canonicalBytes(o: Remove): ByteArray {
        checkRef(o.serviceRef)
        require(HEX64.matches(o.aid)) { "aid must be 64 lowercase hex" }
        checkAt(o.issuedAt)
        return join(TAG_REMOVE, o.serviceRef, o.aid, o.issuedAt.toString())
    }

    fun signHex(key: Ed25519Sign, o: Rank): String = HexUtil.encode(key.sign(canonicalBytes(o)))
    fun signHex(key: Ed25519Sign, o: Mode): String = HexUtil.encode(key.sign(canonicalBytes(o)))
    fun signHex(key: Ed25519Sign, o: Remove): String = HexUtil.encode(key.sign(canonicalBytes(o)))
}
