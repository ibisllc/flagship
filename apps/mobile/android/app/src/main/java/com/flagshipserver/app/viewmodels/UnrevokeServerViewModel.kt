// Un-revoke a lost / stolen / decommissioned server: sign the
// ServerUnrevocation envelope with the sensitive-order key and POST it to
// `.com`. The revoke deleted the box's stored self-unlock lease, so a box
// that auto-unlocked needs one phone approval after this.

package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.core.FSStrings
import com.flagshipserver.app.R
import com.flagshipserver.app.core.UserErrorText
import com.flagshipserver.app.api.FlagshipServerClient
import com.flagshipserver.app.api.UnrevokeServerRequest
import com.flagshipserver.app.core.HexUtil
import com.flagshipserver.app.core.HttpException
import com.flagshipserver.app.core.ServerUnrevocation
import com.flagshipserver.app.keystore.Keystore
import com.google.crypto.tink.subtle.Ed25519Sign
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

sealed interface UnrevokeServerPhase {
    data object Idle : UnrevokeServerPhase
    data object Signing : UnrevokeServerPhase
    data object Posting : UnrevokeServerPhase
    data object Completed : UnrevokeServerPhase
    data class Failed(val message: String) : UnrevokeServerPhase
}

class UnrevokeServerViewModel(
    private val server: FlagshipServerClient,
    private val serverDomain: String,
    private val username: () -> String?,
    private val signer: suspend (reason: String) -> Ed25519Sign = { r -> Keystore.adminSigningKey(r) },
    private val now: () -> Long = { System.currentTimeMillis() },
) {
    private val _phase = MutableStateFlow<UnrevokeServerPhase>(UnrevokeServerPhase.Idle)
    val phase: StateFlow<UnrevokeServerPhase> = _phase.asStateFlow()

    suspend fun run() {
        val user = username()
        if (user.isNullOrEmpty()) {
            _phase.value = UnrevokeServerPhase.Failed(FSStrings.get(R.string.no_active_account_on_this_device))
            return
        }
        _phase.value = UnrevokeServerPhase.Signing
        val issuedAt = now()
        val signature = try {
            signer(FSStrings.get(R.string.un_revoke_server_2, serverDomain))
                .sign(ServerUnrevocation.canonicalBytes(user, serverDomain, issuedAt))
        } catch (e: CancellationException) {
            throw e
        } catch (e: Throwable) {
            _phase.value = UnrevokeServerPhase.Failed(FSStrings.get(R.string.couldnt_access_your_account_key, UserErrorText.reason(e)))
            return
        }

        _phase.value = UnrevokeServerPhase.Posting
        try {
            server.unrevokeServer(
                UnrevokeServerRequest(
                    request = UnrevokeServerRequest.Inner(
                        username = user,
                        serverDomain = serverDomain,
                        issuedAt = issuedAt,
                    ),
                    signature = HexUtil.encode(signature),
                ),
            )
        } catch (e: CancellationException) {
            throw e
        } catch (e: HttpException) {
            _phase.value = UnrevokeServerPhase.Failed(friendlyError(e.status, e.body))
            return
        } catch (e: Throwable) {
            _phase.value = UnrevokeServerPhase.Failed(UserErrorText.of(e, where = "reach"))
            return
        }
        _phase.value = UnrevokeServerPhase.Completed
    }

    companion object {
        val SUCCESS_MESSAGE get() =
            FSStrings.get(R.string.server_restored_if_it_unlocks_on)

        fun friendlyError(status: Int, body: String): String = when (status) {
            403 -> FSStrings.get(R.string.the_server_rejected_the_request_sign)
            404 -> FSStrings.get(R.string.that_server_is_no_longer_on)
            409 -> FSStrings.get(R.string.this_server_was_deleted_or_transferred)
            else -> FSStrings.get(R.string.server_error, status, body)
        }
    }
}
