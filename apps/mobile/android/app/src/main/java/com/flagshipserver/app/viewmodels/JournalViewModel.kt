// Diagnostics: fetch the box's recent systemd journal. Signs a JournalRequest
// with the OWNER IRK (biometric on every tap via deriveIRK) and POSTs it
// straight to the box's /api/journal — .com never sees the request or the
// logs. Mirror of iOS JournalViewModel.

package com.flagshipserver.app.viewmodels

import androidx.lifecycle.ViewModel
import com.flagshipserver.app.api.JournalInner
import com.flagshipserver.app.api.JournalRequestBody
import com.flagshipserver.app.api.LockPowerClient
import com.flagshipserver.app.core.HexUtil
import com.flagshipserver.app.core.HttpException
import com.flagshipserver.app.core.JournalRequest
import com.flagshipserver.app.core.JournalUnits
import com.flagshipserver.app.keystore.Keystore
import com.google.crypto.tink.subtle.Ed25519Sign
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

sealed interface JournalPhase {
    data object Idle : JournalPhase
    data object Loading : JournalPhase
    data class Loaded(val unit: String, val lines: List<String>) : JournalPhase
    data class Failed(val message: String) : JournalPhase
}

class JournalViewModel(
    private val serverDomain: String,
    /** Biometric-gated owner-IRK signer; the SAME key the daemon's /api/journal
     *  pins. Tests inject a fixed key. */
    private val signer: suspend (reason: String) -> Ed25519Sign = { r -> Keystore.deriveIRK(r) },
    private val client: LockPowerClient = LockPowerClient(),
    private val now: () -> Long = { System.currentTimeMillis() },
) : ViewModel() {
    private val _phase = MutableStateFlow<JournalPhase>(JournalPhase.Idle)
    val phase: StateFlow<JournalPhase> = _phase.asStateFlow()

    suspend fun load(unit: String, lines: Long) {
        _phase.value = JournalPhase.Loading
        val irk: Ed25519Sign
        try {
            irk = signer("Read the journal on $serverDomain")
        } catch (e: Throwable) {
            _phase.value = JournalPhase.Failed("Couldn't access your account key: ${e.message}")
            return
        }
        val clamped = lines.coerceIn(1L, JournalUnits.MAX_LINES)
        val issuedAt = now()
        val signature: ByteArray
        try {
            signature = irk.sign(JournalRequest.canonicalBytes(serverDomain, unit, clamped, issuedAt))
        } catch (e: Throwable) {
            _phase.value = JournalPhase.Failed("Couldn't sign: ${e.message}")
            return
        }

        try {
            val ack = client.readJournal(
                serverDomain,
                JournalRequestBody(
                    request = JournalInner(
                        serverId = serverDomain,
                        unit = unit,
                        lines = clamped,
                        issuedAt = issuedAt,
                    ),
                    signature = HexUtil.encode(signature),
                ),
            )
            _phase.value = JournalPhase.Loaded(ack.unit.ifEmpty { unit }, ack.lines)
        } catch (e: HttpException) {
            val friendly = when (e.status) {
                403 -> "The box rejected the request. Sign in again and retry."
                404, 502, 503 -> "The box isn't reachable right now."
                else -> "Server error (${e.status}): ${e.body}"
            }
            _phase.value = JournalPhase.Failed(friendly)
        } catch (e: Throwable) {
            _phase.value = JournalPhase.Failed("Couldn't reach the box: ${e.message}")
        }
    }
}
