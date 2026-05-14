import SwiftUI

/// Standalone watchOS 10+ app entry point. Doesn't pair to a server
/// independently — relies on its companion iPhone to do every
/// network call. The watch's job is to surface pending approvals
/// and initiate them via WatchConnectivity.
@main
struct FlagshipWatchApp: App {
    @StateObject private var session = WatchConnectivityClient.shared

    var body: some Scene {
        WindowGroup {
            WatchRootView()
                .environmentObject(session)
                .onAppear { session.activate() }
        }
    }
}
