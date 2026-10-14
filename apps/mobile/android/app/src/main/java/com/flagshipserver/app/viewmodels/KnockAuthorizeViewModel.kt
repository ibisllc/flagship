// Web-experience gating authorizer (docs/service-access-gating.md,
// "Web-experience gating"). The visitor's phone AID-signs a KnockAuthorization
// binding the browser's pageId, POSTs it to the BOX (over its pinned pipe —
// .com is never in the path), and on success persists a SecuredSession so the
// user can later see / refresh / stop the browser session from Settings.
//
// The box accepts its owner's AID and the AIDs on the app's allow-list
// (docs/app-apis.md §5). Invites put the friend's id for THAT app on the list,
// so the identity depends on the box: one of our own servers gets the global
// AID; a box we were invited to (remembered at redeem, InviteOwnerBook) gets
// deriveAppAccountId(UMK, serviceRef) for the knock's app. A record naming our
// own AID is ignored: the invite's author wrote it. A box that is neither in
// the loaded pods nor remembered triggers one fresh pods load (a cold start from
// a deep link may not have loaded them yet); still unknown, nothing is signed or
// sent, so a stranger's box never learns an AID of ours. On success the box
// returns the phone-held secretId (never to the browser).

package com.flagshipserver.app.viewmodels

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
import com.flagshipserver.app.core.ServiceInvite
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
    val title: String get() = if (svc.isBlank()) "Open $serverName?" else "Open $svc on $serverName?"

    suspend fun authorize() {
        if (_phase.value is KnockAuthorizePhase.Authorizing) return
        if (serverId.isEmpty() || serviceRef.isEmpty() || pageId.isEmpty()) {
            _phase.value = KnockAuthorizePhase.Failed("This link is missing or malformed.")
            return
        }
        _phase.value = KnockAuthorizePhase.Authorizing
        val host = InviteOwnerBook.normHost(serverId)
        fun List<String>.hasBox() = any { InviteOwnerBook.normHost(it) == host }
        try {
            val reason = title.removeSuffix("?")
            val key: Ed25519Sign
            val aidPub: ByteArray
            // A record's owner AID is whatever the invite link's author wrote, so
            // it can only ever pick the per-app id: a record naming our own
            // global AID is ignored (a hostile owner could plant it to harvest
            // that AID). "Own box" comes only from our pods directory.
            val ownerHex = if (ownServers().hasBox()) null else owners.ownerFor(serverId)
                ?.takeIf { it != aidPubHex(reason).lowercase() }
            if (ownerHex != null && ServerKeys.isAppRef(serviceRef)) {
                key = appAidSigner(serviceRef, reason)
                aidPub = HexUtil.decode(appAidPubHex(serviceRef, reason))!!
            } else {
                val isOwnServer = ownServers().hasBox() ||
                    runCatching { reloadOwnServers() }.getOrDefault(emptyList()).hasBox()
                if (!isOwnServer) {
                    _phase.value = KnockAuthorizePhase.Failed(NOT_YOURS)
                    return
                }
                key = aidSigner(reason)
                aidPub = HexUtil.decode(aidPubHex(reason))!!
            }
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
        } catch (e: KnockAuthorizeError) {
            _phase.value = KnockAuthorizePhase.Failed(
                when (e) {
                    is KnockAuthorizeError.NotAllowed -> "You don't have access to this service."
                    is KnockAuthorizeError.Refused -> "Couldn't sign in. Refresh the page and try again."
                    is KnockAuthorizeError.PageExpired -> "The page expired — refresh it and try again."
                },
            )
        } catch (e: Throwable) {
            _phase.value = KnockAuthorizePhase.Failed("Couldn't reach the server. Check your connection and try again.")
        }
    }

    companion object {
        const val NOT_YOURS = "This isn't one of your servers. Open its invite link on this phone first, then try again."
    }
}
