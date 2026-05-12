import SwiftUI
import FlagshipCore
import FlagshipAPI

@main
struct FlagshipApp: App {
    @State private var appState = AppState()
    private let client: any ScreensClient = MockScreensClient()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environment(appState)
                .environment(\.screensClient, client)
        }
    }
}
