// Co-manager invites (docs/service-access-gating.md "Co-manager invites"): at
// "Can manage", B invites people to the shared server's apps at Member while
// B stays manager-class there, and withdraws only B's own invites. The create
// and the withdraw are signed with B's member key and go to the box over the
// share session; the box relays them to `.com`, so the app never calls `.com`
// for them. Names are sealed under B's share-invite bundle key, so only B's
// devices read them. Strings match the webapp's `CO_INVITE_*`; the calls live
// on ServerShareClient (coInvites / createCoInvite / withdrawCoInvite).

package com.flagshipserver.app.core

import kotlinx.serialization.Serializable

object ShareCoInviteCopy {
    const val OPEN = "Invite people"
    const val LINE = "People you invite join as Member. You can withdraw your own invites."
    const val ADD_PERSON = "+ Add person"
    const val ADD_GROUP = "+ Add group"
    const val NAME_LABEL = "Name"
    const val GROUP_NAME_LABEL = "Group name"
    const val NAME_HINT = "Only your devices see it."
    const val NAME_PLACEHOLDER = "Alex"
    const val GROUP_NAME_PLACEHOLDER = "Chess club"
    const val MAX_USES_LABEL = "Max uses"
    const val MAX_USES_HINT = "0 = unlimited"
    const val DAYS_LABEL = "Expires in days"
    const val DAYS_HINT = "optional"
    const val RANK_LINE = "Rank: Member"
    const val CREATE = "Create invite link"
    const val LINK_LINE = "Send the link over a private channel. Whoever opens it joins as Member."
    const val COPY_LINK = "Copy link"
    const val YOURS = "Your invites"
    const val NONE = "You haven't invited anyone to this app yet."
    const val WITHDRAW = "Withdraw"
    const val WITHDRAW_TITLE = "Withdraw this invite?"
    const val UNNAMED = "Someone"
    const val CREATED = "Invite created"
    const val WITHDRAWN = "Invite withdrawn"
    const val LINK_COPIED = "Link copied"
    const val NO_NAME = "Give them a name."
    const val NO_GROUP_NAME = "Give the group a name."
    const val NO_OWNER = "This server can't take invites yet."
    const val READ_FAILED = "Couldn't read your invites from this server."
    const val CREATE_FAILED = "Couldn't create the invite. Try again."
    const val WITHDRAW_FAILED = "Couldn't withdraw the invite. Try again."

    /** Why B can't invite (the box sends the same sentence as `whyText`; this is the fallback). */
    val WHY: Map<String, String> = mapOf(
        "not-shared" to "This server isn't shared with you anymore.",
        "view-only" to "You can view this server but not manage it, so you can't invite people to its apps.",
        "demoted" to "An admin made you a Member of this app, so you can't invite people to it.",
        "refused" to "An admin turned off your access to this app.",
        "catching-up" to "This server is catching up with the app's other servers. Try again in a moment.",
    )
    val VIEW_ONLY: String = WHY.getValue("view-only")

    fun withdrawMessage(appName: String): String =
        "The link stops working, and anyone who joined through it loses access to $appName."

    /** "Not opened yet", "1 person joined", "3 of 10 joined", "3 joined" (a group with no limit). */
    fun statusText(inv: ShareCoInvite, now: Long = System.currentTimeMillis()): String {
        val n = inv.joined
        val max = inv.maxRedemptions
        var text = when {
            max == null -> when (n) {
                0 -> "Not opened yet"
                1 -> "1 person joined"
                else -> "$n people joined"
            }
            max == 0 -> "$n joined"
            else -> "$n of $max joined"
        }
        val exp = inv.expiresAt
        if (exp != null && exp <= now) text += " · expired"
        return text
    }
}

/** The box refused (or the phone stopped) a co-manager invite action, in words for the person. */
class ShareInviteRefusal(val code: String?, message: String) : Exception(message) {
    companion object {
        /** The box's own sentence for a refusal it explained (a coded error), else [fallback]. */
        fun text(code: String?, error: String?, fallback: String): String =
            if (code != null && !error.isNullOrBlank() && code != "malformed" && code != "invalid-signature") error else fallback
    }
}

// ── Wire ──────────────────────────────────────────────────────────────────

@Serializable
data class ShareInviteRow(
    val inviteId: String? = null,
    val createdAt: Long? = null,
    val encryptedBundle: String? = null,
    val maxRedemptions: Int? = null,
    val expiresAt: Long? = null,
    val joined: Int? = null,
)

/** `GET /api/shares/invites?service=<serviceRef>`. */
@Serializable
data class ShareInvitesWire(
    val serviceRef: String? = null,
    val canInvite: Boolean = false,
    val why: String? = null,
    val whyText: String? = null,
    val rank: String? = null,
    val ownerAid: String? = null,
    val invites: List<ShareInviteRow> = emptyList(),
)

/** The create B signs (`flagship/service-invite/create/v1`); [authorAID] is the owner's AID. */
@Serializable
data class ShareInviteCreateRequest(
    val inviteId: String,
    val authorAID: String,
    val serviceRef: String,
    val secretHash: String,
    val encryptedBundle: String,
    val issuedAt: Long,
    val maxRedemptions: Int? = null,
    val expiresAt: Long? = null,
) {
    fun canonicalBytes(): ByteArray = ServiceInvite.canonicalCreate(
        inviteId = inviteId,
        authorAID = HexUtil.decode(authorAID) ?: error("authorAID must be hex"),
        serviceRef = serviceRef,
        secretHash = secretHash,
        encryptedBundle = encryptedBundle,
        issuedAt = issuedAt,
        maxRedemptions = maxRedemptions,
        expiresAt = expiresAt,
    )
}

@Serializable
data class ShareInviteCreateBody(val request: ShareInviteCreateRequest, val signature: String)

/** The withdraw B signs (`flagship/service-invite/revoke/v1`). */
@Serializable
data class ShareInviteRevoke(val inviteId: String, val issuedAt: Long) {
    fun canonicalBytes(): ByteArray = ServiceInvite.canonicalRevoke(inviteId, issuedAt)
}

@Serializable
data class ShareInviteWithdrawBody(val revoke: ShareInviteRevoke, val signature: String)

// ── Opened ────────────────────────────────────────────────────────────────

/** One of B's own invites, its name opened with B's bundle key (null when it won't open). */
data class ShareCoInvite(
    val inviteId: String,
    val name: String?,
    val createdAt: Long? = null,
    val joined: Int = 0,
    val maxRedemptions: Int? = null,
    val expiresAt: Long? = null,
) {
    val displayName: String get() = name ?: ShareCoInviteCopy.UNNAMED
}

/** Whether B may invite to one app, and B's own invites there. */
data class ShareCoInviteState(
    val canInvite: Boolean,
    val why: String?,
    /** The box's sentence when B can't invite ("" when B can). */
    val whyText: String,
    val rank: String?,
    val ownerAid: String?,
    val invites: List<ShareCoInvite>,
) {
    companion object {
        private val HEX64 = Regex("^[0-9a-f]{64}$")

        /** Open the box's answer: names under [bundleKey] ("Someone" when one won't open). */
        fun from(body: ShareInvitesWire, bundleKey: ByteArray): ShareCoInviteState {
            val invites = body.invites.mapNotNull { r ->
                val id = r.inviteId ?: return@mapNotNull null
                val name = r.encryptedBundle?.let { runCatching { ServiceInvite.openBundle(it, bundleKey, id).name }.getOrNull() }
                ShareCoInvite(id, name, r.createdAt, maxOf(0, r.joined ?: 0), r.maxRedemptions, r.expiresAt)
            }
            val whyText = if (body.canInvite) "" else
                body.whyText?.takeIf { it.isNotEmpty() } ?: body.why?.let { ShareCoInviteCopy.WHY[it] } ?: ""
            return ShareCoInviteState(
                canInvite = body.canInvite,
                why = body.why,
                whyText = whyText,
                rank = body.rank,
                ownerAid = body.ownerAid?.takeIf { HEX64.matches(it) },
                invites = invites,
            )
        }
    }
}

/** A group invite's limits: [maxRedemptions] 0 = unlimited. */
data class ShareCoInviteGroup(val maxRedemptions: Int, val expiresAt: Long? = null) {
    companion object {
        /** From the form: max uses (10 when unreadable) and days (none when empty or 0). */
        fun fromForm(maxUses: String, days: String, now: Long = System.currentTimeMillis()): ShareCoInviteGroup {
            val m = maxUses.trim().toIntOrNull()?.takeIf { it >= 0 } ?: 10
            val d = days.trim().toDoubleOrNull() ?: 0.0
            val exp = if (d.isFinite() && d > 0) now + Math.round(d * 86_400_000) else null
            return ShareCoInviteGroup(m, exp)
        }
    }
}

data class ShareCoInviteCreated(val inviteId: String, val link: String)
