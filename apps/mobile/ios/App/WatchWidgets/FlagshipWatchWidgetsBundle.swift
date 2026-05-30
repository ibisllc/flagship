import SwiftUI
import WidgetKit

/// WidgetBundle entry point for the watchOS widget extension. Ships
/// inside the FlagshipWatchApp bundle and provides the install-progress
/// complication for the watch face + Smart Stack.
@main
struct FlagshipWatchWidgetsBundle: WidgetBundle {
    var body: some Widget {
        ProvisionPhaseComplication()
    }
}
