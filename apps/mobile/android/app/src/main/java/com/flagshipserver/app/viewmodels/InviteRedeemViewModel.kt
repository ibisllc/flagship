// Friend-side redeem orchestrator (docs/service-access-gating.md). Mirror of iOS
// InviteRedeemViewModel + the webapp views/invite-redeem.js. AID-signs the
// redeem over { secretHash, visitorAID, redeemedAt } with the friend's STABLE
// AID and POSTs the raw secret to the BOX's redeem endpoint; the box re-verifies
// the AID sig, delegates first-bind to .com, then allow-lists the AID.

package com.flagshipserver.app.viewmodels

import androidx.lifecycle.ViewModel
import com.flagshipserver.app.api.RedeemResult
import com.flagshipserver.app.api.ServiceAccessClient
import com.flagshipserver.app.api.ServiceAccessError
import com.flagshipserver.app.core.HexUtil
import com.flagshipserver.app.core.ServiceInvite
import com.flagshipserver.app.keystore.Keystore
import com.google.crypto.tink.subtle.Ed25519Sign
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

sealed interface InviteRedeemPhase {
    data object Idle : InviteRedeemPhase
    data object Redeeming : InviteRedeemPhase
    data class Done(val serviceRef: String, val firstBind: Boolean) : InviteRedeemPhase
    data class Failed(val message: String) : InviteRedeemPhase
}

class InviteRedeemViewModel(
    private val serverDomain: String,
    private val secretHex: String,
    private val client: ServiceAccessClient = ServiceAccessClient(),
    /** Friend's AID signer + pub. */
    private val aidSigner: suspend (reason: String) -> Ed25519Sign = { r -> Keystore.deriveAccountId(r) },
    private val aidPubHex: suspend (reason: String) -> String = { r -> Keystore.accountIdPubHex(r) },
    private val now: () -> Long = { System.currentTimeMillis() },
) : ViewModel() {
    private val _phase = MutableStateFlow<InviteRedeemPhase>(InviteRedeemPhase.Idle)
    val phase: StateFlow<InviteRedeemPhase> = _phase.asStateFlow()

    val serverHost: String get() = serverDomain
    private val secret = secretHex.lowercase()

    suspend fun redeem() {
        if (_phase.value is InviteRedeemPhase.Redeeming) return
        if (!Regex("^[0-9a-f]{64}$").matches(secret)) {
            _phase.value = InviteRedeemPhase.Failed("This invite link is missing or malformed.")
            return
        }
        _phase.value = InviteRedeemPhase.Redeeming
        try {
            val key = aidSigner("Accept this invite")
            val aidPub = HexUtil.decode(aidPubHex("Accept this invite"))!!
            val secretBytes = HexUtil.decode(secret) ?: run {
                _phase.value = InviteRedeemPhase.Failed("This invite link is malformed."); return
            }
            val secretHash = ServiceInvite.secretHash(secretBytes)
            val ts = now()
            val bytes = ServiceInvite.canonicalRedeem(secretHash, aidPub, ts)
            val sig = key.sign(bytes)
            val result: RedeemResult = client.redeemInvite(
                serverDomain, secret, HexUtil.encode(aidPub), HexUtil.encode(sig), ts,
            )
            _phase.value = InviteRedeemPhase.Done(result.serviceRef, result.firstBind)
        } catch (e: ServiceAccessError) {
            _phase.value = InviteRedeemPhase.Failed(
                when (e) {
                    is ServiceAccessError.InviteUnknown -> "This invite link is unknown or was withdrawn."
                    is ServiceAccessError.InviteAlreadyBound -> "This invite is already linked to another account."
                    is ServiceAccessError.InviteRevoked -> "This invite has been revoked."
                },
            )
        } catch (e: Throwable) {
            _phase.value = InviteRedeemPhase.Failed("Couldn't reach the server. Check your connection and try again.")
        }
    }
}
