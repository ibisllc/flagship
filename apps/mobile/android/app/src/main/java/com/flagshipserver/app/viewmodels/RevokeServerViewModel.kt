// P13 — Kotlin mirror of FlagshipUI's RevokeServerViewModel. Signs +
// POSTs the per-server kill-switch envelope. See the Swift source for
// the canonical commentary.

package com.flagshipserver.app.viewmodels

import androidx.lifecycle.ViewModel
import com.flagshipserver.app.api.FlagshipServerClient
import com.flagshipserver.app.api.ServerRevocationRequest
import com.flagshipserver.app.core.HexUtil
import com.flagshipserver.app.core.HttpException
import com.flagshipserver.app.core.ServerRevocationClaim
import com.flagshipserver.app.keystore.Keystore
import com.google.crypto.tink.subtle.Ed25519Sign
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

sealed interface RevokeServerPhase {
    data object Idle : RevokeServerPhase
    data object Signing : RevokeServerPhase
    data object Posting : RevokeServerPhase
    data object Completed : RevokeServerPhase
    data class Failed(val message: String) : RevokeServerPhase
}

enum class RevokeServerReason(val wire: String, val label: String) {
    LOST("lost", "Lost"),
    STOLEN("stolen", "Stolen"),
    DECOMMISSIONED("decommissioned", "Decommissioned");

    companion object {
        fun fromWire(s: String): RevokeServerReason? = entries.firstOrNull { it.wire == s }
    }
}

class RevokeServerViewModel(
    private val server: FlagshipServerClient,
    private val serverDomain: String,
    private val username: () -> String?,
    /** Pluggable for tests. Default uses the real Keystore-backed IRK. */
    // Slice D — releasing/revoking a server name is SENSITIVE (serverRevoke.ts
    // gates it on the admin master root): sign with the admin root when held,
    // else the owner IRK (legacy). Canonical bytes unchanged.
    private val signer: suspend (reason: String) -> Ed25519Sign = { r -> Keystore.adminSigningKey(r) },
    private val now: () -> Long = { System.currentTimeMillis() },
) : ViewModel() {
    private val _phase = MutableStateFlow<RevokeServerPhase>(RevokeServerPhase.Idle)
    val phase: StateFlow<RevokeServerPhase> = _phase.asStateFlow()

    suspend fun run(reason: RevokeServerReason) {
        val user = username()
        if (user.isNullOrEmpty()) {
            _phase.value = RevokeServerPhase.Failed("No active account on this device.")
            return
        }
        _phase.value = RevokeServerPhase.Signing
        val irk: Ed25519Sign
        try {
            irk = signer("Revoke server $serverDomain")
        } catch (e: Throwable) {
            _phase.value = RevokeServerPhase.Failed("Couldn't access your account key: ${e.message}")
            return
        }
        val issuedAt = now()
        val canonical = ServerRevocationClaim.canonicalBytes(
            userId = user,
            revokedServerId = serverDomain,
            reason = reason.wire,
            issuedAt = issuedAt,
        )
        val signature: ByteArray
        try {
            signature = irk.sign(canonical)
        } catch (e: Throwable) {
            _phase.value = RevokeServerPhase.Failed("Couldn't sign: ${e.message}")
            return
        }

        _phase.value = RevokeServerPhase.Posting
        try {
            server.revokeServer(
                ServerRevocationRequest(
                    request = ServerRevocationRequest.Inner(
                        userId = user,
                        revokedServerId = serverDomain,
                        reason = reason.wire,
                        issuedAt = issuedAt,
                    ),
                    signature = HexUtil.encode(signature),
                ),
            )
        } catch (e: HttpException) {
            val friendly = when (e.status) {
                403 -> "The server rejected the request. Sign in again and retry."
                404 -> "That server is already gone — nothing to revoke."
                else -> "Server error (${e.status}): ${e.body}"
            }
            _phase.value = RevokeServerPhase.Failed(friendly)
            return
        } catch (e: Throwable) {
            _phase.value = RevokeServerPhase.Failed("Couldn't reach the server: ${e.message}")
            return
        }
        _phase.value = RevokeServerPhase.Completed
    }
}
