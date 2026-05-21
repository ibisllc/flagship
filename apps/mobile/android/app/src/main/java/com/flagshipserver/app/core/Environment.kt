// Kotlin equivalent of FlagshipCore/Environment.swift.
//
// SwiftUI uses an EnvironmentValues type-map; Compose has
// CompositionLocal. We expose ScreensClient, FlagshipServerClient, and
// QrRelayClient through their own statics so any composable can call
// `LocalScreensClient.current` without prop-drilling.

package com.flagshipserver.app.core

import androidx.compose.runtime.staticCompositionLocalOf
import com.flagshipserver.app.api.FlagshipServerClient
import com.flagshipserver.app.api.MockFlagshipServerClient
import com.flagshipserver.app.api.MockScreensClient
import com.flagshipserver.app.api.ScreensClient

val LocalScreensClient = staticCompositionLocalOf<ScreensClient> { MockScreensClient() }

val LocalFlagshipServerClient = staticCompositionLocalOf<FlagshipServerClient> { MockFlagshipServerClient() }

val LocalQrRelayClient = staticCompositionLocalOf<QrRelayClient> { MockQrRelayClient() }

val LocalAppState = staticCompositionLocalOf<AppState> { AppState() }

val LocalToastCenter = staticCompositionLocalOf<ToastCenter> { ToastCenter() }

val LocalDeepLinker = staticCompositionLocalOf<DeepLinker> { DeepLinker() }

val LocalDeveloperSettings = staticCompositionLocalOf<DeveloperSettings?> { null }

/** C12 — PrivacySettings persistence handle. Null on previews and in
 *  unit tests; the production MainActivity always installs a real one. */
val LocalPrivacySettings = staticCompositionLocalOf<PrivacySettings?> { null }

/**
 * W10 — `SetServiceEnvRequest` envelope signer. Production wires this
 * to the platform Keystore (derive IRK → sign canonical bytes). Tests
 * + previews use the default no-op which returns a placeholder hex
 * string (the daemon rejects it on signature verify — correct
 * behavior for an offline preview surface).
 *
 * Canonical-bytes shape mirrors `@flagship/protocol/auth.ts`
 * `signSetServiceEnv`:
 *
 *     "flagship/set-service-env/v1"
 *         | serverId | creator | slug | <pairCount>
 *         | <sortedKey>=<value>... | issuedAt
 */
typealias VibeCodeEnvelopeSigner = suspend (com.flagshipserver.app.api.ServiceEnvSetEnvelope) -> String

val LocalVibeCodeEnvelopeSigner = staticCompositionLocalOf<VibeCodeEnvelopeSigner> {
    { _ -> "0".repeat(128) }
}
