// Admin orchestrator for per-service access gating (docs/service-access-gating.md
// §v2 hardening). Mirror of iOS ServiceAccessViewModel + the webapp
// views/service-access.js:
//   - read the TRUE mode from the box, toggle open <-> restricted (owner-IRK),
//   - allow-list: ADD a person across THREE tiers (personal auto-approve /
//     personal manual-approve / group multi-use) -> seal {name,photo?} under the
//     household key -> AID-sign the create -> POST .com -> return the share-link
//     (+ author AID embedded so the friend derives a per-author contact AID),
//   - LIST (owner-signed; decrypt bundle locally; a group is ONE "label — k/N"
//     entry), REMOVE (AID-signed .com revoke + owner-IRK box allow-prune; group =
//     prune the whole inviteId; per-member = prune one bound AID),
//   - FINALIZE a manual-approve acceptance the friend replied back.
//
// v2 signing: create / revoke / the list query move from the IRK to the STABLE
// AID (the box-as-authority verifies the create against the owner AID, which —
// unlike the rotatable IRK — survives device rotation). set-mode + allow-remove
// stay owner-IRK (the box verifies its config-pinned owner IRK on those).

package com.flagshipserver.app.viewmodels

import android.content.Context
import androidx.lifecycle.ViewModel
import com.flagshipserver.app.api.ServiceAccessClient
import com.flagshipserver.app.api.ServiceInviteRow
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
    // owner IRK (legacy). Canonical bytes unchanged. (The AID-signed create/
    // revoke path below is a separate identity and stays on the AID.)
    private val irkSigner: suspend (reason: String) -> Ed25519Sign = { r -> Keystore.adminSigningKey(r) },
    /** Stable-AID signer (create + revoke + the owner-signed .com list — v2). */
    private val aidSigner: suspend (reason: String) -> Ed25519Sign = { r -> Keystore.deriveAccountId(r) },
    /** Stable AID pub (hex) — the author identity recorded in invites. */
    private val aidPubHex: suspend (reason: String) -> String = { r -> Keystore.accountIdPubHex(r) },
    /** Household key — seals/opens the {name, photo?} bundle. */
    private val householdKey: suspend (reason: String) -> ByteArray = { r -> Keystore.deriveHouseholdKey(r) },
    private val now: () -> Long = { System.currentTimeMillis() },
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

    suspend fun load() {
        _phase.value = ServiceAccessPhase.Loading
        try {
            val state = client.getAccessState(serverDomain, serviceRef)
            _restricted.value = state.isRestricted
            _allowCount.value = state.allowCount
            _phase.value = ServiceAccessPhase.Ready
            if (state.isRestricted) refreshPeople()
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
                if (restricted) "Restrict $serviceRef to your allow-list"
                else "Open $serviceRef to anyone with the link",
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
            _restricted.value = restricted
            if (restricted) refreshPeople() else _people.value = emptyList()
            true
        } catch (e: Throwable) {
            _phase.value = ServiceAccessPhase.Failed("Couldn't change who can open this. Try again in a moment.")
            false
        } finally {
            _busyMode.value = false
        }
    }

    /**
     * Mint a capability invite of the chosen [tier]; returns the share-link (also
     * in lastInviteLink). For GROUP, [maxRedemptions] (0 = unlimited) and an
     * optional [expiresAt] are committed in the create's signed bytes. The create
     * is AID-SIGNED (v2). The author AID is embedded in the link so the friend can
     * derive a per-author contact AID.
     */
    suspend fun addPerson(
        name: String,
        photo: String?,
        tier: InviteTier = InviteTier.PERSONAL_AUTO,
        maxRedemptions: Int = 0,
        expiresAt: Long? = null,
    ): String? {
        if (_busyAdd.value) return null
        val trimmed = name.trim()
        if (trimmed.isEmpty()) return null
        _busyAdd.value = true
        return try {
            val reason = "Create an invite for $serviceRef"
            val key = aidSigner(reason)
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
            }
            client.createInvite(username, request, HexUtil.encode(sig))
            // Carry the inviteId (&i=) ONLY for a manual-approve invite — the
            // friend signs the acceptance over it. Auto/group links stay bare.
            val linkInviteId = if (tier == InviteTier.PERSONAL_MANUAL) inviteId else null
            val link = InviteLink.shareLink(serverDomain, HexUtil.encode(secret), HexUtil.encode(aid), linkInviteId)
            _lastLink.value = link
            refreshPeople()
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
     *  revoke (now AID-signed). When the person has REDEEMED (bound AID), ALSO
     *  owner-IRK-prunes that AID from the box's allow-list (`.com` does NOT push to
     *  the daemon, so the box call is what actually denies them). A GROUP revoke
     *  prunes EVERY bound member AID. Both legs run; a box-prune failure surfaces. */
    suspend fun remove(inviteId: String, boundAidHex: String? = null, memberAids: List<String> = emptyList()) {
        val ts = now()
        // 1) `.com` revoke — records the revocation (author-AID signed, v2).
        val comOk = try {
            val key = aidSigner("Remove this person from $serviceRef")
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
        val targets = (memberAids + listOfNotNull(boundAidHex))
            .mapNotNull { it.lowercase().takeIf { a -> a.isNotEmpty() } }
            .distinct()
        var boxOk = true
        if (targets.isNotEmpty()) {
            boxOk = pruneAids(serviceRef, targets, ts)
        }

        if (comOk && boxOk) refreshPeople()
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
            val reason = "Show who can open $serviceRef"
            val aidPub = aidPubHex(reason)
            val hh = householdKey(reason)
            val ts = now()
            val sig = ServiceInvite.signServiceInviteListQuery(username, aidPub.lowercase(), "list", 0, ts, aidSigner(reason))
            val rows = client.listInvites(username, aidPub, ts, HexUtil.encode(sig))
            _people.value = rows
                .filter { it.serviceRef == serviceRef && it.revokedAt == null }
                .map { row -> toPerson(row, hh) }
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
            )
        } else {
            AccessPerson(
                inviteId = row.inviteId,
                name = name,
                photo = photo,
                bound = row.boundAidHex != null,
                boundAidHex = row.boundAidHex,
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
        ): ServiceAccessViewModel = ServiceAccessViewModel(serverDomain, serviceRef, username)
    }
}
