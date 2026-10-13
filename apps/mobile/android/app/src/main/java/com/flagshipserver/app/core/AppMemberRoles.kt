package com.flagshipserver.app.core

import com.google.crypto.tink.subtle.Ed25519Sign

/**
 * Access control ranks (docs/service-access-gating.md, "Open mode + members"):
 * member < manager < master, ordered and cumulative (the box owner is always
 * owner and never given); apps enforce them. `wire` is what the box and the
 * signed order carry; [label] is the ONE place their display names live on
 * Android. Master is shown with a crown.
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

    companion object {
        fun fromWire(s: String?): AppMemberRole? = entries.firstOrNull { it.wire == s }
    }
}

/**
 * The owner's order giving an invite (`invite:<inviteId>`), one person's join
 * through it (`grant:<inviteId>/<aid>`) or a member (`aid:<hex>`) a rank,
 * signed with the sensitive-order key:
 *
 *   flagship/app-member-role/v1|<serverDomain>|<serviceId>|<target>|<role>|<issuedAt>
 *
 * packages/protocol/test-vectors/app-member-role/vectors.json is the
 * reference; AppMemberRoleVectorsTest runs every case and every refusal.
 */
object AppMemberRoleOrder {
    const val CANONICAL_TAG = "flagship/app-member-role/v1"

    data class Order(
        val serverDomain: String,
        val serviceId: String,
        val target: String,
        val role: String,
        val issuedAt: Long,
    )

    data class Signed(val order: Order, val signatureHex: String)

    private val AID = Regex("^aid:[0-9a-f]{64}$")
    private val INVITE = Regex("^invite:[A-Za-z0-9._-]{1,128}$")
    private val GRANT = Regex("^grant:[A-Za-z0-9._-]{1,128}/[0-9a-f]{64}$")

    fun aidTarget(aidHex: String): String = "aid:${aidHex.lowercase()}"
    fun inviteTarget(inviteId: String): String = "invite:$inviteId"
    fun grantTarget(inviteId: String, aidHex: String): String = "grant:$inviteId/${aidHex.lowercase()}"

    /** Throws for an order the box would refuse (never sign one). */
    fun canonicalBytes(o: Order): ByteArray {
        for (f in listOf(o.serverDomain, o.serviceId)) {
            require(f.isNotEmpty()) { "empty field" }
            require(f.none { it == '|' || it.code <= 0x1f || it.code == 0x7f }) { "a field contains | or a control character" }
        }
        require(AID.matches(o.target) || INVITE.matches(o.target) || GRANT.matches(o.target)) { "bad target" }
        require(AppMemberRole.fromWire(o.role) != null) { "bad role" }
        require(o.issuedAt >= 0) { "bad issuedAt" }
        return listOf(CANONICAL_TAG, o.serverDomain, o.serviceId, o.target, o.role, o.issuedAt.toString())
            .joinToString("|")
            .toByteArray(Charsets.UTF_8)
    }

    fun sign(key: Ed25519Sign, o: Order): Signed = Signed(o, HexUtil.encode(key.sign(canonicalBytes(o))))
}
