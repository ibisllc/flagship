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
