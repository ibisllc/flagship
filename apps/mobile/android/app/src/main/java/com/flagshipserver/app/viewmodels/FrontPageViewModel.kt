// Owner-assignable apex ("front page") — loads the current assignment + the
// installed services (both unauthenticated pod reads), then signs a
// `set-front-page` PhoneOrder with the OWNER IRK (biometric on every save;
// never silent) and POSTs it straight to the box's `/api/front-page`.
// Mirror of iOS FrontPageViewModel.

package com.flagshipserver.app.viewmodels

import androidx.lifecycle.ViewModel
import com.flagshipserver.app.api.FrontPageClient
import com.flagshipserver.app.api.FrontPageServiceEntry
import com.flagshipserver.app.api.SetFrontPageInner
import com.flagshipserver.app.api.SetFrontPageRequest
import com.flagshipserver.app.core.HexUtil
import com.flagshipserver.app.core.HttpException
import com.flagshipserver.app.core.SetFrontPageOrder
import com.flagshipserver.app.keystore.Keystore
import com.google.crypto.tink.subtle.Ed25519Sign
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

sealed interface FrontPagePhase {
    data object Idle : FrontPagePhase
    data object Loading : FrontPagePhase
    data object Ready : FrontPagePhase
    data object Signing : FrontPagePhase
    data object Posting : FrontPagePhase
    data class Failed(val message: String) : FrontPagePhase
}

class FrontPageViewModel(
    private val serverDomain: String,
    private val signer: suspend (reason: String) -> Ed25519Sign = { r -> Keystore.deriveIRK(r) },
    private val client: FrontPageClient = FrontPageClient(),
    private val now: () -> Long = { System.currentTimeMillis() },
) : ViewModel() {
    private val _phase = MutableStateFlow<FrontPagePhase>(FrontPagePhase.Idle)
    val phase: StateFlow<FrontPagePhase> = _phase.asStateFlow()

    /** Assigned service url-label; null = default Flagship page. */
    private val _current = MutableStateFlow<String?>(null)
    val current: StateFlow<String?> = _current.asStateFlow()

    /** Whether [current] still resolves to an installed service. */
    private val _currentActive = MutableStateFlow(true)
    val currentActive: StateFlow<Boolean> = _currentActive.asStateFlow()

    private val _options = MutableStateFlow<List<FrontPageServiceEntry>>(emptyList())
    val options: StateFlow<List<FrontPageServiceEntry>> = _options.asStateFlow()

    suspend fun load() {
        _phase.value = FrontPagePhase.Loading
        try {
            coroutineScope {
                val state = async { client.getFrontPage(serverDomain) }
                val opts = async { client.listOptions(serverDomain) }
                val s = state.await()
                _current.value = s.label
                _currentActive.value = s.label == null || s.active
                _options.value = opts.await()
            }
            _phase.value = FrontPagePhase.Ready
        } catch (e: Throwable) {
            _phase.value = FrontPagePhase.Failed("Couldn't reach the box to load front-page settings.")
        }
    }

    /** Assign [label] (or "" to restore the default page). */
    suspend fun save(label: String) {
        _phase.value = FrontPagePhase.Signing
        val irk: Ed25519Sign
        try {
            val reason = if (label.isEmpty()) {
                "Reset the front page of $serverDomain"
            } else {
                "Set the front page of $serverDomain to $label"
            }
            irk = signer(reason)
        } catch (e: Throwable) {
            _phase.value = FrontPagePhase.Failed("Couldn't access your account key: ${e.message}")
            return
        }
        val issuedAt = now()
        val signature: ByteArray
        try {
            signature = irk.sign(SetFrontPageOrder.canonicalBytes(serverDomain, label, issuedAt))
        } catch (e: Throwable) {
            _phase.value = FrontPagePhase.Failed("Couldn't sign: ${e.message}")
            return
        }

        _phase.value = FrontPagePhase.Posting
        try {
            client.setFrontPage(
                serverDomain,
                SetFrontPageRequest(
                    request = SetFrontPageInner(
                        serverId = serverDomain,
                        label = label,
                        issuedAt = issuedAt,
                    ),
                    signature = HexUtil.encode(signature),
                ),
            )
        } catch (e: HttpException) {
            val friendly = when (e.status) {
                403 -> "The box rejected the request. Sign in again and retry."
                404, 502, 503 -> "The box isn't reachable right now."
                422 -> "That app is no longer installed on the box."
                else -> "Server error (${e.status}): ${e.body}"
            }
            _phase.value = FrontPagePhase.Failed(friendly)
            return
        } catch (e: Throwable) {
            _phase.value = FrontPagePhase.Failed("Couldn't reach the box: ${e.message}")
            return
        }
        _current.value = label.ifEmpty { null }
        _currentActive.value = true
        _phase.value = FrontPagePhase.Ready
    }
}
