import Foundation
import FlagshipAPI

// An app's status pill (docs/app-placement.md §6): one server's state on the
// app page and its Runs-on rows, every server's states combined on the
// services list.

/// What one server says about an app it lists.
public enum AppServerState: Equatable, Sendable {
    case running, starting, stopped, deploying, copying, editing
    /// An older box (it always says "unknown"), or Docker couldn't be asked:
    /// the app is installed there but its state isn't known.
    case unknown

    /// Work on the app outranks its container state; a copy still arriving
    /// counts as copying even from a box that predates `activity`.
    public init(_ app: AppSummary) {
        switch app.activity?.kind {
        case "deploying": self = .deploying
        case "copying": self = .copying
        case "editing": self = .editing
        default:
            if let cp = app.copying, ServerAppsController.isUnderway(cp.state) {
                self = .copying
                return
            }
            switch app.status {
            case "running": self = .running
            case "starting": self = .starting
            case "stopped": self = .stopped
            default: self = .unknown
            }
        }
    }

    /// The pill for this one server, or nil when its state isn't known.
    public var pill: AppStatusPill? {
        switch self {
        case .running: return AppStatusPill(label: "Running", kind: .online)
        case .starting: return AppStatusPill(label: "Starting", kind: .busy)
        case .stopped: return AppStatusPill(label: "Stopped", kind: .idle)
        case .deploying: return AppStatusPill(label: "Deploying", kind: .busy)
        case .copying: return AppStatusPill(label: "Copying", kind: .busy)
        case .editing: return AppStatusPill(label: "Editing", kind: .busy)
        case .unknown: return nil
        }
    }

    public var isLive: Bool { self == .running || self == .starting }
}

public struct AppStatusPill: Equatable, Sendable {
    public enum Kind: Equatable, Sendable { case online, busy, idle, warning }
    /// What the pill says, and what VoiceOver reads ("On 2 servers").
    public let label: String
    public let kind: Kind
    /// Set on "On N servers": the services list shows N and Home's server
    /// icon instead of the words.
    public let serverCount: Int?

    public init(label: String, kind: Kind, serverCount: Int? = nil) {
        self.label = label
        self.kind = kind
        self.serverCount = serverCount
    }

    public var fsKind: FSPillKind {
        switch kind {
        case .online: return .online
        case .busy: return .provisioning
        case .idle: return .idle
        case .warning: return .pending
        }
    }

    /// The services-list pill. `answers` has one entry per server known to
    /// list the app: its state, or nil when that server didn't answer this
    /// time.
    ///
    /// 1. any deploying or copying → Deploying
    /// 2. else any editing → Editing
    /// 3. else N running or starting → On N servers. With none, servers that
    ///    list the app but can't say ("unknown") count instead: it's installed
    ///    there and may be running.
    /// 4. else every server that answered says stopped → Stopped
    /// 5. else (no server answered) → Can't reach
    public static func combined(_ answers: [AppServerState?]) -> AppStatusPill {
        let states = answers.compactMap { $0 }
        if states.contains(where: { $0 == .deploying || $0 == .copying }) {
            return AppStatusPill(label: "Deploying", kind: .busy)
        }
        if states.contains(.editing) { return AppStatusPill(label: "Editing", kind: .busy) }
        let live = states.filter(\.isLive).count
        let on = live > 0 ? live : states.filter { $0 == .unknown }.count
        if on > 0 { return AppStatusPill(label: on == 1 ? "On 1 server" : "On \(on) servers", kind: .online, serverCount: on) }
        if !states.isEmpty { return AppStatusPill(label: "Stopped", kind: .idle) }
        return AppStatusPill(label: "Can't reach", kind: .warning)
    }
}
