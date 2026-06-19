// Friend-side redeem orchestrator (docs/service-access-gating.md §v2 hardening).
// Mirror of iOS InviteRedeemViewModel + the webapp views/invite-redeem.js.
//
// v2: the friend presents a PER-AUTHOR contact AID (deriveContactAccountId(UMK,
// authorAID)) — NOT the global AID — so two authors can't cross-link them. The
// author's AID is carried IN the invite link; if a (legacy) link omits it, we
// fall back to the global AID (existing global-AID bindings are grandfathered).
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
     *  friend must send [replyLink] (a `flagship://accept?b=…` link + QR) back to
     *  the author through the same private channel; the author finalizes. */
    data class AwaitingApproval(val serviceRef: String, val replyLink: String, val replyBody: String) : InviteRedeemPhase
    data class Failed(val message: String) : InviteRedeemPhase
}

class InviteRedeemViewModel(
    private val serverDomain: String,
    private val secretHex: String,
    /** Author AID (hex) parsed from the invite link, or null for a legacy link. */
    private val authorAidHex: String? = null,
    private val client: ServiceAccessClient = ServiceAccessClient(),
    /** Friend's GLOBAL AID (fallback when a legacy link carries no author AID). */
    private val globalAidSigner: suspend (reason: String) -> Ed25519Sign = { r -> Keystore.deriveAccountId(r) },
    private val globalAidPubHex: suspend (reason: String) -> String = { r -> Keystore.accountIdPubHex(r) },
    /** Friend's PER-AUTHOR contact AID (the v2 redemption identity). */
    private val contactAidSigner: suspend (authorAid: ByteArray, reason: String) -> Ed25519Sign =
        { a, r -> Keystore.deriveContactAccountId(a, r) },
    private val contactAidPubHex: suspend (authorAid: ByteArray, reason: String) -> String =
        { a, r -> Keystore.contactAccountIdPubHex(a, r) },
    private val now: () -> Long = { System.currentTimeMillis() },
) : ViewModel() {
    private val _phase = MutableStateFlow<InviteRedeemPhase>(InviteRedeemPhase.Idle)
    val phase: StateFlow<InviteRedeemPhase> = _phase.asStateFlow()

    val serverHost: String get() = serverDomain
    private val secret = secretHex.lowercase()
    private val authorAid = authorAidHex?.lowercase()?.takeIf { Regex("^[0-9a-f]{64}$").matches(it) }

    suspend fun redeem() {
        if (_phase.value is InviteRedeemPhase.Redeeming) return
        if (!Regex("^[0-9a-f]{64}$").matches(secret)) {
            _phase.value = InviteRedeemPhase.Failed("This invite link is missing or malformed.")
            return
        }
        _phase.value = InviteRedeemPhase.Redeeming
        try {
            // v2: per-author contact AID when the link carries the author; else the
            // global AID (legacy links are grandfathered).
            val reason = "Accept this invite"
            val authorBytes = authorAid?.let { HexUtil.decode(it) }
            val redeemPub: ByteArray
            val redeemSigner: Ed25519Sign
            if (authorBytes != null) {
                redeemPub = HexUtil.decode(contactAidPubHex(authorBytes, reason))!!
                redeemSigner = contactAidSigner(authorBytes, reason)
            } else {
                redeemPub = HexUtil.decode(globalAidPubHex(reason))!!
                redeemSigner = globalAidSigner(reason)
            }
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
     *  AcceptServiceInvite with the SAME (contact) AID, bundle it with the owner's
     *  relayed create, and surface a `flagship://accept?b=…` reply (link + QR). */
    private fun emitAcceptance(result: RedeemResult, contactPub: ByteArray, signer: Ed25519Sign) {
        val create = result.createJson
        val createSig = result.createSigHex
        val inviteId = create?.get("inviteId")?.jsonPrimitive?.contentOrNull
        val serviceRef = create?.get("serviceRef")?.jsonPrimitive?.contentOrNull ?: result.serviceRef
        if (create == null || createSig == null || inviteId == null) {
            // The box accepted the redeem as pending but didn't relay the create —
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
        val body = InviteLink.encodeAcceptance(accept, HexUtil.encode(acceptSig), create, createSig)
        _phase.value = InviteRedeemPhase.AwaitingApproval(serviceRef, InviteLink.acceptanceLink(body), body)
    }
}
