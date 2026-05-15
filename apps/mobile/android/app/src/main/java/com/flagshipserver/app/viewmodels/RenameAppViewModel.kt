// V3 — Replace app URL stem. Kotlin mirror of FlagshipUI's
// AppDetailViewModel.renameApp.
//
//   1. Derive the user's IRK locally.
//   2. Sign canonical flagship/app-rename/v1 bytes.
//   3. POST /api/users/:u/apps/:appId/rename.
//   4. Reflect the new canonical + short URL in `links`.
//
// Failure modes:
//   - empty draft → reject before deriving keys (no biometric prompt).
//   - 409 collision → friendly "another app uses that name" hint.
//   - 400 invalid label → friendly format hint.

package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.api.AppLinksResponse
import com.flagshipserver.app.api.AppRenameRequest
import com.flagshipserver.app.api.FlagshipServerClient
import com.flagshipserver.app.core.AppRenameClaim
import com.flagshipserver.app.core.HexUtil
import com.flagshipserver.app.keystore.Keystore
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

sealed interface RenameAppPhase {
    data object Idle : RenameAppPhase
    data object Signing : RenameAppPhase
    data object Posting : RenameAppPhase
    data class Completed(val displayLabel: String, val shortUrl: String?) : RenameAppPhase
    data class Failed(val message: String) : RenameAppPhase
}

class RenameAppViewModel(
    private val server: FlagshipServerClient,
    private val appId: String,
    private val username: () -> String?,
) {
    private val _phase = MutableStateFlow<RenameAppPhase>(RenameAppPhase.Idle)
    val phase: StateFlow<RenameAppPhase> = _phase.asStateFlow()

    private val _links = MutableStateFlow<AppLinksResponse?>(null)
    val links: StateFlow<AppLinksResponse?> = _links.asStateFlow()

    suspend fun loadLinks() {
        val u = username() ?: return
        runCatching { server.getAppLinks(u, appId) }
            .onSuccess { _links.value = it }
    }

    suspend fun rename(draft: String): Boolean {
        val user = username()
        if (user.isNullOrEmpty()) {
            _phase.value = RenameAppPhase.Failed("No active account on this device.")
            return false
        }
        val trimmed = draft.trim().lowercase()
        if (trimmed.isEmpty()) {
            _phase.value = RenameAppPhase.Failed("Pick a non-empty label.")
            return false
        }
        _phase.value = RenameAppPhase.Signing
        val signer = try {
            Keystore.deriveIRK("Rename app URL stem")
        } catch (e: Throwable) {
            _phase.value = RenameAppPhase.Failed("Couldn't access your account keys: ${e.message}")
            return false
        }
        val issuedAt = System.currentTimeMillis()
        val canonical = AppRenameClaim.canonicalBytes(
            username = user,
            appId = appId,
            newDisplayLabel = trimmed,
            issuedAt = issuedAt,
        )
        val signature = signer.sign(canonical)
        _phase.value = RenameAppPhase.Posting
        return try {
            val resp = server.renameApp(
                username = user,
                appId = appId,
                body = AppRenameRequest(
                    request = AppRenameRequest.Inner(
                        username = user,
                        appId = appId,
                        newDisplayLabel = trimmed,
                        issuedAt = issuedAt,
                    ),
                    signature = HexUtil.encode(signature),
                ),
            )
            if (resp.displayLabel != null && resp.canonicalUrl != null) {
                _links.value = AppLinksResponse(
                    appId = appId,
                    displayLabel = resp.displayLabel,
                    canonicalUrl = resp.canonicalUrl,
                    instances = _links.value?.instances ?: emptyList(),
                    shortUrl = resp.shortUrl,
                )
            }
            _phase.value = RenameAppPhase.Completed(
                displayLabel = resp.displayLabel ?: trimmed,
                shortUrl = resp.shortUrl,
            )
            loadLinks()
            true
        } catch (e: Throwable) {
            val msg = e.message.orEmpty()
            val friendly = when {
                msg.contains("409") -> "Another app already uses that name. Pick something else."
                msg.contains("400") -> "That name isn't valid — use lowercase letters, digits, or hyphens (1–40 chars)."
                msg.contains("403") -> "Sign-in is needed. Re-open the app and try again."
                else -> "Couldn't rename: $msg"
            }
            _phase.value = RenameAppPhase.Failed(friendly)
            false
        }
    }
}
