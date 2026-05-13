import SwiftUI
import FlagshipAPI

/// EnvironmentValues extension so any view can read the live ScreensClient
/// via `@Environment(\.screensClient)`. The App-level shell injects either
/// a MockScreensClient (dev/preview) or a LiveScreensClient (paired pod).
private struct ScreensClientKey: EnvironmentKey {
    static let defaultValue: any ScreensClient = MockScreensClient()
}

public extension EnvironmentValues {
    var screensClient: any ScreensClient {
        get { self[ScreensClientKey.self] }
        set { self[ScreensClientKey.self] = newValue }
    }
}

/// Pre-pairing endpoints on flagshipserver.com (the Cloudflare Worker).
/// Used by onboarding + recovery flows before a session token exists.
private struct FlagshipServerClientKey: EnvironmentKey {
    static let defaultValue: any FlagshipServerClient = MockFlagshipServerClient()
}

public extension EnvironmentValues {
    var flagshipServerClient: any FlagshipServerClient {
        get { self[FlagshipServerClientKey.self] }
        set { self[FlagshipServerClientKey.self] = newValue }
    }
}

/// QR-relay WebSocket peer of `flagshipserver.com/qr-pipe/<sid>`.
/// Used by the v2 create-server flow.
private struct QrRelayClientKey: EnvironmentKey {
    static let defaultValue: any QrRelayClient = MockQrRelayClient()
}

public extension EnvironmentValues {
    var qrRelayClient: any QrRelayClient {
        get { self[QrRelayClientKey.self] }
        set { self[QrRelayClientKey.self] = newValue }
    }
}
