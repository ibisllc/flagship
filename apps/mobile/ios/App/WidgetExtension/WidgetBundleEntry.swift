import WidgetKit
import SwiftUI

/// The single widget bundle exported by the Flagship widget extension.
/// Carries:
///   - InstallProgressLiveActivity — ActivityKit widget for the
///     create-server SSE pipeline (Lock Screen + Dynamic Island)
///   - PodStatusWidget — Home-screen widget showing each pod's
///     online/offline state with deep-link tap
@main
struct FlagshipWidgetBundle: WidgetBundle {
    var body: some Widget {
        InstallProgressLiveActivity()
        PodStatusWidget()
    }
}
