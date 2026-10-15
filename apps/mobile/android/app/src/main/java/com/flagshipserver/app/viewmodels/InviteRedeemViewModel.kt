// Friend-side redeem orchestrator (docs/service-access-gating.md §v2 hardening).
// Mirror of iOS InviteRedeemViewModel + the webapp views/invite-redeem.js.
//
// The friend presents their id for THE invite's app (deriveAppAccountId(UMK,
// serviceRef), the link's `s=`) — never the global AID — so nothing they present
// is shared between apps, and it is the same whoever invited them. A link
// without `s=` (made before per-app ids) is refused: ask for a new one.
//
// Two outcomes:
//   - AUTO-approve  -> Done (bound).
//   - MANUAL-approve -> the box returns {pending} + the owner's signed create; we
//     emit a contact-AID-signed AcceptServiceInvite, bundle it WITH the create
//     into a reply the friend sends BACK through the same private channel, and the
//     AUTHOR finalizes the bind on their own box.

package com.flagshipserver.app.viewmodels

import androidx.lifecycle.ViewModel
import com.flagshipserver.app.api.RedeemResult
import com.flagshipserver.app.api.ServiceAccessClient
import com.flagshipserver.app.api.ServiceAccessError
import com.flagshipserver.app.core.HexUtil
import com.flagshipserver.app.core.InviteLink
import com.flagshipserver.app.core.InviteOwnerBook
import com.flagshipserver.app.core.InviteOwners
import com.flagshipserver.app.core.ServerKeys
import com.flagshipserver.app.core.ServiceInvite
import com.flagshipserver.app.keystore.Keystore
import com.google.crypto.tink.subtle.Ed25519Sign
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive

sealed interface InviteRedeemPhase {
    data object Idle : InviteRedeemPhase
    data object Redeeming : InviteRedeemPhase
    data class Done(val serviceRef: String, val firstBind: Boolean) : InviteRedeemPhase
    /** MANUAL-approve: redeem accepted but pending the author's confirmation. The
     *  friend must send [replyLink] (an `https://flagshipserver.com/invite-accept#…` link + QR) back to
     *  the author through the same private channel; the author finalizes. */
    data class AwaitingApproval(val serviceRef: String, val replyLink: String, val replyBody: String) : InviteRedeemPhase
    data class Failed(val message: String) : InviteRedeemPhase
}

class InviteRedeemViewModel(
    private val serverDomain: String,
    private val secretHex: String,
    /** Author AID (hex) parsed from the invite link, or null for a legacy link. */
    private val authorAidHex: String? = null,
    /** Invite id (hex) parsed from the link's `i=` param (manual-approve tier).
     *  The friend signs the acceptance over THIS id; null for an auto/group or a
     *  legacy link (then the box-relayed create's inviteId is used). */
    private val inviteIdHex: String? = null,
    /** The app the invite is for (the link's `s=`): selects the friend's id. */
    private val serviceRef: String? = null,
    private val client: ServiceAccessClient = ServiceAccessClient(),
    /** The friend's id for an app (the redemption identity). */
    private val appAidSigner: suspend (serviceRef: String, reason: String) -> Ed25519Sign =
        { s, r -> Keystore.deriveAppAccountId(s, r) },
    private val appAidPubHex: suspend (serviceRef: String, reason: String) -> String =
        { s, r -> Keystore.appAccountIdPubHex(s, r) },
    private val now: () -> Long = { System.currentTimeMillis() },
    /** Where a redeem records the box (and its owner AID), so a later knock on
     *  it can sign with the friend's id for the knock's app. */
    private val owners: InviteOwnerBook = InviteOwners.book,
) : ViewModel() {
    private val _phase = MutableStateFlow<InviteRedeemPhase>(InviteRedeemPhase.Idle)
    val phase: StateFlow<InviteRedeemPhase> = _phase.asStateFlow()

    val serverHost: String get() = serverDomain
    private val secret = secretHex.lowercase()
    private val authorAid = authorAidHex?.lowercase()?.takeIf { Regex("^[0-9a-f]{64}$").matches(it) }
    private val linkInviteId = inviteIdHex?.lowercase()?.takeIf { Regex("^[0-9a-f]{64}$").matches(it) }
    private val appRef = serviceRef?.takeIf { ServerKeys.isAppRef(it) }

    suspend fun redeem() {
        if (_phase.value is InviteRedeemPhase.Redeeming) return
        if (!Regex("^[0-9a-f]{64}$").matches(secret)) {
            _phase.value = InviteRedeemPhase.Failed("This invite link is missing or malformed.")
            return
        }
        val ref = appRef ?: run {
            _phase.value = InviteRedeemPhase.Failed(OLD_LINK)
            return
        }
        _phase.value = InviteRedeemPhase.Redeeming
        try {
            val reason = "Accept this invite"
            val redeemPub = HexUtil.decode(appAidPubHex(ref, reason))!!
            val redeemSigner = appAidSigner(ref, reason)
            val secretBytes = HexUtil.decode(secret) ?: run {
                _phase.value = InviteRedeemPhase.Failed("This invite link is malformed."); return
            }
            val secretHash = ServiceInvite.secretHash(secretBytes)
            val ts = now()
            val bytes = ServiceInvite.canonicalRedeem(secretHash, redeemPub, ts)
            val sig = redeemSigner.sign(bytes)
            val result: RedeemResult = client.redeemInvite(
                serverDomain, secret, HexUtil.encode(redeemPub), HexUtil.encode(sig), ts,
            )
            if (authorAid != null) owners.remember(serverDomain, authorAid)
            if (result.pending) {
                emitAcceptance(result, redeemPub, redeemSigner)
            } else {
                _phase.value = InviteRedeemPhase.Done(result.serviceRef, result.firstBind)
            }
        } catch (e: ServiceAccessError) {
            _phase.value = InviteRedeemPhase.Failed(
                when (e) {
                    is ServiceAccessError.InviteUnknown -> "This invite link is unknown or was withdrawn."
                    is ServiceAccessError.InviteAlreadyBound -> "This invite is already linked to another account."
                    is ServiceAccessError.InviteRevoked -> "This invite has been revoked."
                    is ServiceAccessError.InviteExpiredOrFull -> "This invite has expired or is full."
                },
            )
        } catch (e: Throwable) {
            _phase.value = InviteRedeemPhase.Failed("Couldn't reach the server. Check your connection and try again.")
        }
    }

    /** Build the acceptance reply for the MANUAL-approve loop: sign an
     *  AcceptServiceInvite with the SAME (contact) AID and surface the canonical
     *  `https://<control>/invite-accept#…` reply (link + QR) carrying ONLY {accept,
     *  acceptSig}. The box-relayed create is used only to learn what to sign over
     *  (inviteId / serviceRef) — it is NOT shipped (the author's box fetches the
     *  signed create from .com at finalize). */
    private fun emitAcceptance(result: RedeemResult, contactPub: ByteArray, signer: Ed25519Sign) {
        val create = result.createJson
        // The friend signs the acceptance over the inviteId the AUTHOR created the
        // invite under. The canonical source is the link's `i=` param; fall back to
        // the box-relayed create's inviteId for a legacy (no-`i=`) link.
        val inviteId = linkInviteId ?: create?.get("inviteId")?.jsonPrimitive?.contentOrNull
        val serviceRef = create?.get("serviceRef")?.jsonPrimitive?.contentOrNull ?: result.serviceRef
        if (inviteId == null) {
            // The box accepted the redeem as pending but the inviteId is unknown —
            // can't form a verifiable acceptance. Surface a clear failure.
            _phase.value = InviteRedeemPhase.Failed("This invite needs the owner's approval, but the server didn't return the details. Try again.")
            return
        }
        val ts = now()
        val acceptSig = ServiceInvite.signAcceptServiceInvite(inviteId, serviceRef, contactPub, ts, signer)
        val accept: JsonObject = buildJsonObject {
            put("inviteId", JsonPrimitive(inviteId))
            put("serviceRef", JsonPrimitive(serviceRef))
            put("contactAID", JsonPrimitive(HexUtil.encode(contactPub)))
            put("acceptedAt", JsonPrimitive(ts))
        }
        val reply = InviteLink.buildAcceptReply(serverDomain, accept, HexUtil.encode(acceptSig))
        _phase.value = InviteRedeemPhase.AwaitingApproval(serviceRef, reply, reply)
    }

    companion object {
        /** Shown for a link made before per-app ids (no `s=`). */
        const val OLD_LINK = "This invite link is from an older version of Flagship. Ask the owner for a new link."
    }
}
