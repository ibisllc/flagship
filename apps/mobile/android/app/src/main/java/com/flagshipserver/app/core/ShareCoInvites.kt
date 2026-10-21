// Co-manager invites (docs/service-access-gating.md "Co-manager invites"): at
// "Can manage", B invites people to the shared server's apps at Member while
// B stays manager-class there, and withdraws only B's own invites. The create
// and the withdraw are signed with B's member key and go to the box over the
// share session; the box relays them to `.com`, so the app never calls `.com`
// for them. Names are sealed under B's share-invite bundle key, so only B's
// devices read them. Strings match the webapp's `CO_INVITE_*`; the calls live
// on ServerShareClient (coInvites / createCoInvite / withdrawCoInvite).

package com.flagshipserver.app.core

import com.flagshipserver.app.R
import kotlinx.serialization.Serializable

object ShareCoInviteCopy {
    val OPEN get() = FSStrings.get(R.string.invite_people)
    val LINE get() = FSStrings.get(R.string.people_you_invite_join_as_member)
    const val ADD_PERSON = "+ Add person"
    const val ADD_GROUP = "+ Add group"
    const val NAME_LABEL = "Name"
    val GROUP_NAME_LABEL get() = FSStrings.get(R.string.group_name)
    val NAME_HINT get() = FSStrings.get(R.string.only_your_devices_see_it)
    const val NAME_PLACEHOLDER = "Alex"
    val GROUP_NAME_PLACEHOLDER get() = FSStrings.get(R.string.chess_club)
    val MAX_USES_LABEL get() = FSStrings.get(R.string.max_uses)
    const val MAX_USES_HINT = "0 = unlimited"
    val DAYS_LABEL get() = FSStrings.get(R.string.expires_in_days)
    const val DAYS_HINT = "optional"
    const val RANK_LINE = "Rank: Member"
    val CREATE get() = FSStrings.get(R.string.create_invite_link)
    val LINK_LINE get() = FSStrings.get(R.string.send_the_link_over_a_private)
    val COPY_LINK get() = FSStrings.get(R.string.copy_link)
    val YOURS get() = FSStrings.get(R.string.your_invites)
    val NONE get() = FSStrings.get(R.string.you_havent_invited_anyone_to_this)
    const val WITHDRAW = "Withdraw"
    val WITHDRAW_TITLE get() = FSStrings.get(R.string.withdraw_this_invite)
    const val UNNAMED = "Someone"
    val CREATED get() = FSStrings.get(R.string.invite_created)
    val WITHDRAWN get() = FSStrings.get(R.string.invite_withdrawn)
    val LINK_COPIED get() = FSStrings.get(R.string.link_copied)
    val NO_NAME get() = FSStrings.get(R.string.give_them_a_name)
    val NO_GROUP_NAME get() = FSStrings.get(R.string.give_the_group_a_name)
    val NO_OWNER get() = FSStrings.get(R.string.this_server_cant_take_invites_yet)
    val READ_FAILED get() = FSStrings.get(R.string.couldnt_read_your_invites_from_this)
    val CREATE_FAILED get() = FSStrings.get(R.string.couldnt_create_the_invite_try_again)
    val WITHDRAW_FAILED get() = FSStrings.get(R.string.couldnt_withdraw_the_invite_try_again)

    /** Why B can't invite (the box sends the same sentence as `whyText`; this is the fallback). */
    val WHY: Map<String, String> get() = mapOf(
        "not-shared" to FSStrings.get(R.string.this_server_isnt_shared_with_you_2),
        "view-only" to FSStrings.get(R.string.you_can_view_this_server_but),
        "demoted" to FSStrings.get(R.string.an_admin_made_you_a_member),
        "refused" to FSStrings.get(R.string.an_admin_turned_off_your_access),
        "catching-up" to FSStrings.get(R.string.this_server_is_catching_up_with),
    )
    val VIEW_ONLY: String = WHY.getValue("view-only")

    fun withdrawMessage(appName: String): String =
        FSStrings.get(R.string.the_link_stops_working_and_anyone, appName)

    /** "Not opened yet", "1 person joined", "3 of 10 joined", "3 joined" (a group with no limit). */
    fun statusText(inv: ShareCoInvite, now: Long = System.currentTimeMillis()): String {
        val n = inv.joined
        val max = inv.maxRedemptions
        var text = when {
            max == null -> when (n) {
                0 -> FSStrings.get(R.string.not_opened_yet)
                1 -> "1 person joined"
                else -> FSStrings.get(R.string.people_joined, n)
            }
            max == 0 -> FSStrings.get(R.string.joined, n)
            else -> FSStrings.get(R.string.of_joined, n, max)
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
