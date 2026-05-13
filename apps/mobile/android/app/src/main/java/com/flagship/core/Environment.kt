// Kotlin equivalent of FlagshipCore/Environment.swift.
//
// SwiftUI uses an EnvironmentValues type-map; Compose has
// CompositionLocal. We expose ScreensClient, FlagshipServerClient, and
// QrRelayClient through their own statics so any composable can call
// `LocalScreensClient.current` without prop-drilling.

package com.flagship.core

import androidx.compose.runtime.staticCompositionLocalOf
import com.flagship.api.FlagshipServerClient
import com.flagship.api.MockFlagshipServerClient
import com.flagship.api.MockScreensClient
import com.flagship.api.ScreensClient

val LocalScreensClient = staticCompositionLocalOf<ScreensClient> { MockScreensClient() }

val LocalFlagshipServerClient = staticCompositionLocalOf<FlagshipServerClient> { MockFlagshipServerClient() }

val LocalQrRelayClient = staticCompositionLocalOf<QrRelayClient> { MockQrRelayClient() }

val LocalAppState = staticCompositionLocalOf<AppState> { AppState() }

val LocalToastCenter = staticCompositionLocalOf<ToastCenter> { ToastCenter() }

val LocalDeepLinker = staticCompositionLocalOf<DeepLinker> { DeepLinker() }

val LocalDeveloperSettings = staticCompositionLocalOf<DeveloperSettings?> { null }
