// V3 — Replace service URL stem. Kotlin mirror of FlagshipUI's
// AppDetailViewModel.renameApp.
//
//   1. Derive the user's IRK locally.
//   2. Sign canonical flagship/service-rename/v1 bytes.
//   3. POST /api/users/:u/apps/:serviceId/rename.
//   4. Reflect the new canonical + short URL in `links`.
//
// Failure modes:
//   - empty draft → reject before deriving keys (no biometric prompt).
//   - 409 collision → friendly "another service uses that name" hint.
//   - 400 invalid label → friendly format hint.

package com.flagshipserver.app.viewmodels

import androidx.lifecycle.ViewModel
import com.flagshipserver.app.api.AppLinksResponse
import com.flagshipserver.app.api.AppRenameRequest
import com.flagshipserver.app.api.FlagshipServerClient
import com.flagshipserver.app.core.ServiceRenameClaim
import com.flagshipserver.app.core.HexUtil
import com.flagshipserver.app.keystore.Keystore
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

sealed interface RenameServicePhase {
    data object Idle : RenameServicePhase
    data object Signing : RenameServicePhase
    data object Posting : RenameServicePhase
    data class Completed(val displayLabel: String, val shortUrl: String?) : RenameServicePhase
    data class Failed(val message: String) : RenameServicePhase
}

class RenameServiceViewModel(
    private val server: FlagshipServerClient,
    private val serviceId: String,
    private val username: () -> String?,
) : ViewModel() {
    private val _phase = MutableStateFlow<RenameServicePhase>(RenameServicePhase.Idle)
    val phase: StateFlow<RenameServicePhase> = _phase.asStateFlow()

    private val _links = MutableStateFlow<AppLinksResponse?>(null)
    val links: StateFlow<AppLinksResponse?> = _links.asStateFlow()

    suspend fun loadLinks() {
        val u = username() ?: return
        runCatching { server.getAppLinks(u, serviceId) }
            .onSuccess { _links.value = it }
    }

    suspend fun rename(draft: String): Boolean {
        val user = username()
        if (user.isNullOrEmpty()) {
            _phase.value = RenameServicePhase.Failed("No active account on this device.")
            return false
        }
        val trimmed = draft.trim().lowercase()
        if (trimmed.isEmpty()) {
            _phase.value = RenameServicePhase.Failed("Pick a non-empty label.")
            return false
        }
        _phase.value = RenameServicePhase.Signing
        val signer = try {
            Keystore.deriveIRK("Rename service URL stem")
        } catch (e: Throwable) {
            _phase.value = RenameServicePhase.Failed("Couldn't access your account keys: ${e.message}")
            return false
        }
        val issuedAt = System.currentTimeMillis()
        val canonical = ServiceRenameClaim.canonicalBytes(
            username = user,
            serviceId = serviceId,
            newDisplayLabel = trimmed,
            issuedAt = issuedAt,
        )
        val signature = signer.sign(canonical)
        _phase.value = RenameServicePhase.Posting
        return try {
            val resp = server.renameApp(
                username = user,
                serviceId = serviceId,
                body = AppRenameRequest(
                    request = AppRenameRequest.Inner(
                        username = user,
                        serviceId = serviceId,
                        newDisplayLabel = trimmed,
                        issuedAt = issuedAt,
                    ),
                    signature = HexUtil.encode(signature),
                ),
            )
            if (resp.displayLabel != null && resp.canonicalUrl != null) {
                _links.value = AppLinksResponse(
                    serviceId = serviceId,
                    displayLabel = resp.displayLabel,
                    canonicalUrl = resp.canonicalUrl,
                    instances = _links.value?.instances ?: emptyList(),
                    shortUrl = resp.shortUrl,
                )
            }
            _phase.value = RenameServicePhase.Completed(
                displayLabel = resp.displayLabel ?: trimmed,
                shortUrl = resp.shortUrl,
            )
            loadLinks()
            true
        } catch (e: Throwable) {
            val msg = e.message.orEmpty()
            val friendly = when {
                msg.contains("409") -> "Another service already uses that name. Pick something else."
                msg.contains("400") -> "That name isn't valid — use lowercase letters, digits, or hyphens (1–40 chars)."
                msg.contains("403") -> "Sign-in is needed. Re-open the app and try again."
                else -> "Couldn't rename: $msg"
            }
            _phase.value = RenameServicePhase.Failed(friendly)
            false
        }
    }
}
