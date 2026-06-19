// Admin orchestrator for per-service access gating (docs/service-access-gating.md).
// Mirror of iOS ServiceAccessViewModel + the webapp views/service-access.js:
//   - read the TRUE mode from the box, toggle open <-> restricted (owner-IRK),
//   - allow-list: add a person (name + optional photo -> seal bundle under the
//     household key -> IRK-sign create -> POST .com -> return the share-link),
//     list (decrypt bundle locally), remove (IRK-signed revoke).
// The author IRK signs create/revoke; the friend's STABLE AID is the recorded
// principal. .com stores only ciphertext + the secretHash.

package com.flagshipserver.app.viewmodels

import android.content.Context
import androidx.lifecycle.ViewModel
import com.flagshipserver.app.api.ServiceAccessClient
import com.flagshipserver.app.core.HexUtil
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

data class AccessPerson(
    val inviteId: String,
    val name: String,
    val photo: String?,
    val bound: Boolean,
)

class ServiceAccessViewModel(
    private val serverDomain: String,
    private val serviceRef: String,
    private val username: String,
    private val client: ServiceAccessClient = ServiceAccessClient(),
    /** IRK signer (set-mode + revoke + the create). */
    private val irkSigner: suspend (reason: String) -> Ed25519Sign = { r -> Keystore.deriveIRK(r) },
    /** The author's current device (IRK) pub (hex) — the inviteId attribution. */
    private val devicePubHex: suspend () -> String = { Keystore.irkPubHex() },
    /** Stable AID pub (hex) — the author identity recorded in invites. */
    private val aidPubHex: suspend (reason: String) -> String = { r -> Keystore.accountIdPubHex(r) },
    /** Household key — seals/opens the {name, photo?} bundle. */
    private val householdKey: suspend (reason: String) -> ByteArray = { r -> Keystore.deriveHouseholdKey(r) },
    private val now: () -> Long = { System.currentTimeMillis() },
    private val counter: () -> Int = ServiceInviteCounter::next,
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

    /** Mint a capability invite; returns the share-link (also in lastInviteLink). */
    suspend fun addPerson(name: String, photo: String?): String? {
        if (_busyAdd.value) return null
        val trimmed = name.trim()
        if (trimmed.isEmpty()) return null
        _busyAdd.value = true
        return try {
            val key = irkSigner("Create an invite for $serviceRef")
            val aid = HexUtil.decode(aidPubHex("Create an invite for $serviceRef"))!!
            val device = HexUtil.decode(devicePubHex())!!
            val hh = householdKey("Create an invite for $serviceRef")
            val secret = ServiceInvite.randomSecret()
            val secretHash = ServiceInvite.secretHash(secret)
            val inviteId = ServiceInvite.inviteId(aid, device, counter())
            val encryptedBundle = ServiceInvite.sealBundle(ServiceInvite.Bundle(trimmed, photo), hh, inviteId)
            val ts = now()
            val bytes = ServiceInvite.canonicalCreate(inviteId, aid, serviceRef, secretHash, encryptedBundle, ts)
            val sig = key.sign(bytes)
            val request: JsonObject = buildJsonObject {
                put("inviteId", JsonPrimitive(inviteId))
                put("authorAID", JsonPrimitive(HexUtil.encode(aid)))
                put("serviceRef", JsonPrimitive(serviceRef))
                put("secretHash", JsonPrimitive(secretHash))
                put("encryptedBundle", JsonPrimitive(encryptedBundle))
                put("issuedAt", JsonPrimitive(ts))
            }
            client.createInvite(username, request, HexUtil.encode(sig))
            val link = "https://$serverDomain/invite#${HexUtil.encode(secret)}"
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

    /** IRK-signed revoke -> the friend's next visit is denied. */
    suspend fun remove(inviteId: String) {
        try {
            val key = irkSigner("Remove this person from $serviceRef")
            val ts = now()
            val bytes = ServiceInvite.canonicalRevoke(inviteId, ts)
            val sig = key.sign(bytes)
            val request: JsonObject = buildJsonObject {
                put("inviteId", JsonPrimitive(inviteId))
                put("issuedAt", JsonPrimitive(ts))
            }
            client.revokeInvite(username, request, HexUtil.encode(sig))
            refreshPeople()
        } catch (e: Throwable) {
            _phase.value = ServiceAccessPhase.Failed("Couldn't remove them. Try again in a moment.")
        }
    }

    /** List the author's live invites for this service from .com, decrypting
     *  each bundle locally with the household key. */
    suspend fun refreshPeople() {
        try {
            val aid = HexUtil.decode(aidPubHex("Show who can open $serviceRef"))!!
            val hh = householdKey("Show who can open $serviceRef")
            val rows = client.listInvites(username, HexUtil.encode(aid))
            _people.value = rows
                .filter { it.serviceRef == serviceRef && it.revokedAt == null }
                .map { row ->
                    var name = "unknown"
                    var photo: String? = null
                    runCatching { ServiceInvite.openBundle(row.encryptedBundleHex, hh, row.inviteId) }
                        .getOrNull()?.let { name = it.name; photo = it.photo }
                    AccessPerson(row.inviteId, name, photo, row.boundAidHex != null)
                }
        } catch (e: Throwable) {
            // keep the last list; load-phase error already surfaced
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

/** Best-effort monotonic per-(account, device) invite counter (process-lifetime
 *  in-memory; the daemon + .com also dedup by inviteId). Mirrors the webapp's
 *  nextInviteCounter / iOS ServiceInviteCounter. */
object ServiceInviteCounter {
    private var n = 0
    @Synchronized fun next(): Int = n++
}
