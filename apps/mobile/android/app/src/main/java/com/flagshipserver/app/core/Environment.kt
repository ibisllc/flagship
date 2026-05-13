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
