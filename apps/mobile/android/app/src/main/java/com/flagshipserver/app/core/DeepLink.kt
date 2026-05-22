// Kotlin mirror of FlagshipCore/DeepLink.swift.
//
// Out-of-band navigation events triggered by push-notification taps,
// `flagship://` intents, or app-link openings. Shell observes
// DeepLinker.pending and dispatches the right destination on the right
// tab; consumers must call consume() to clear it.

package com.flagshipserver.app.core

import android.net.Uri
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

sealed interface DeepLink {
    data class UnlockApprove(val requestId: String) : DeepLink
    data class ServerDetail(val podId: String) : DeepLink
    data class AppDetail(val appId: String) : DeepLink
    data object Marketplace : DeepLink
    data object CreateServer : DeepLink
    /** Open the recovery-setup flow on the Settings tab. Triggered
     *  in-app from the Home nudge (C9). Internal-only — not parsed
     *  from a URI. */
    data object RecoverySetup : DeepLink
    /** W10 — vibe-code chat surface for the given session id. Fired
     *  by the `vibecode-needs-you` push when the AI is awaiting an
     *  env-var or talkToUser response. */
    data class VibeCodeChat(val sessionId: String) : DeepLink

    /** Phase 3b — cross-device pairing. Opened when the collaborator's
     *  NATIVE camera (or the in-app scanner) follows the admin's pairing
     *  QR / App-Links URL (https://flagshipserver.com/join?sid=…&pk=…).
     *  Routes into the incoming add-profile join flow. Carries the raw
     *  join params; the host re-parses them into a [JoinLink]. */
    data class JoinDevice(val sid: String, val pk: String) : DeepLink

    companion object {
        /// Parse a `flagship://...` URI. Keep in sync with iOS
        /// DeepLink.parse and the webapp's lib/router.js. Returns null
        /// when the host/scheme is not one we route.
        fun parse(uri: Uri): DeepLink? {
            if (uri.scheme != "flagship") return null
            val host = uri.host ?: return null
            val params = uri.queryParameterNames.associateWith { uri.getQueryParameter(it) ?: "" }
            return when (host) {
                "unlock-approve" -> params["requestId"]?.let { UnlockApprove(it) }
                "server" -> params["podId"]?.let { ServerDetail(it) }
                "app" -> params["appId"]?.let { AppDetail(it) }
                "marketplace" -> Marketplace
                "create-server" -> CreateServer
                "join" -> {
                    // flagship://join?sid=<sid>&pk=<pkB64u>. Both params
                    // required; a malformed link is NOT routed (returns
                    // null so the OS falls back to the browser).
                    val sid = params["sid"].orEmpty()
                    val pk = params["pk"].orEmpty()
                    if (sid.isEmpty() || pk.isEmpty()) null else JoinDevice(sid, pk)
                }
                "vibecode" -> {
                    // Accept either path form `flagship://vibecode/<id>`
                    // or query form `flagship://vibecode?sessionId=<id>`.
                    val pathId = uri.path?.trim('/').orEmpty()
                    val queryId = params["sessionId"].orEmpty()
                    val id = if (pathId.isNotEmpty()) pathId else queryId
                    if (id.isEmpty()) null else VibeCodeChat(id)
                }
                else -> null
            }
        }
    }
}

class DeepLinker {
    private val _pending = MutableStateFlow<DeepLink?>(null)
    val pending: StateFlow<DeepLink?> = _pending.asStateFlow()

    fun enqueue(link: DeepLink) { _pending.value = link }

    fun consume(): DeepLink? {
        val v = _pending.value
        _pending.value = null
        return v
    }
}
