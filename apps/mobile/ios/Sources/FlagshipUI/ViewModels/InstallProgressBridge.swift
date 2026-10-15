import Foundation
import FlagshipAPI

/// Bridge between the provisioning timeline (FlagshipUI) and any host
/// observer that wants to surface install-progress as a system-level
/// affordance (Live Activity, Watch, Action Center, …).
///
/// FlagshipUI deliberately doesn't import ActivityKit / WidgetKit —
/// those are App-target concerns. The bridge is a closure-typed hook the
/// App registers at boot; FlagshipUI calls the closures during phase
/// transitions and the App decides what to do (start a Live Activity,
/// send a watch message, etc.).
///
/// Every checkpoint, whichever surface saw it (the pending-pod watcher's
/// poll, an install screen's poll, a `provision-status` push), goes
/// through `report`, which keeps one install per key (the order serial):
/// the first checkpoint starts it, later ones only move it forward, and
/// `live` / `error` end it. Pushes and polls arrive out of order, so a
/// late or repeated checkpoint is dropped; a fresh attempt after an error
/// starts over at `booting`. The Android twin is ProvisionProgressCenter.
///
/// The phase vocabulary is the single canonical `ProvisionStatusPhase`
/// (`booting`…`live`/`error`) — there is no second step vocabulary.
///
/// Set hooks on `.shared` from your @main App; leave them nil in
/// previews/tests so the VM stays side-effect-free there.
@MainActor
public final class InstallProgressBridge {
    public static let shared = InstallProgressBridge()

    public var onStart:    ((_ key: String, _ podName: String?) -> Void)?
    public var onStep:     ((_ key: String, _ phase: ProvisionStatusPhase) -> Void)?
    public var onComplete: ((_ key: String, _ serverFqdn: String) -> Void)?
    public var onFailed:   ((_ key: String, _ reason: String) -> Void)?

    /// Rich per-poll status from the canonical channel — lets the App
    /// mirror the full timeline (history + serverDomain) onto the Watch.
    /// Carries the friendly pod name alongside so the watch has a title.
    public var onStatus:   ((_ status: ProvisionStatus, _ podName: String) -> Void)?

    /// Names an install by key when a checkpoint carries none (a push never
    /// names the server). The App points it at the pending pods it holds.
    public var nameForKey: ((_ key: String) -> String?)?

    public static let defaultFailure = "Setup hit a problem"

    private var lastPhase: [String: ProvisionStatusPhase] = [:]
    private var names: [String: String] = [:]

    public init() {}

    /// Record one checkpoint for the install `key`. Returns whether it moved
    /// the install (false for a late, repeated or unknown phase).
    @discardableResult
    public func report(
        key: String,
        podName: String? = nil,
        phase: ProvisionStatusPhase,
        detail: String? = nil,
        serverDomain: String? = nil
    ) -> Bool {
        guard !key.isEmpty else { return false }
        if let podName, !podName.isEmpty { names[key] = podName }
        let prev = lastPhase[key]
        guard Self.advances(from: prev, to: phase) else { return false }
        lastPhase[key] = phase
        if prev == nil || prev == .error {
            onStart?(key, names[key] ?? nameForKey?(key))
        }
        switch phase {
        case .live:
            onComplete?(key, serverDomain ?? "")
            names[key] = nil
        case .error:
            onFailed?(key, (detail?.isEmpty == false ? detail : nil) ?? Self.defaultFailure)
        default:
            onStep?(key, phase)
        }
        return true
    }

    /// One canonical poll result for the install `key`.
    @discardableResult
    public func report(key: String, podName: String? = nil, status: ProvisionStatus) -> Bool {
        report(
            key: key,
            podName: podName,
            phase: status.phase,
            detail: status.detail,
            serverDomain: status.serverDomain
        )
    }

    /// True when `next` should replace `prev` for one install: a later rung
    /// never steps back, nothing follows `live`, and after `error` only a
    /// fresh attempt starting over at `booting` does.
    public static func advances(from prev: ProvisionStatusPhase?, to next: ProvisionStatusPhase) -> Bool {
        if next == .unknown { return false }
        guard let prev else { return true }
        if next == .live || next == .error { return prev != next && prev != .live }
        guard let n = ProvisionStatusPhase.ordered.firstIndex(of: next) else { return false }
        if prev == .live { return false }
        if prev == .error { return next == .booting }
        guard let p = ProvisionStatusPhase.ordered.firstIndex(of: prev) else { return true }
        return n > p
    }

    func resetForTest() {
        lastPhase.removeAll()
        names.removeAll()
        onStart = nil
        onStep = nil
        onComplete = nil
        onFailed = nil
        onStatus = nil
        nameForKey = nil
    }
}
