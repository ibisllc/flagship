import Foundation
import SwiftUI
import WidgetKit
import FlagshipCore

/// Watches AppState.pods + currentUser and writes a PodStatusSnapshot
/// to the App Group container so PodStatusWidget can render without
/// launching the app. Calls WidgetCenter.reloadAllTimelines() on each
/// write so the widget refreshes immediately rather than waiting for
/// the next 30-min timeline rollover.
///
/// Used as a `.task(observing: app)` from the app's root view: the
/// task re-fires whenever a tracked property mutates because
/// @Observable + value-equality re-runs the task body.
@MainActor
struct PodStatusPublisher {
    let app: AppState

    func publish() {
        let snap = PodStatusSnapshot(
            username: app.currentUser,
            pods: app.pods.map { p in
                PodStatusSnapshot.Pod(
                    podId: p.podId,
                    name: p.name,
                    fqdn: p.fqdn,
                    statusRaw: p.status.rawValue,
                    isLeader: p.podId == app.leaderPodId
                )
            }
        )
        snap.write()
        WidgetCenter.shared.reloadAllTimelines()
    }
}
