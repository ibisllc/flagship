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
