// Access control orchestrator for one app (docs/service-access-gating.md,
// "Open mode + members" and "Account members, ranks and who may change
// them"). Mirror of iOS ServiceAccessViewModel + the webapp
// views/service-access.js:
//   - read the TRUE mode from the box, toggle Open to all <-> Members only,
//     never touching the members list,
//   - read the account members (this account's devices and the co-managing
//     accounts), each person's grants and every rank from the box,
//   - allow-list: ADD a person across THREE tiers (personal auto-approve /
//     personal manual-approve / group multi-use) -> seal {name,photo?} under the
//     household key -> sign the create -> POST .com -> return the share-link,
//   - LIST (owner-signed; decrypt bundle locally; a group is ONE "label — k/N"
//     entry, with "Invited by <device>"), WITHDRAW (.com revoke + the same
//     signed revoke to the box, which removes who joined through it),
//   - FINALIZE a manual-approve acceptance the friend replied back.
//
// Who may do what (owner, 2026-10-15; the box enforces it): an admin device
// (it holds the admin root) signs every order with it: mode, removals, ranks
// (flagship/app-rank/v1, also Refuse for a device or co-manager), invites at
// any rank and withdrawing any invite. Any other device finds its own rank in
// the account members by its account device key: at Manager or Master it
// invites at Member and withdraws the invites it made, signing both with that
// key; below Manager, or refused, it can't invite. The .com list query stays
// AID-signed.

package com.flagshipserver.app.viewmodels

import android.content.Context
import androidx.lifecycle.ViewModel
import com.flagshipserver.app.api.AppAccountMember
import com.flagshipserver.app.api.AppListScopeOrderBody
import com.flagshipserver.app.api.AppListScopeRequest
import com.flagshipserver.app.api.AppListScopeState
import com.flagshipserver.app.api.AppMembersResponse
import com.flagshipserver.app.api.AppRankOrderBody
import com.flagshipserver.app.api.AppRankRequest
import com.flagshipserver.app.api.ScreensClient
import com.flagshipserver.app.api.ScreensError
import com.flagshipserver.app.api.ServiceAccessClient
import com.flagshipserver.app.api.ServiceInviteRow
import com.flagshipserver.app.core.AppAccessOrders
import com.flagshipserver.app.core.AppListScope
import com.flagshipserver.app.core.AppMemberRole
import com.flagshipserver.app.core.GymSeams
import com.flagshipserver.app.core.HexUtil
import com.flagshipserver.app.core.InviteLink
import com.flagshipserver.app.core.ServiceInvite
import com.flagshipserver.app.keystore.BiometricAuthority
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
     *  the invite is unredeemed. */
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
    serverDomain: String,
    private val serviceRef: String,
    private val username: String,
    private val client: ServiceAccessClient = ServiceAccessClient(),
    /** Stable-AID signer (the owner-signed .com list query). */
    private val aidSigner: suspend (reason: String) -> Ed25519Sign = { r -> Keystore.deriveAccountId(r) },
    /** Stable AID pub (hex) — the author identity recorded in invites. */
    private val aidPubHex: suspend (reason: String) -> String = { r -> Keystore.accountIdPubHex(r) },
    /** Household key — seals/opens the {name, photo?} bundle. */
    private val householdKey: suspend (reason: String) -> ByteArray = { r -> Keystore.deriveHouseholdKey(r) },
    private val now: () -> Long = { System.currentTimeMillis() },
    /** The box's owner-session API (members + ranks); null ⇒ no ranks shown. */
    screens: ScreensClient? = null,
    /** True when this device holds the account's admin root. */
    private val isAdminDevice: () -> Boolean = { GymSeams.forceAdminRoot || Keystore.hasAdminRoot() },
    /** The admin root: every admin-only order, and an admin's invites and withdrawals. */
    private val adminSigner: suspend (reason: String) -> Ed25519Sign = { r -> Keystore.adminSigningKey(r) },
    /** This device's account device id (32 hex). */
    private val deviceId: () -> String? = { null },
    /** This device's account device key: a non-admin device's invites and withdrawals. */
    private val deviceSigner: suspend (reason: String) -> Ed25519Sign? = { r ->
        val id = deviceId()?.lowercase()?.takeIf { DEVICE_ID.matches(it) }
        if (id == null || !Keystore.hasUmkSeed()) {
            null
        } else {
            BiometricAuthority.current()?.ensureFresh(title = "Authorize Flagship", subtitle = r)
            Keystore.accountDeviceSigner(Keystore.currentUmkSeed(), username, id)
        }
    },
    /** That key's public half (hex), which finds this device in the account members. */
    private val ownDevicePubHex: suspend () -> String? = {
        val id = deviceId()?.lowercase()?.takeIf { DEVICE_ID.matches(it) }
        if (id == null || !Keystore.hasUmkSeed()) null
        else HexUtil.encode(Keystore.accountDevicePublicKey(Keystore.currentUmkSeed(), username, id))
    },
    /** deviceId → name from the decrypted account directory; null when unreadable. */
    private val deviceNames: suspend () -> Map<String, String>? = { null },
    /** Another server's screens client by its fqdn (null: no session there),
     *  for the picker when the app keeps a separate list on each server. */
    private val screensFor: (String) -> ScreensClient? = { null },
    /** A server's display name by its fqdn. */
    private val serverName: (String) -> String = AppListScope::firstLabel,
) : ViewModel() {
    /** The server whose list the screen shows and edits: the one it opened
     *  on, or the one picked while the app keeps a separate list on each server. */
    private val homeDomain = serverDomain
    private val homeBox = screens
    private var domain = serverDomain
    private var box: ScreensClient? = screens

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

    /** The box's account members, people, grants and ranks; null until read (or when it can't be). */
    private val _members = MutableStateFlow<AppMembersResponse?>(null)
    val members: StateFlow<AppMembersResponse?> = _members.asStateFlow()
    /** Rows whose rank change is being signed / sent (inviteId, or an account member's rowKey). */
    private val _busyRoles = MutableStateFlow<Set<String>>(emptySet())
    val busyRoles: StateFlow<Set<String>> = _busyRoles.asStateFlow()
    /** Set when an invite was created but its rank couldn't be set. */
    private val _roleNotice = MutableStateFlow<String?>(null)
    val roleNotice: StateFlow<String?> = _roleNotice.asStateFlow()

    /** deviceId → name, once the directory was read (null: not read or unreadable). */
    private val _deviceNames = MutableStateFlow<Map<String, String>?>(null)
    val deviceNamesState: StateFlow<Map<String, String>?> = _deviceNames.asStateFlow()
    private var deviceNamesTried = false

    /** This device's account device key (hex), once known. */
    private val _selfPub = MutableStateFlow<String?>(null)
    val selfPub: StateFlow<String?> = _selfPub.asStateFlow()
    private var selfPubTried = false

    /** An admin device: changes the mode, ranks and removals, invites at any rank. */
    val isAdmin: Boolean get() = isAdminDevice()

    private val ownDeviceId: String? get() = deviceId()?.lowercase()?.takeIf { DEVICE_ID.matches(it) }

    /** This device's own row in the account members (by its account device key). */
    val selfMember: AppAccountMember? get() = _members.value?.self(_selfPub.value)

    /**
     * Whether this device may create invites here. An admin always; any other
     * device while its own rank is Manager or Master. A box that lists no
     * account members (or hasn't answered) decides itself.
     */
    val canInvite: Boolean
        get() {
            if (isAdmin) return true
            val m = _members.value ?: return true
            if (m.accountMembers.isEmpty()) return true
            return selfMember?.appRank?.managerClass == true
        }

    /** The one line shown instead of "+ Add" when this device may not invite. */
    val inviteBlockedLine: String? get() = if (canInvite) null else CANT_INVITE_LINE

    private fun createdHere(p: AccessPerson): Boolean {
        val inv = _members.value?.invite(p.inviteId)
        val pub = _selfPub.value?.lowercase()
        if (pub != null && inv?.creatorPub?.lowercase() == pub) return true
        val own = ownDeviceId ?: return false
        return (p.creatorDeviceId ?: inv?.creatorDeviceId)?.lowercase() == own
    }

    /** Admin: every row. Otherwise only the invites this device made, while it may invite. */
    fun canRemove(p: AccessPerson): Boolean {
        if (isAdmin) return true
        if (!canInvite) return false
        val tier = p.creatorTier ?: _members.value?.inviteTier(p.inviteId)
        return tier != "admin" && createdHere(p)
    }

    /** "Invited by <device>", resolved on this phone; null on rows from before tiers. */
    fun invitedBy(p: AccessPerson, names: Map<String, String>? = _deviceNames.value): String? {
        val creator = (p.creatorDeviceId ?: _members.value?.invite(p.inviteId)?.creatorDeviceId)?.lowercase()
        if (p.creatorTier == null && creator == null) return null
        if (createdHere(p)) return "Invited by this device"
        val name = creator?.let { names?.get(it) }?.takeIf { it.isNotBlank() }
        return if (name != null) "Invited by $name" else "Invited by another device"
    }

    /** A device's name from the decrypted directory, else "Device" and a short id; a co-manager by the owner's label. */
    fun accountMemberName(m: AppAccountMember, names: Map<String, String>? = _deviceNames.value): String =
        if (m.isDevice) {
            m.deviceId?.lowercase()?.let { names?.get(it) }?.takeIf { it.isNotBlank() }
                ?: "Device ${(m.deviceId ?: m.devicePub).orEmpty().take(8)}"
        } else {
            m.label?.takeIf { it.isNotBlank() } ?: "Co-manager"
        }

    /** "This device · Admin", "Admin", "Co-manages this server", or "". */
    fun accountMemberDetail(m: AppAccountMember): String {
        if (!m.isDevice) return "Co-manages this server"
        val parts = mutableListOf<String>()
        if (m.devicePub != null && m.devicePub.lowercase() == _selfPub.value?.lowercase()) parts += "This device"
        if (m.tier == "admin") parts += "Admin"
        return parts.joinToString(" · ")
    }

    private suspend fun resolveDeviceNames() {
        if (deviceNamesTried) return
        val own = ownDeviceId
        val others = _people.value.mapNotNull { it.creatorDeviceId?.lowercase() } +
            (_members.value?.accountMembers.orEmpty().mapNotNull { it.deviceId?.lowercase() }) +
            (_members.value?.invites.orEmpty().mapNotNull { it.creatorDeviceId?.lowercase() })
        if (others.none { it != own } && (_members.value?.accountMembers.orEmpty().none { it.isDevice })) return
        deviceNamesTried = true
        _deviceNames.value = runCatching { deviceNames() }.getOrNull()?.mapKeys { it.key.lowercase() }
    }

    private suspend fun resolveSelf() {
        if (selfPubTried) return
        selfPubTried = true
        _selfPub.value = runCatching { ownDevicePubHex() }.getOrNull()?.lowercase()
    }

    /** Read the account members, people and ranks from the box. */
    suspend fun refreshMembers() {
        val s = box ?: return
        resolveSelf()
        _members.value = runCatching { s.appMembers(serviceRef) }.getOrNull()
        resolveDeviceNames()
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

    /** Sign + send a rank change for one invited row. Returns whether the box took it. */
    suspend fun setRole(role: AppMemberRole, p: AccessPerson): Boolean {
        val m = _members.value ?: return false
        val target = m.roleTarget(p.inviteId, if (p.isGroup) null else p.boundAidHex)
        return changeRank(p.inviteId, target, role.wire, "Change ${p.name}'s rank", "Couldn't change ${p.name}'s rank. Try again in a moment.")
    }

    /** Give one of the account's devices or a co-manager a rank in this app; null refuses it. */
    suspend fun setAccountRank(member: AppAccountMember, rank: AppMemberRole?): Boolean {
        val target = member.rankTarget ?: return false
        val name = accountMemberName(member)
        val reason = if (rank == null) "Refuse $name in $serviceRef" else "Make $name ${rank.label}"
        return changeRank(member.rowKey, target, rank?.wire ?: AppAccessOrders.REFUSED, reason, "Couldn't change $name. Try again in a moment.")
    }

    private suspend fun changeRank(busyKey: String, target: String, rank: String, reason: String, failure: String): Boolean {
        if (!isAdmin) return false
        val s = box ?: return false
        if (busyKey in _busyRoles.value) return false
        _busyRoles.value = _busyRoles.value + busyKey
        return try {
            sendRank(s, target, rank, reason)
            refreshMembers()
            true
        } catch (e: Throwable) {
            _phase.value = ServiceAccessPhase.Failed(failure)
            false
        } finally {
            _busyRoles.value = _busyRoles.value - busyKey
        }
    }

    /** One admin-root signature per order; a 409 (a newer order won) is signed once more, newer. */
    private suspend fun sendRank(s: ScreensClient, target: String, rank: String, reason: String) {
        val key = adminSigner(reason)
        suspend fun send(at: Long) {
            val o = AppAccessOrders.Rank(serviceRef, target, rank, at)
            s.setAppRank(serviceRef, AppRankRequest(AppRankOrderBody(o.serviceRef, o.target, o.rank, o.issuedAt), AppAccessOrders.signHex(key, o)))
        }
        val first = now()
        try {
            send(first)
        } catch (e: ScreensError.Http) {
            if (e.status != 409) throw e
            send(maxOf(now(), first + 1))
        }
    }

    suspend fun load() {
        _phase.value = ServiceAccessPhase.Loading
        refreshListScope()
        try {
            val state = client.getAccessState(domain, serviceRef)
            _restricted.value = state.isRestricted
            _allowCount.value = state.allowCount
            _phase.value = ServiceAccessPhase.Ready
            refreshPeople()
            refreshMembers()
        } catch (e: Throwable) {
            _phase.value = ServiceAccessPhase.Failed("Couldn't reach the box to load access settings.")
        }
    }

    // ── A separate list on each server (Pro; feat/marketplace) ─────────────

    private val _listScope = MutableStateFlow<AppListScopeState?>(null)
    /** The app's list scope as the shown server said it; null when it can't say (an older box). */
    val listScope: StateFlow<AppListScopeState?> = _listScope.asStateFlow()
    private val _busyScope = MutableStateFlow(false)
    val busyScope: StateFlow<Boolean> = _busyScope.asStateFlow()
    /** The box refused a separate list for want of Pro (402). */
    private val _scopeNeedsPro = MutableStateFlow(false)
    val scopeNeedsPro: StateFlow<Boolean> = _scopeNeedsPro.asStateFlow()
    private val _shownServer = MutableStateFlow(serverDomain.lowercase())
    /** The fqdn of the server whose list the screen shows. */
    val shownServer: StateFlow<String> = _shownServer.asStateFlow()
    /** The opening server's own name for itself, once it answered. */
    private var homeSelf: String? = null

    /** On: the app keeps (or has asked for) a separate list on each server. */
    val listScopeOn: Boolean get() = _listScope.value?.let { it.separate || it.pending } == true

    /** The switch: admin devices only, once the server said. */
    val showsListScopeToggle: Boolean get() = isAdmin && _listScope.value != null

    /** Off without Pro: the switch can't be turned on. */
    val listScopeLocked: Boolean get() = !listScopeOn && _listScope.value?.isPro != true

    val showsListScopeProLine: Boolean get() = isAdmin && _listScope.value != null && !listScopeOn && (listScopeLocked || _scopeNeedsPro.value)

    val showsListScopePending: Boolean get() = _listScope.value?.pending == true

    /** What a device that isn't an admin sees instead of the switch. */
    val listScopeReadOnlyLine: String? get() = if (!isAdmin && _listScope.value?.separate == true) AppListScope.READ_ONLY_ON else null

    /** The app's servers, in server order, while each keeps its own list. */
    val pickerServers: List<String>
        get() {
            val st = _listScope.value ?: return emptyList()
            if (!st.separate) return emptyList()
            return st.servers.map { it.lowercase() }.distinct()
        }

    val showsServerPicker: Boolean get() = pickerServers.size > 1

    fun serverLabel(fqdn: String): String = serverName(fqdn.lowercase())

    /** The confirm dialog's title and text before turning the switch [on] or off. */
    fun listScopeConfirm(on: Boolean): Pair<String, String> {
        if (on) return AppListScope.ON_TITLE to AppListScope.ON_CONFIRM
        val st = _listScope.value
        val leader = st?.leader?.ifEmpty { st.self }?.ifEmpty { null } ?: _shownServer.value
        return AppListScope.OFF_TITLE to AppListScope.offConfirm(serverLabel(leader))
    }

    /** Best-effort: an older box (404) or an offline one hides the switch. */
    suspend fun refreshListScope() {
        val s = box ?: run { _listScope.value = null; return }
        val st = try {
            s.appListScope(serviceRef)
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e
        } catch (_: Throwable) {
            null
        }
        _listScope.value = st
        val self = st?.self?.lowercase()?.takeIf { it.isNotEmpty() } ?: return
        if (box === homeBox && homeSelf == null) homeSelf = self
        _shownServer.value = self
        // Each server keeps its own list: every call goes to the server shown.
        if (st.separate) domain = self
    }

    /** Admin only: sign `flagship/app-list-scope/v1` and post it once, to the shown server. */
    suspend fun setListScope(on: Boolean): Boolean {
        val cur = _listScope.value ?: return false
        if (!isAdmin || _busyScope.value) return false
        if (on && !cur.isPro) {
            _scopeNeedsPro.value = true
            return false
        }
        val s = box ?: return false
        _busyScope.value = true
        val scope = if (on) AppListScope.SERVER else AppListScope.ACCOUNT
        return try {
            val key = adminSigner(if (on) "Give $serviceRef a separate list on each server" else "Use one list for $serviceRef on every server")
            suspend fun send(at: Long): AppListScopeState {
                val o = AppListScope.Order(serviceRef, scope, at)
                return s.setAppListScope(serviceRef, AppListScopeRequest(AppListScopeOrderBody(o.serviceRef, o.scope, o.issuedAt), AppListScope.signHex(key, o)))
            }
            val first = now()
            val next = try {
                send(first)
            } catch (e: ScreensError.Http) {
                if (e.status != 409) throw e
                send(maxOf(now(), first + 1))
            }
            _scopeNeedsPro.value = false
            _listScope.value = next
            if (on) {
                next.self.lowercase().takeIf { it.isNotEmpty() }?.let { _shownServer.value = it; domain = it }
            } else if (box !== homeBox) {
                box = homeBox
                domain = homeDomain
                _shownServer.value = homeSelf ?: homeDomain.lowercase()
                load()
            }
            true
        } catch (e: ScreensError.Http) {
            if (e.status == 402) _scopeNeedsPro.value = true
            else _phase.value = ServiceAccessPhase.Failed(LIST_SCOPE_FAILED)
            false
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e
        } catch (e: Throwable) {
            _phase.value = ServiceAccessPhase.Failed(LIST_SCOPE_FAILED)
            false
        } finally {
            _busyScope.value = false
        }
    }

    /** Show and edit [fqdn]'s own list: members, mode, invites and every order go there. */
    suspend fun selectServer(fqdn: String): Boolean {
        val target = fqdn.lowercase()
        if (target == _shownServer.value || target !in pickerServers) return false
        val client = if (target == homeSelf) homeBox else screensFor(target)
        if (client == null) {
            _phase.value = ServiceAccessPhase.Failed("This phone isn't set up on ${serverLabel(target)}.")
            return false
        }
        box = client
        domain = target
        _shownServer.value = target
        _members.value = null
        load()
        return true
    }

    /** Admin only: sign (admin root) + POST the v2 mode order. Returns success. */
    suspend fun setMode(restricted: Boolean): Boolean {
        if (!isAdmin || _busyMode.value) return false
        _busyMode.value = true
        val mode = if (restricted) "restricted" else "open"
        return try {
            val key = adminSigner(if (restricted) "Make $serviceRef members only" else "Open $serviceRef to all")
            val order = AppAccessOrders.Mode(serviceRef, mode, now())
            val request: JsonObject = buildJsonObject {
                put("serviceRef", JsonPrimitive(order.serviceRef))
                put("mode", JsonPrimitive(order.mode))
                put("issuedAt", JsonPrimitive(order.issuedAt))
            }
            client.setAccessMode(domain, request, AppAccessOrders.signHex(key, order))
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
     * that may invite signs with its account device key, names itself, and its
     * invite stays at Member (no rank order).
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
        if (!canInvite) {
            _phase.value = ServiceAccessPhase.Failed(CANT_INVITE_LINE)
            return null
        }
        _busyAdd.value = true
        return try {
            val reason = "Create an invite for $serviceRef"
            val admin = isAdmin
            val key = if (admin) adminSigner(reason) else deviceSigner(reason) ?: error("no account device key")
            val aid = HexUtil.decode(aidPubHex(reason))!!
            val hh = householdKey(reason)
            val secret = ServiceInvite.randomSecret()
            val secretHash = ServiceInvite.secretHash(secret)
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
            val link = InviteLink.shareLink(domain, HexUtil.encode(secret), HexUtil.encode(aid), linkInviteId, serviceRef)
            _lastLink.value = link
            _roleNotice.value = null
            val s = box
            if (admin && role != null && s != null && role.wire != _members.value?.defaultRole) {
                try {
                    sendRank(s, AppAccessOrders.inviteTarget(inviteId), role.wire, "Give $trimmed a rank")
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
     * acceptance their friend replied through the private channel; we submit it
     * to the AUTHOR's OWN box, which fetches the signed create from .com,
     * verifies both, then binds the friend. Returns true on a bind.
     */
    suspend fun finalizeAcceptance(rawReply: String): Boolean {
        if (_busyFinalize.value) return false
        val parsed = InviteLink.decodeAcceptance(rawReply) ?: run {
            _phase.value = ServiceAccessPhase.Failed("That acceptance reply is malformed. Ask your contact to send it again.")
            return false
        }
        _busyFinalize.value = true
        return try {
            client.acceptInvite(
                domain,
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

    /**
     * Withdraw an invite (a person, or a whole group). One signed
     * `flagship/service-invite/revoke/v1` (the admin root on an admin device,
     * else this device's account device key for an invite it made) goes to
     * `.com`, which records it, and to the box, which verifies it itself and
     * removes everyone who joined only through it. Both legs run; a box failure
     * surfaces (its revocation poll is the backstop).
     */
    suspend fun remove(inviteId: String): Boolean {
        val person = _people.value.firstOrNull { it.inviteId == inviteId }
        if (if (person != null) !canRemove(person) else !isAdmin) return false
        val ts = now()
        val reason = "Remove this person from $serviceRef"
        val revoke: JsonObject = buildJsonObject {
            put("inviteId", JsonPrimitive(inviteId))
            put("issuedAt", JsonPrimitive(ts))
        }
        val sigHex = try {
            val key = if (isAdmin) adminSigner(reason) else deviceSigner(reason) ?: error("no account device key")
            HexUtil.encode(key.sign(ServiceInvite.canonicalRevoke(inviteId, ts)))
        } catch (e: Throwable) {
            _phase.value = ServiceAccessPhase.Failed("Couldn't remove them. Try again in a moment.")
            return false
        }
        val comOk = try {
            client.revokeInvite(username, revoke, sigHex)
            true
        } catch (e: Throwable) {
            _phase.value = ServiceAccessPhase.Failed("Couldn't remove them. Try again in a moment.")
            false
        }
        val boxOk = try {
            client.withdrawInvite(domain, revoke, sigHex)
            true
        } catch (e: Throwable) {
            if (comOk) _phase.value = ServiceAccessPhase.Failed("Removed them, but the server is still catching up. Try again in a moment.")
            false
        }
        if (comOk) {
            refreshPeople()
            refreshMembers()
        }
        return comOk && boxOk
    }

    /** Admin only: remove ONE person who joined through a group (the group
     *  stays), with a signed `flagship/service-allow-remove/v2`. */
    suspend fun removeGroupMember(aidHex: String): Boolean {
        val aid = aidHex.lowercase()
        if (!isAdmin || aid.isEmpty()) return false
        return try {
            val key = adminSigner("Remove from $serviceRef")
            val order = AppAccessOrders.Remove(serviceRef, aid, now())
            val request: JsonObject = buildJsonObject {
                put("serviceRef", JsonPrimitive(order.serviceRef))
                put("aid", JsonPrimitive(order.aid))
                put("issuedAt", JsonPrimitive(order.issuedAt))
            }
            client.removeServiceAllow(domain, request, AppAccessOrders.signHex(key, order))
            refreshPeople()
            refreshMembers()
            true
        } catch (e: Throwable) {
            _phase.value = ServiceAccessPhase.Failed("Couldn't remove them. Try again in a moment.")
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
            resolveDeviceNames()
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
        private val DEVICE_ID = Regex("^[0-9a-f]{32}$")

        const val CANT_INVITE_LINE = "Only an admin can let you invite people to this app."
        const val LIST_SCOPE_FAILED = "Couldn't change the list. Try again in a moment."

        fun create(
            context: Context,
            serverDomain: String,
            serviceRef: String,
            username: String,
            screens: ScreensClient? = null,
        ): ServiceAccessViewModel = ServiceAccessViewModel(serverDomain, serviceRef, username, screens = screens)
    }
}
