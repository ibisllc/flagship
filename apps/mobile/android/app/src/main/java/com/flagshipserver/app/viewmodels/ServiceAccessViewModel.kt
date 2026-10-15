// Admin orchestrator for a service's Access control (docs/service-access-gating.md,
// "Open mode + members"; the toggle and the members list are independent).
// Mirror of iOS ServiceAccessViewModel + the webapp views/service-access.js:
//   - read the TRUE mode from the box, toggle Open to all <-> Members only
//     (owner-IRK), never touching the members list,
//   - read each member's grants and rank from the box (owner session) and change
//     a rank with a signed flagship/app-member-role/v1 order,
//   - allow-list: ADD a person across THREE tiers (personal auto-approve /
//     personal manual-approve / group multi-use) -> seal {name,photo?} under the
//     household key -> sign the create -> POST .com -> return the share-link
//     (+ author AID embedded so the friend derives a per-author contact AID),
//   - LIST (owner-signed; decrypt bundle locally; a group is ONE "label — k/N"
//     entry, with "Invited by <device>"), REMOVE (.com revoke + owner-IRK box
//     allow-prune; group = prune the whole inviteId; per-member = prune one AID),
//   - FINALIZE a manual-approve acceptance the friend replied back.
//
// Who can invite (owner, 2026-10-15): an admin device (holds the admin root)
// signs create + revoke with it and may change ranks; any other device of the
// account signs with the AID, invites at Member only (.com records it as a
// member invite and tells the admins) and may withdraw only its own member
// invites. The list query stays AID-signed; set-mode + allow-remove use the
// sensitive-order key the box pins.

package com.flagshipserver.app.viewmodels

import android.content.Context
import androidx.lifecycle.ViewModel
import com.flagshipserver.app.api.AppMemberRoleOrderBody
import com.flagshipserver.app.api.AppMemberRoleRequest
import com.flagshipserver.app.api.AppMembersResponse
import com.flagshipserver.app.api.ScreensClient
import com.flagshipserver.app.api.ServiceAccessClient
import com.flagshipserver.app.api.ServiceInviteRow
import com.flagshipserver.app.core.AppMemberRole
import com.flagshipserver.app.core.AppMemberRoleOrder
import com.flagshipserver.app.core.GymSeams
import com.flagshipserver.app.core.HexUtil
import com.flagshipserver.app.core.InviteLink
import com.flagshipserver.app.core.ServiceInvite
import com.flagshipserver.app.keystore.Keystore
import com.google.crypto.tink.subtle.Ed25519Sign
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject

sealed interface ServiceAccessPhase {
    data object Idle : ServiceAccessPhase
    data object Loading : ServiceAccessPhase
    data object Ready : ServiceAccessPhase
    data class Failed(val message: String) : ServiceAccessPhase
}

/** The three invite tiers, chosen at create time (docs §v2 Phase 3). */
enum class InviteTier {
    /** First-bind, auto-approve — the casual fast path (default). */
    PERSONAL_AUTO,
    /** Sensitive: redeem → pending → friend replies an acceptance → author
     *  finalizes. Closes the link-theft race without disclosing the friend. */
    PERSONAL_MANUAL,
    /** One link, up to maxRedemptions (0 = unlimited), auto-approve, lower-trust. */
    GROUP,
}

data class AccessPerson(
    val inviteId: String,
    val name: String,
    val photo: String?,
    val bound: Boolean,
    /** The friend's bound AID (lowercase hex) once they've redeemed; null while
     *  the invite is unredeemed. Removing a BOUND person also prunes this AID
     *  from the box's allow-list. */
    val boundAidHex: String? = null,
    /** GROUP tier: this row stands for the whole multi-use invite. */
    val isGroup: Boolean = false,
    /** GROUP: live redemptions / cap (0 = unlimited) — rendered "k/N". */
    val redemptions: Int = 0,
    val maxRedemptions: Int = 0,
    /** GROUP: the bound member AIDs (for per-member removal). */
    val memberAids: List<String> = emptyList(),
    /** "admin" | "member" | null (rows from before tiers were recorded). */
    val creatorTier: String? = null,
    /** The account device that created the invite, if it named itself. */
    val creatorDeviceId: String? = null,
)

class ServiceAccessViewModel(
    private val serverDomain: String,
    private val serviceRef: String,
    private val username: String,
    private val client: ServiceAccessClient = ServiceAccessClient(),
    /** Owner-IRK signer (set-mode + the box allow-remove — box config-pinned IRK). */
    // Slice D (D-2) — changing WHO may access a service (set-mode + allow-remove)
    // is SENSITIVE membership mutation (membership.ts / serviceInvites.ts gate it
    // on the admin master root): sign with the admin root when held, else the
    // owner IRK (legacy). Canonical bytes unchanged.
    private val irkSigner: suspend (reason: String) -> Ed25519Sign = { r -> Keystore.adminSigningKey(r) },
    /** Stable-AID signer (a non-admin device's create + revoke, and the owner-signed .com list). */
    private val aidSigner: suspend (reason: String) -> Ed25519Sign = { r -> Keystore.deriveAccountId(r) },
    /** Stable AID pub (hex) — the author identity recorded in invites. */
    private val aidPubHex: suspend (reason: String) -> String = { r -> Keystore.accountIdPubHex(r) },
    /** Household key — seals/opens the {name, photo?} bundle. */
    private val householdKey: suspend (reason: String) -> ByteArray = { r -> Keystore.deriveHouseholdKey(r) },
    private val now: () -> Long = { System.currentTimeMillis() },
    /** The box's owner-session API (members + ranks); null ⇒ no ranks shown. */
    private val screens: ScreensClient? = null,
    /** Sensitive-order signer for rank changes (admin root when held, else the IRK). */
    private val roleSigner: suspend (reason: String) -> Ed25519Sign = { r -> Keystore.adminSigningKey(r) },
    /** True when this device holds the account's admin root. */
    private val isAdminDevice: () -> Boolean = { GymSeams.forceAdminRoot || Keystore.hasAdminRoot() },
    /** The admin-root signer an admin device signs invite create + revoke with. */
    private val adminSigner: suspend (reason: String) -> Ed25519Sign = { r -> Keystore.adminSigningKey(r) },
    /** This device's account device id (32 hex), sent with a create for attribution. */
    private val deviceId: () -> String? = { null },
    /** deviceId → name from the decrypted account directory; null when unreadable. */
    private val deviceNames: suspend () -> Map<String, String>? = { null },
) : ViewModel() {
    private val _phase = MutableStateFlow<ServiceAccessPhase>(ServiceAccessPhase.Idle)
    val phase: StateFlow<ServiceAccessPhase> = _phase.asStateFlow()

    private val _restricted = MutableStateFlow(false)
    val restricted: StateFlow<Boolean> = _restricted.asStateFlow()

    private val _allowCount = MutableStateFlow(0)
    val allowCount: StateFlow<Int> = _allowCount.asStateFlow()

    private val _people = MutableStateFlow<List<AccessPerson>>(emptyList())
    val people: StateFlow<List<AccessPerson>> = _people.asStateFlow()

    private val _lastLink = MutableStateFlow<String?>(null)
    val lastInviteLink: StateFlow<String?> = _lastLink.asStateFlow()

    private val _busyMode = MutableStateFlow(false)
    val busyMode: StateFlow<Boolean> = _busyMode.asStateFlow()
    private val _busyAdd = MutableStateFlow(false)
    val busyAdd: StateFlow<Boolean> = _busyAdd.asStateFlow()
    private val _busyFinalize = MutableStateFlow(false)
    val busyFinalize: StateFlow<Boolean> = _busyFinalize.asStateFlow()

    /** The box's members, grants and ranks; null until read (or when it can't be). */
    private val _members = MutableStateFlow<AppMembersResponse?>(null)
    val members: StateFlow<AppMembersResponse?> = _members.asStateFlow()
    /** Rows whose rank change is being signed / sent (by inviteId). */
    private val _busyRoles = MutableStateFlow<Set<String>>(emptySet())
    val busyRoles: StateFlow<Set<String>> = _busyRoles.asStateFlow()
    /** Set when an invite was created but its rank couldn't be set. */
    private val _roleNotice = MutableStateFlow<String?>(null)
    val roleNotice: StateFlow<String?> = _roleNotice.asStateFlow()

    /** deviceId → name, once the directory was read (null: not read or unreadable). */
    private val _deviceNames = MutableStateFlow<Map<String, String>?>(null)
    val deviceNamesState: StateFlow<Map<String, String>?> = _deviceNames.asStateFlow()
    private var deviceNamesTried = false

    /** Only an admin device grants more than Member, changes ranks and revokes others' invites. */
    val isAdmin: Boolean get() = isAdminDevice()

    private val ownDeviceId: String? get() = deviceId()?.lowercase()?.takeIf { it.length == 32 }

    /** Admin: every row. Otherwise only the member invites this device created. */
    fun canRemove(p: AccessPerson): Boolean {
        if (isAdmin) return true
        val own = ownDeviceId ?: return false
        val tier = p.creatorTier ?: _members.value?.inviteTier(p.inviteId)
        return tier == "member" && p.creatorDeviceId?.lowercase() == own
    }

    /** "Invited by <device>", resolved on this phone; null on rows from before tiers. */
    fun invitedBy(p: AccessPerson, names: Map<String, String>? = _deviceNames.value): String? {
        val creator = p.creatorDeviceId?.lowercase()
        if (p.creatorTier == null && creator == null) return null
        if (creator != null && creator == ownDeviceId) return "Invited by this device"
        val name = creator?.let { names?.get(it) }?.takeIf { it.isNotBlank() }
        return if (name != null) "Invited by $name" else "Invited by another device"
    }

    private suspend fun resolveDeviceNames(rows: List<AccessPerson>) {
        if (deviceNamesTried) return
        val own = ownDeviceId
        if (rows.none { it.creatorDeviceId != null && it.creatorDeviceId.lowercase() != own }) return
        deviceNamesTried = true
        _deviceNames.value = runCatching { deviceNames() }.getOrNull()?.mapKeys { it.key.lowercase() }
    }

    /** Read the members, their grants and ranks from the box. */
    suspend fun refreshMembers() {
        val s = screens ?: return
        _members.value = runCatching { s.appMembers(serviceRef) }.getOrNull()
    }

    /** The rank one row shows (null until the box has answered). */
    fun roleFor(p: AccessPerson): AppMemberRole? {
        val m = _members.value ?: return null
        return AppMemberRole.fromWire(m.rowRole(p.inviteId, if (p.isGroup) null else p.boundAidHex))
    }

    /** "also in Family: Member" for a person who joined through other invites too. */
    fun alsoIn(p: AccessPerson): String {
        val m = _members.value ?: return ""
        if (p.isGroup) return ""
        val others = m.otherGrants(p.inviteId, p.boundAidHex) { id -> _people.value.firstOrNull { it.inviteId == id }?.name }
        return AppMembersResponse.alsoInText(others) { AppMemberRole.fromWire(it)?.label ?: it }
    }

    /** How many people a members-only switch leaves able to open it. */
    val memberPeopleCount: Int get() = _members.value?.members?.size ?: _allowCount.value

    /** Sign + send a rank change for one row. Returns whether the box took it. */
    suspend fun setRole(role: AppMemberRole, p: AccessPerson): Boolean {
        if (!isAdmin) return false
        val s = screens ?: return false
        val m = _members.value ?: return false
        if (p.inviteId in _busyRoles.value) return false
        _busyRoles.value = _busyRoles.value + p.inviteId
        return try {
            val target = m.roleTarget(p.inviteId, if (p.isGroup) null else p.boundAidHex)
            sendRole(s, target, role, "Change ${p.name}'s rank")
            refreshMembers()
            true
        } catch (e: Throwable) {
            _phase.value = ServiceAccessPhase.Failed("Couldn't change ${p.name}'s rank. Try again in a moment.")
            false
        } finally {
            _busyRoles.value = _busyRoles.value - p.inviteId
        }
    }

    private suspend fun sendRole(s: ScreensClient, target: String, role: AppMemberRole, reason: String) {
        val key = roleSigner(reason)
        val signed = AppMemberRoleOrder.sign(
            key, AppMemberRoleOrder.Order(serverDomain, serviceRef, target, role.wire, now()),
        )
        val o = signed.order
        s.setAppMemberRole(
            serviceRef,
            AppMemberRoleRequest(AppMemberRoleOrderBody(o.serverDomain, o.serviceId, o.target, o.role, o.issuedAt), signed.signatureHex),
        )
    }

    suspend fun load() {
        _phase.value = ServiceAccessPhase.Loading
        try {
            val state = client.getAccessState(serverDomain, serviceRef)
            _restricted.value = state.isRestricted
            _allowCount.value = state.allowCount
            _phase.value = ServiceAccessPhase.Ready
            refreshPeople()
            refreshMembers()
        } catch (e: Throwable) {
            _phase.value = ServiceAccessPhase.Failed("Couldn't reach the box to load access settings.")
        }
    }

    /** Owner-IRK-sign + POST the mode change. Returns success. */
    suspend fun setMode(restricted: Boolean): Boolean {
        if (_busyMode.value) return false
        _busyMode.value = true
        val mode = if (restricted) "restricted" else "open"
        return try {
            val key = irkSigner(
                if (restricted) "Make $serviceRef members only"
                else "Open $serviceRef to all",
            )
            val ts = now()
            val bytes = ServiceInvite.canonicalSetAccessMode(serverDomain, serviceRef, mode, ts)
            val sig = key.sign(bytes)
            val request: JsonObject = buildJsonObject {
                put("serverId", JsonPrimitive(serverDomain))
                put("serviceRef", JsonPrimitive(serviceRef))
                put("mode", JsonPrimitive(mode))
                put("issuedAt", JsonPrimitive(ts))
            }
            client.setAccessMode(serverDomain, request, HexUtil.encode(sig))
            // The members list never changes with the mode.
            _restricted.value = restricted
            _phase.value = ServiceAccessPhase.Ready
            true
        } catch (e: Throwable) {
            _phase.value = ServiceAccessPhase.Failed("Couldn't change access. Try again in a moment.")
            false
        } finally {
            _busyMode.value = false
        }
    }

    /**
     * Mint a capability invite of the chosen [tier]; returns the share-link (also
     * in lastInviteLink). For GROUP, [maxRedemptions] (0 = unlimited) and an
     * optional [expiresAt] are committed in the create's signed bytes. An admin
     * device signs with the admin root and may give [role]; any other device
     * signs with the AID and its invite stays at Member (no role order). The
     * author AID is embedded in the link so the friend can derive a per-author
     * contact AID.
     */
    suspend fun addPerson(
        name: String,
        photo: String?,
        tier: InviteTier = InviteTier.PERSONAL_AUTO,
        maxRedemptions: Int = 0,
        expiresAt: Long? = null,
        role: AppMemberRole? = null,
    ): String? {
        if (_busyAdd.value) return null
        val trimmed = name.trim()
        if (trimmed.isEmpty()) return null
        _busyAdd.value = true
        return try {
            val reason = "Create an invite for $serviceRef"
            val admin = isAdmin
            val key = if (admin) adminSigner(reason) else aidSigner(reason)
            val aid = HexUtil.decode(aidPubHex(reason))!!
            val hh = householdKey(reason)
            val secret = ServiceInvite.randomSecret()
            val secretHash = ServiceInvite.secretHash(secret)
            // v2: random 128-bit id (no device-fingerprint leak).
            val inviteId = ServiceInvite.randomInviteId()
            val encryptedBundle = ServiceInvite.sealBundle(ServiceInvite.Bundle(trimmed, photo), hh, inviteId)
            val ts = now()
            val groupCap = if (tier == InviteTier.GROUP) maxRedemptions else null
            val groupExp = if (tier == InviteTier.GROUP) expiresAt else null
            val approvalMode = if (tier == InviteTier.PERSONAL_MANUAL) "manual" else "auto"
            val bytes = ServiceInvite.canonicalCreate(
                inviteId, aid, serviceRef, secretHash, encryptedBundle, ts, groupCap, groupExp,
            )
            val sig = key.sign(bytes)
            val request: JsonObject = buildJsonObject {
                put("inviteId", JsonPrimitive(inviteId))
                put("authorAID", JsonPrimitive(HexUtil.encode(aid)))
                put("serviceRef", JsonPrimitive(serviceRef))
                put("secretHash", JsonPrimitive(secretHash))
                put("encryptedBundle", JsonPrimitive(encryptedBundle))
                put("issuedAt", JsonPrimitive(ts))
                put("approvalMode", JsonPrimitive(approvalMode))
                if (groupCap != null) put("maxRedemptions", JsonPrimitive(groupCap))
                if (groupExp != null) put("expiresAt", JsonPrimitive(groupExp))
                ownDeviceId?.let { put("deviceId", JsonPrimitive(it)) }
            }
            client.createInvite(username, request, HexUtil.encode(sig))
            // Carry the inviteId (&i=) ONLY for a manual-approve invite — the
            // friend signs the acceptance over it. Auto/group links stay bare.
            val linkInviteId = if (tier == InviteTier.PERSONAL_MANUAL) inviteId else null
            val link = InviteLink.shareLink(serverDomain, HexUtil.encode(secret), HexUtil.encode(aid), linkInviteId, serviceRef)
            _lastLink.value = link
            _roleNotice.value = null
            // The rank rides a signed order right after the create; the app's
            // default rank needs none.
            val s = screens
            if (admin && role != null && s != null && role.wire != _members.value?.defaultRole) {
                try {
                    sendRole(s, AppMemberRoleOrder.inviteTarget(inviteId), role, "Give $trimmed a rank")
                } catch (e: Throwable) {
                    _roleNotice.value = "Created, but couldn't set the rank. Change it in the list."
                }
            }
            refreshPeople()
            refreshMembers()
            link
        } catch (e: Throwable) {
            _phase.value = ServiceAccessPhase.Failed("Couldn't create the invite. Try again in a moment.")
            null
        } finally {
            _busyAdd.value = false
        }
    }

    /**
     * MANUAL-approve finalize (v2 Phase 3 tier 2). The author pastes/scans the
     * acceptance their friend replied through the private channel; we submit it —
     * the friend's AID-signed acceptance + the owner's signed create (both carried
     * IN the reply) — to the AUTHOR's OWN box, which verifies both then binds the
     * contact AID. Returns true on a bind. The consumer's username is never seen.
     */
    suspend fun finalizeAcceptance(rawReply: String): Boolean {
        if (_busyFinalize.value) return false
        val parsed = InviteLink.decodeAcceptance(rawReply) ?: run {
            _phase.value = ServiceAccessPhase.Failed("That acceptance reply is malformed. Ask your contact to send it again.")
            return false
        }
        _busyFinalize.value = true
        return try {
            // ONLY {accept, acceptSig} — the box fetches the owner's signed create
            // from .com by inviteId (any-device finalize; no local create cache).
            client.acceptInvite(
                serverDomain,
                accept = parsed.accept,
                acceptSigHex = parsed.acceptSigHex,
            )
            refreshPeople()
            true
        } catch (e: Throwable) {
            _phase.value = ServiceAccessPhase.Failed("Couldn't confirm them. Make sure the reply is from your invite and try again.")
            false
        } finally {
            _busyFinalize.value = false
        }
    }

    /** Revoke a person's (or a whole group's) access. Always records the `.com`
     *  revoke (admin root on an admin device, else the AID that created this
     *  member invite). When the person has REDEEMED (bound AID), ALSO
     *  owner-IRK-prunes that AID from the box's allow-list (`.com` does NOT push to
     *  the daemon, so the box call is what actually denies them). A GROUP revoke
     *  prunes EVERY bound member AID. Both legs run; a box-prune failure surfaces. */
    suspend fun remove(inviteId: String, boundAidHex: String? = null, memberAids: List<String> = emptyList()): Boolean {
        _people.value.firstOrNull { it.inviteId == inviteId }?.let { if (!canRemove(it)) return false }
        val ts = now()
        // 1) `.com` revoke — records the revocation.
        val comOk = try {
            val reason = "Remove this person from $serviceRef"
            val key = if (isAdmin) adminSigner(reason) else aidSigner(reason)
            val bytes = ServiceInvite.canonicalRevoke(inviteId, ts)
            val sig = key.sign(bytes)
            val request: JsonObject = buildJsonObject {
                put("inviteId", JsonPrimitive(inviteId))
                put("issuedAt", JsonPrimitive(ts))
            }
            client.revokeInvite(username, request, HexUtil.encode(sig))
            true
        } catch (e: Throwable) {
            _phase.value = ServiceAccessPhase.Failed("Couldn't remove them. Try again in a moment.")
            false
        }

        // 2) Box allow-list prune — for every bound AID (group: all members; else
        //    the single bound AID). This is what actually reaches the box.
        // Only the AIDs for whom this was their last grant: someone who also
        // holds another invite keeps it (the box drops just this grant when its
        // revocation poller sees the .com revoke).
        val bound = (memberAids + listOfNotNull(boundAidHex))
            .mapNotNull { it.lowercase().takeIf { a -> a.isNotEmpty() } }
            .distinct()
        val targets = _members.value?.aidsToPrune(inviteId, bound) ?: bound
        var boxOk = true
        if (targets.isNotEmpty()) {
            boxOk = pruneAids(serviceRef, targets, ts)
        }

        if (comOk && boxOk) {
            refreshPeople()
            refreshMembers()
        }
        return comOk && boxOk
    }

    /** Per-member removal from a GROUP (the group itself stays). Prunes ONE bound
     *  AID from the box (owner-IRK). `.com` keeps the inviteId (other members live). */
    suspend fun removeGroupMember(aidHex: String) {
        val aid = aidHex.lowercase()
        if (aid.isEmpty()) return
        if (pruneAids(serviceRef, listOf(aid), now())) refreshPeople()
    }

    /** Owner-IRK-prune a set of AIDs from the box allow-list. Returns true iff all
     *  pruned. One biometric signer call; each AID a separate signed envelope. */
    private suspend fun pruneAids(serviceRef: String, aids: List<String>, ts: Long): Boolean {
        return try {
            val key = irkSigner("Remove from $serviceRef")
            for (aid in aids) {
                val sig = ServiceInvite.signRemoveServiceAllow(serverDomain, serviceRef, aid, ts, key)
                val request: JsonObject = buildJsonObject {
                    put("serverId", JsonPrimitive(serverDomain))
                    put("serviceRef", JsonPrimitive(serviceRef))
                    put("aid", JsonPrimitive(aid))
                    put("issuedAt", JsonPrimitive(ts))
                }
                client.removeServiceAllow(serverDomain, request, HexUtil.encode(sig))
            }
            true
        } catch (e: Throwable) {
            _phase.value = ServiceAccessPhase.Failed("Removed them, but the server is still catching up. Try again in a moment.")
            false
        }
    }

    /** List the author's live invites for this service from .com (OWNER-SIGNED),
     *  decrypting each bundle locally with the household key. A GROUP invite folds
     *  to ONE entry showing "k/N" + its bound members. */
    suspend fun refreshPeople() {
        try {
            val reason = "Show the members of $serviceRef"
            val aidPub = aidPubHex(reason)
            val hh = householdKey(reason)
            val ts = now()
            val sig = ServiceInvite.signServiceInviteListQuery(username, aidPub.lowercase(), "list", 0, ts, aidSigner(reason))
            val rows = client.listInvites(username, aidPub, ts, HexUtil.encode(sig))
            val people = rows
                .filter { it.serviceRef == serviceRef && it.revokedAt == null }
                .map { row -> toPerson(row, hh) }
            _people.value = people
            resolveDeviceNames(people)
        } catch (e: Throwable) {
            // keep the last list; load-phase error already surfaced
        }
    }

    private fun toPerson(row: ServiceInviteRow, hh: ByteArray): AccessPerson {
        var name = "unknown"
        var photo: String? = null
        runCatching { ServiceInvite.openBundle(row.encryptedBundleHex, hh, row.inviteId) }
            .getOrNull()?.let { name = it.name; photo = it.photo }
        return if (row.isGroup) {
            AccessPerson(
                inviteId = row.inviteId,
                name = name,
                photo = photo,
                bound = row.boundAidsHex.isNotEmpty(),
                boundAidHex = null,
                isGroup = true,
                redemptions = if (row.redemptions > 0) row.redemptions else row.boundAidsHex.size,
                maxRedemptions = row.maxRedemptions ?: 0,
                memberAids = row.boundAidsHex,
                creatorTier = row.creatorTier,
                creatorDeviceId = row.creatorDeviceId,
            )
        } else {
            AccessPerson(
                inviteId = row.inviteId,
                name = name,
                photo = photo,
                bound = row.boundAidHex != null,
                boundAidHex = row.boundAidHex,
                creatorTier = row.creatorTier,
                creatorDeviceId = row.creatorDeviceId,
            )
        }
    }

    fun clearLink() { _lastLink.value = null }

    companion object {
        fun create(
            context: Context,
            serverDomain: String,
            serviceRef: String,
            username: String,
            screens: ScreensClient? = null,
        ): ServiceAccessViewModel = ServiceAccessViewModel(serverDomain, serviceRef, username, screens = screens)
    }
}
