// Un-revoke a lost / stolen / decommissioned server: sign the
// ServerUnrevocation envelope with the sensitive-order key and POST it to
// `.com`. The revoke deleted the box's stored self-unlock lease, so a box
// that auto-unlocked needs one phone approval after this.

package com.flagshipserver.app.viewmodels

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
            _phase.value = UnrevokeServerPhase.Failed("No active account on this device.")
            return
        }
        _phase.value = UnrevokeServerPhase.Signing
        val issuedAt = now()
        val signature = try {
            signer("Un-revoke server $serverDomain")
                .sign(ServerUnrevocation.canonicalBytes(user, serverDomain, issuedAt))
        } catch (e: CancellationException) {
            throw e
        } catch (e: Throwable) {
            _phase.value = UnrevokeServerPhase.Failed("Couldn't access your account key: ${UserErrorText.reason(e)}")
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
        const val SUCCESS_MESSAGE =
            "Server restored. If it unlocks on its own, approve its unlock once from your phone."

        fun friendlyError(status: Int, body: String): String = when (status) {
            403 -> "The server rejected the request. Sign in again and retry."
            404 -> "That server is no longer on your account."
            409 -> "This server was deleted or transferred, so it can't be restored."
            else -> "Server error ($status): $body"
        }
    }
}
