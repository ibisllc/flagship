// Web-experience gating authorizer (docs/service-access-gating.md,
// "Web-experience gating"). The visitor's phone AID-signs a KnockAuthorization
// binding the browser's pageId, POSTs it to the BOX (over its pinned pipe —
// .com is never in the path), and on success persists a SecuredSession so the
// user can later see / refresh / stop the browser session from Settings.
//
// Signing rides the SAME stable AID + biometric gate the invite-redeem flow
// uses (Keystore.deriveAccountId). The box checks the signature + that the AID
// is allow-listed for the (restricted) service, mints a browser session, and
// returns the phone-held secretId (never to the browser).

package com.flagshipserver.app.viewmodels

import androidx.lifecycle.ViewModel
import com.flagshipserver.app.api.KnockAuthorizeError
import com.flagshipserver.app.api.KnockAuthorizeResult
import com.flagshipserver.app.api.ServiceAccessClient
import com.flagshipserver.app.core.HexUtil
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
    /** Friend's AID signer + pub (biometric-gated by default). */
    private val aidSigner: suspend (reason: String) -> Ed25519Sign = { r -> Keystore.deriveAccountId(r) },
    private val aidPubHex: suspend (reason: String) -> String = { r -> Keystore.accountIdPubHex(r) },
    private val now: () -> Long = { System.currentTimeMillis() },
    /** Persist the authorized session. Injectable for tests. */
    private val persist: (SecuredSession) -> Unit = { SecuredSessionStore.upsert(it) },
) : ViewModel() {
    private val _phase = MutableStateFlow<KnockAuthorizePhase>(KnockAuthorizePhase.Idle)
    val phase: StateFlow<KnockAuthorizePhase> = _phase.asStateFlow()

    /** Display: `<svc>.<server>` (or just `<server>` for an apex service). */
    val target: String get() = if (svc.isBlank()) serverId else "$svc.$serverId"

    suspend fun authorize() {
        if (_phase.value is KnockAuthorizePhase.Authorizing) return
        if (serverId.isEmpty() || serviceRef.isEmpty() || pageId.isEmpty()) {
            _phase.value = KnockAuthorizePhase.Failed("This link is missing or malformed.")
            return
        }
        _phase.value = KnockAuthorizePhase.Authorizing
        try {
            val reason = "Authorize this site"
            val key = aidSigner(reason)
            val aidPub = HexUtil.decode(aidPubHex(reason))!!
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
                    is KnockAuthorizeError.Refused -> "Couldn't authorize — try refreshing the page."
                    is KnockAuthorizeError.PageExpired -> "The page expired — refresh it and try again."
                },
            )
        } catch (e: Throwable) {
            _phase.value = KnockAuthorizePhase.Failed("Couldn't reach the server. Check your connection and try again.")
        }
    }
}
