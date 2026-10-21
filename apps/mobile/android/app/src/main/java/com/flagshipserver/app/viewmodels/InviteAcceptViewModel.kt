// Author-side MANUAL-approve finalize from a tapped or scanned reply link
// (docs/service-access-gating.md, "## v2 hardening", tier 2). Mirror of iOS
// InviteAcceptViewModel. The friend's reply carries ONLY {accept, acceptSig};
// this phone POSTs them to the box the reply names, which fetches the owner's
// signed create from `.com` by inviteId, verifies both, then binds the friend.
// No biometric: the author is only a courier of the friend's signed acceptance.

package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.core.FSStrings
import com.flagshipserver.app.R
import com.flagshipserver.app.api.ServiceAccessClient
import com.flagshipserver.app.api.ServiceAccessError
import com.flagshipserver.app.core.InviteLink
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive

sealed interface InviteAcceptPhase {
    data object Idle : InviteAcceptPhase
    data object Submitting : InviteAcceptPhase
    data class Done(val serviceRef: String) : InviteAcceptPhase
    data class Failed(val message: String) : InviteAcceptPhase
}

class InviteAcceptViewModel(
    rawReply: String,
    private val client: ServiceAccessClient = ServiceAccessClient(),
) {
    private val acceptance = InviteLink.decodeAcceptance(rawReply)?.takeIf { it.serverDomain != null }

    val serverDomain: String? = acceptance?.serverDomain
    val serviceRef: String = acceptance?.accept?.get("serviceRef")?.jsonPrimitive?.contentOrNull.orEmpty()

    private val _phase = MutableStateFlow<InviteAcceptPhase>(
        if (acceptance == null) InviteAcceptPhase.Failed(MALFORMED) else InviteAcceptPhase.Idle,
    )
    val phase: StateFlow<InviteAcceptPhase> = _phase.asStateFlow()

    suspend fun approve() {
        val a = acceptance ?: return
        val server = a.serverDomain ?: return
        if (_phase.value is InviteAcceptPhase.Submitting || _phase.value is InviteAcceptPhase.Done) return
        _phase.value = InviteAcceptPhase.Submitting
        _phase.value = try {
            val result = client.acceptInvite(server, accept = a.accept, acceptSigHex = a.acceptSigHex)
            InviteAcceptPhase.Done(result.serviceRef.ifEmpty { serviceRef })
        } catch (_: ServiceAccessError.InviteExpiredOrFull) {
            InviteAcceptPhase.Failed(FSStrings.get(R.string.this_invite_has_expired_or_is))
        } catch (_: ServiceAccessError) {
            InviteAcceptPhase.Failed(FSStrings.get(R.string.couldnt_verify_this_approval_ask_them))
        } catch (_: Throwable) {
            InviteAcceptPhase.Failed(FSStrings.get(R.string.couldnt_reach_the_server_check_your))
        }
    }

    companion object {
        val MALFORMED get() = FSStrings.get(R.string.that_approval_link_is_incomplete_ask)
    }
}
