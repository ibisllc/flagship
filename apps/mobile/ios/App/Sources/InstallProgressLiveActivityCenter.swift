import Foundation
import ActivityKit
import WidgetKit

/// Bridge between the app's install-events SSE stream and the
/// ActivityKit Live Activity rendered by InstallProgressLiveActivity
/// in the widget extension.
///
/// Lifecycle:
///   start(serial:podName:)       — call .request(...)
///   advance(step:)               — call .update(...)
///   complete(serverFqdn:)        — final .update(.ready) + .end(...)
///   fail(reason:)                — final .update(.failed) + .end(...)
///
/// All updates run on the MainActor; ActivityKit itself is
/// MainActor-isolated. Falls silent (no-op) on iOS versions that
/// don't have Live Activities enabled by the user — this is a UX
/// nicety, not a contract surface.
@MainActor
final class InstallProgressLiveActivityCenter {
    static let shared = InstallProgressLiveActivityCenter()

    private var currentActivity: Activity<InstallProgressAttributes>?

    private init() {}

    /// Starts a new Live Activity. Cancels any previous in-flight
    /// activity from a prior incomplete install (e.g. user backgrounded
    /// during a previous attempt that never reached ready/failed).
    func start(serial: String, podName: String) {
        guard ActivityAuthorizationInfo().areActivitiesEnabled else { return }
        Task { await endStaleActivity() }

        let attributes = InstallProgressAttributes(serial: serial, podName: podName)
        let state = InstallProgressAttributes.ContentState(
            currentStep: .registered,
            completedSteps: []
        )
        do {
            currentActivity = try Activity<InstallProgressAttributes>.request(
                attributes: attributes,
                content: .init(state: state, staleDate: nil),
                pushType: nil
            )
        } catch {
            // Swallowing — Live Activity is best-effort UX; the
            // in-app InstallProgressScreen still shows the same
            // info. Crashing the install flow over a missing entitlement
            // or a user-side disable would be a regression.
        }
    }

    /// Advance to a new step. The previous current step is folded
    /// into `completedSteps` so the widget's checkmark list stays
    /// accurate even if the SSE delivers events out of order.
    func advance(to step: InstallProgressAttributes.Step) async {
        guard let activity = currentActivity else { return }
        var completed = activity.content.state.completedSteps
        let prior = activity.content.state.currentStep
        if prior != step && !completed.contains(prior) && prior != .failed {
            completed.append(prior)
        }
        let next = InstallProgressAttributes.ContentState(
            currentStep: step,
            completedSteps: completed,
            serverFqdn: activity.content.state.serverFqdn,
            failureReason: nil
        )
        await activity.update(.init(state: next, staleDate: nil))
    }

    /// Terminal success — render the green-check + FQDN one final
    /// frame, then dismiss after a short grace period so the user
    /// can tap into it from the Lock Screen if the phone is locked.
    func complete(serverFqdn: String) async {
        guard let activity = currentActivity else { return }
        var completed = activity.content.state.completedSteps
        for s in [InstallProgressAttributes.Step.started, .partitioning, .installing, .registered, .boot, .tunnelOnline, .certIssued, .ready] {
            if !completed.contains(s) { completed.append(s) }
        }
        let final = InstallProgressAttributes.ContentState(
            currentStep: .ready,
            completedSteps: completed,
            serverFqdn: serverFqdn,
            failureReason: nil
        )
        await activity.update(.init(state: final, staleDate: nil))
        await activity.end(
            .init(state: final, staleDate: nil),
            dismissalPolicy: .after(Date().addingTimeInterval(60 * 5))
        )
        currentActivity = nil
    }

    func fail(reason: String) async {
        guard let activity = currentActivity else { return }
        let final = InstallProgressAttributes.ContentState(
            currentStep: .failed,
            completedSteps: activity.content.state.completedSteps,
            serverFqdn: activity.content.state.serverFqdn,
            failureReason: reason
        )
        await activity.update(.init(state: final, staleDate: nil))
        await activity.end(
            .init(state: final, staleDate: nil),
            dismissalPolicy: .after(Date().addingTimeInterval(60 * 5))
        )
        currentActivity = nil
    }

    /// Force-end any leftover activity from a previous incomplete
    /// flow — keeps the user from accumulating zombie Live Activities
    /// after app crashes.
    private func endStaleActivity() async {
        for activity in Activity<InstallProgressAttributes>.activities {
            await activity.end(activity.content, dismissalPolicy: .immediate)
        }
        currentActivity = nil
    }
}
