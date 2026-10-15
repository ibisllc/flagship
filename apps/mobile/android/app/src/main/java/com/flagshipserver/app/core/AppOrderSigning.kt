package com.flagshipserver.app.core

import androidx.compose.runtime.staticCompositionLocalOf
import com.google.crypto.tink.subtle.Ed25519Sign

/**
 * Who signs an app's orders (access-list changes, database writes) on the
 * screens below, and for which box. Null means the owner's admin key and the
 * page's own server. A shared server's app pages provide the share's member
 * key and that server's FQDN (docs/share-a-server.md), so the same screens
 * work for a co-manager.
 */
data class AppOrderSigning(
    val serverDomain: String,
    val signer: suspend (reason: String) -> Ed25519Sign,
)

val LocalAppOrderSigning = staticCompositionLocalOf<AppOrderSigning?> { null }
