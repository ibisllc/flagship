// Web-experience gating authorizer (docs/service-access-gating.md,
// "Web-experience gating" and "Who is signing in"). The visitor's phone signs a
// KnockAuthorization binding the browser's pageId, POSTs it to the BOX (over
// its pinned pipe — .com is never in the path), and on success persists a
// SecuredSession so the user can later see / refresh / stop the browser
// session from Settings.
//
// The signing key (the `visitorAID`) depends on the box, which classifies it
// itself: one of this account's own servers gets this device's account device
// key (so the box knows which device, and its rank, signed in); a server
// shared WITH this account gets that share's member key; a box we were
// invited to (remembered at redeem, InviteOwnerBook) gets
// deriveAppAccountId(UMK, serviceRef) for the knock's app. Neither the device
// key nor a share key is ever shown to any other box. A record naming our own
// AID is ignored: the invite's author wrote it. A box found nowhere triggers
// one fresh pods load and one share-inbox read (a cold start from a deep link
// may not have loaded them yet); still unknown, nothing is signed or sent, so
// a stranger's box never learns a key of ours. On success the box returns the
// phone-held secretId (never to the browser).

package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.core.FSStrings
import com.flagshipserver.app.R
import androidx.lifecycle.ViewModel
import com.flagshipserver.app.api.KnockAuthorizeError
import com.flagshipserver.app.api.KnockAuthorizeResult
import com.flagshipserver.app.api.ServiceAccessClient
import com.flagshipserver.app.core.HexUtil
import com.flagshipserver.app.core.ServerKeys
import com.flagshipserver.app.core.InviteOwnerBook
import com.flagshipserver.app.core.InviteOwners
import com.flagshipserver.app.core.SecuredSession
import com.flagshipserver.app.core.SecuredSessionStore
import com.flagshipserver.app.core.ServerShare
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

sealed interface KnockAuthorizePhase {
    data object Idle : KnockAuthorizePhase
    data object Authorizing : KnockAuthorizePhase
    data class Done(val serviceRef: String, val browserAgent: String) : KnockAuthorizePhase
    data class Failed(val message: String) : KnockAuthorizePhase
}

class KnockAuthorizeViewModel(
    private val serverId: String,
    private val svc: String,
    private val serviceRef: String,
    private val pageId: String,
    private val client: ServiceAccessClient = ServiceAccessClient(),
    /** The user's GLOBAL AID signer + pub (biometric-gated by default). */
    private val aidSigner: suspend (reason: String) -> Ed25519Sign = { r -> Keystore.deriveAccountId(r) },
    private val aidPubHex: suspend (reason: String) -> String = { r -> Keystore.accountIdPubHex(r) },
    /** The user's id for an app, signer + pub (biometric-gated by default). */
    private val appAidSigner: suspend (serviceRef: String, reason: String) -> Ed25519Sign =
        { s, r -> Keystore.deriveAppAccountId(s, r) },
    private val appAidPubHex: suspend (serviceRef: String, reason: String) -> String =
        { s, r -> Keystore.appAccountIdPubHex(s, r) },
    /** This device's account device key (signer + pub), which signs in on the
     *  account's own servers; null when the device has no device id yet (the
     *  global AID signs then, which the box counts as a non-admin device). */
    private val deviceKey: suspend (reason: String) -> Pair<Ed25519Sign, ByteArray>? = { null },
    /** Servers shared WITH this account, (domain, shareId): the loaded "Shared
     *  with me" list, or with `fetch` this account's share inbox. */
    private val sharedServers: suspend (fetch: Boolean) -> List<Pair<String, String>> = { emptyList() },
    /** The share's member key (signer + pub), shown only to that share's server. */
    private val shareKey: suspend (shareId: String, reason: String) -> Pair<Ed25519Sign, ByteArray> = { id, r ->
        BiometricAuthority.current()?.ensureFresh(title = FSStrings.get(R.string.authorize_flagship), subtitle = r)
        val umk = Keystore.loadOrCreateUmkSeed()
        ServerShare.deriveShareMemberKey(umk, id) to ServerShare.deriveShareMemberPub(umk, id)
    },
    /** FQDNs of the user's own servers (the app's pods). */
    private val ownServers: () -> List<String> = { emptyList() },
    /** Load the user's servers afresh (the `.com` pods directory); used once,
     *  only when the box is neither in [ownServers] nor remembered. */
    private val reloadOwnServers: suspend () -> List<String> = { emptyList() },
    /** Owner AIDs remembered from redeemed invites, by box. */
    private val owners: InviteOwnerBook = InviteOwners.book,
    private val now: () -> Long = { System.currentTimeMillis() },
    /** Persist the authorized session. Injectable for tests. */
    private val persist: (SecuredSession) -> Unit = { SecuredSessionStore.upsert(it) },
) : ViewModel() {
    private val _phase = MutableStateFlow<KnockAuthorizePhase>(KnockAuthorizePhase.Idle)
    val phase: StateFlow<KnockAuthorizePhase> = _phase.asStateFlow()

    /** Display: `<svc>.<server>` (or just `<server>` for an apex service). */
    val target: String get() = if (svc.isBlank()) serverId else "$svc.$serverId"

    /** The box's short name: the first label of [serverId]. */
    val serverName: String get() = serverId.substringBefore('.').ifEmpty { serverId }

    /** "Open <app> on <server>?" (or "Open <server>?" for an apex service). */
    val title: String get() = if (svc.isBlank()) FSStrings.get(R.string.open_3, serverName) else FSStrings.get(R.string.open_on, svc, serverName)

    suspend fun authorize() {
        if (_phase.value is KnockAuthorizePhase.Authorizing) return
        if (serverId.isEmpty() || serviceRef.isEmpty() || pageId.isEmpty()) {
            _phase.value = KnockAuthorizePhase.Failed(FSStrings.get(R.string.this_link_is_missing_or_malformed))
            return
        }
        _phase.value = KnockAuthorizePhase.Authorizing
        val host = InviteOwnerBook.normHost(serverId)
        fun List<String>.hasBox() = any { InviteOwnerBook.normHost(it) == host }
        try {
            val reason = title.removeSuffix("?")
            // On our own servers we sign with this device's account device
            // key, never the account-wide AID (per-app identity; the webapp's
            // knockIdentity refuses the same way).
            suspend fun ownKey(): Pair<Ed25519Sign, ByteArray> =
                deviceKey(reason) ?: throw NoDeviceKey()
            suspend fun shareFor(fetch: Boolean): String? =
                runCatching { sharedServers(fetch) }.getOrDefault(emptyList())
                    .firstOrNull { InviteOwnerBook.normHost(it.first) == host }?.second
            suspend fun reloadedOwnKey(): Pair<Ed25519Sign, ByteArray>? =
                if (runCatching { reloadOwnServers() }.getOrDefault(emptyList()).hasBox()) ownKey() else null
            // A record's owner AID is whatever the invite link's author wrote, so
            // it can only ever pick the per-app id: a record naming our own
            // global AID is ignored (a hostile owner could plant it to harvest
            // that AID). "Own box" comes only from our pods directory, "shared
            // with us" only from our own share inbox.
            suspend fun invitedKey(): Pair<Ed25519Sign, ByteArray>? {
                if (!ServerKeys.isAppRef(serviceRef)) return null
                owners.ownerFor(serverId)?.takeIf { it != aidPubHex(reason).lowercase() } ?: return null
                return appAidSigner(serviceRef, reason) to HexUtil.decode(appAidPubHex(serviceRef, reason))!!
            }
            val identity: Pair<Ed25519Sign, ByteArray>? =
                if (ownServers().hasBox()) {
                    ownKey()
                } else {
                    shareFor(fetch = false)?.let { shareKey(it, reason) }
                        ?: invitedKey()
                        ?: reloadedOwnKey()
                        ?: shareFor(fetch = true)?.let { shareKey(it, reason) }
                }
            if (identity == null) {
                _phase.value = KnockAuthorizePhase.Failed(NOT_YOURS)
                return
            }
            val (key, aidPub) = identity
            val issuedAt = now()
            val sig = ServiceInvite.signKnockAuthorization(serverId, serviceRef, pageId, aidPub, issuedAt, key)
            val request: JsonObject = buildJsonObject {
                put("serverId", JsonPrimitive(serverId))
                put("serviceRef", JsonPrimitive(serviceRef))
                put("pageId", JsonPrimitive(pageId))
                put("visitorAID", JsonPrimitive(HexUtil.encode(aidPub)))
                put("issuedAt", JsonPrimitive(issuedAt))
            }
            val result: KnockAuthorizeResult = client.authorizeKnock(request, HexUtil.encode(sig))
            persist(
                SecuredSession(
                    secretId = result.secretId,
                    serverId = serverId,
                    serviceRef = result.serviceRef.ifEmpty { serviceRef },
                    serviceUrl = SecuredSessionStore.serviceUrl(serverId, svc),
                    browserAgent = result.browserAgent,
                    startedAt = if (result.startedAt > 0) result.startedAt else issuedAt,
                ),
            )
            _phase.value = KnockAuthorizePhase.Done(
                serviceRef = result.serviceRef.ifEmpty { serviceRef },
                browserAgent = result.browserAgent,
            )
        } catch (_: NoDeviceKey) {
            _phase.value = KnockAuthorizePhase.Failed(NO_DEVICE_KEY)
        } catch (e: KnockAuthorizeError) {
            _phase.value = KnockAuthorizePhase.Failed(
                when (e) {
                    is KnockAuthorizeError.NotAllowed -> FSStrings.get(R.string.you_dont_have_access_to_this)
                    is KnockAuthorizeError.Refused -> FSStrings.get(R.string.couldnt_sign_in_refresh_the_page)
                    is KnockAuthorizeError.PageExpired -> FSStrings.get(R.string.the_page_expired_refresh_it_and)
                },
            )
        } catch (e: Throwable) {
            _phase.value = KnockAuthorizePhase.Failed(FSStrings.get(R.string.couldnt_reach_the_server_check_your))
        }
    }

    companion object {
        val NO_DEVICE_KEY get() =
            FSStrings.get(R.string.this_device_isnt_set_up_on)
        val NOT_YOURS get() = FSStrings.get(R.string.this_isnt_one_of_your_servers)
    }
}

/** This device has no account device id, so it can't sign on its own servers. */
private class NoDeviceKey : Exception()
