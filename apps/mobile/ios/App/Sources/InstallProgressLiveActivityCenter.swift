import Foundation
import ActivityKit
import WidgetKit

/// Bridge between the canonical provisioning channel (driven through
/// InstallProgressBridge) and the ActivityKit Live Activity rendered by
/// InstallProgressLiveActivity in the widget extension.
///
/// One activity per install, keyed by its order serial:
///   start(serial:podName:)       — call .request(...)
///   advance(serial:to:)          — call .update(...)
///   complete(serial:serverFqdn:) — final .update(.live) + .end(...)
///   fail(serial:reason:)         — final .update(.error) + .end(...)
///
/// InstallProgressBridge already drops late and repeated checkpoints, so
/// every call here moves the activity forward. All updates run on the
/// MainActor; ActivityKit itself is MainActor-isolated. Falls silent
/// (no-op) when the user turned Live Activities off, or when a request
/// comes while the app is in the background (ActivityKit refuses it) —
/// this is a UX nicety, not a contract surface.
@MainActor
final class InstallProgressLiveActivityCenter {
    static let shared = InstallProgressLiveActivityCenter()

    private var activities: [String: Activity<InstallProgressAttributes>] = [:]
    /// Activities left by an earlier run of the app are ended on the first
    /// start of this one; later starts leave other installs' alone.
    private var sweptEarlierRuns = false

    private init() {}

    /// Starts the Live Activity for one install, replacing any earlier one
    /// for the same serial (a retry, or a relaunch mid-install).
    func start(serial: String, podName: String) {
        guard ActivityAuthorizationInfo().areActivitiesEnabled else { return }
        let ours = Set(activities.values.map(\.id))
        let sweep = !sweptEarlierRuns
        sweptEarlierRuns = true
        let stale = Activity<InstallProgressAttributes>.activities.filter {
            $0.attributes.serial == serial || (sweep && !ours.contains($0.id))
        }
        activities[serial] = nil

        let attributes = InstallProgressAttributes(serial: serial, podName: podName)
        let state = InstallProgressAttributes.ContentState(
            currentStep: .booting,
            completedSteps: []
        )
        do {
            activities[serial] = try Activity<InstallProgressAttributes>.request(
                attributes: attributes,
                content: .init(state: state, staleDate: nil),
                pushType: nil
            )
        } catch {
            // Swallowing — Live Activity is best-effort UX; the in-app
            // PendingServerScreen timeline still shows the same info.
            // Crashing the install flow over a missing entitlement or a
            // user-side disable would be a regression.
        }
        // Captured before the request, so the new activity is never in it.
        Task {
            for activity in stale {
                await activity.end(activity.content, dismissalPolicy: .immediate)
            }
        }
    }

    /// Move to a new step. Every rung before it counts as done, so the
    /// widget's checkmark list stays right when a poll skipped a rung.
    func advance(serial: String, to step: InstallProgressAttributes.Step) async {
        guard let activity = activities[serial] else { return }
        let next = InstallProgressAttributes.ContentState(
            currentStep: step,
            completedSteps: Self.completed(before: step, already: activity.content.state.completedSteps),
            serverFqdn: activity.content.state.serverFqdn,
            failureReason: nil
        )
        await activity.update(.init(state: next, staleDate: nil))
    }

    /// Terminal success — render the green-check + FQDN one final
    /// frame, then dismiss after a short grace period so the user
    /// can tap into it from the Lock Screen if the phone is locked.
    func complete(serial: String, serverFqdn: String) async {
        guard let activity = activities.removeValue(forKey: serial) else { return }
        var completed = activity.content.state.completedSteps
        for s in InstallProgressAttributes.Step.ordered where !completed.contains(s) {
            completed.append(s)
        }
        let final = InstallProgressAttributes.ContentState(
            currentStep: .live,
            completedSteps: completed,
            serverFqdn: serverFqdn.isEmpty ? activity.content.state.serverFqdn : serverFqdn,
            failureReason: nil
        )
        await activity.end(
            .init(state: final, staleDate: nil),
            dismissalPolicy: .after(Date().addingTimeInterval(60 * 5))
        )
    }

    func fail(serial: String, reason: String) async {
        guard let activity = activities.removeValue(forKey: serial) else { return }
        let final = InstallProgressAttributes.ContentState(
            currentStep: .error,
            completedSteps: activity.content.state.completedSteps,
            serverFqdn: activity.content.state.serverFqdn,
            failureReason: reason
        )
        await activity.end(
            .init(state: final, staleDate: nil),
            dismissalPolicy: .after(Date().addingTimeInterval(60 * 5))
        )
    }

    private static func completed(
        before step: InstallProgressAttributes.Step,
        already: [InstallProgressAttributes.Step]
    ) -> [InstallProgressAttributes.Step] {
        guard let idx = InstallProgressAttributes.Step.ordered.firstIndex(of: step) else { return already }
        var done = already
        for s in InstallProgressAttributes.Step.ordered[..<idx] where !done.contains(s) {
            done.append(s)
        }
        return done
    }
}
