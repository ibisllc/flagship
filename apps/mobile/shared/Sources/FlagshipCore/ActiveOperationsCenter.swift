import Foundation
import Observation

/// One operation currently running on the user's behalf — a server being
/// deployed, a service being built, and (by design) anything we add later.
/// Surfaced in the global "operations" sliver: the teal strip the whole
/// shell slides down to reveal, modelled on WhatsApp's active-call bar.
///
/// `target` is the deep link a tap on the sliver follows to that operation's
/// own screen. `seq` is assigned by the center and orders the sliver — it is
/// never shown.
public struct ActiveOperation: Identifiable, Equatable, Sendable {
    public enum Kind: Sendable, Equatable { case deploy, build }

    public let id: String
    public let kind: Kind
    /// The headline noun: the server name (deploy) or the service name (build).
    public let subject: String
    /// Build only — the server the service is being built on. nil drops the
    /// "on <server>" clause; deploy operations always leave it nil.
    public let onServer: String?
    /// Where tapping the sliver navigates.
    public let target: DeepLink
    /// Monotonic insertion order assigned by `ActiveOperationsCenter`. The
    /// most recently started operation (highest `seq`) is the one the single
    /// line sliver shows. Ordering only — never rendered.
    public internal(set) var seq: Int

    public init(
        id: String,
        kind: Kind,
        subject: String,
        onServer: String? = nil,
        target: DeepLink,
        seq: Int = 0
    ) {
        self.id = id
        self.kind = kind
        self.subject = subject
        self.onServer = onServer
        self.target = target
        self.seq = seq
    }

    /// The sentence shown in the sliver. The two canonical shapes are
    /// "deploying server <name>" and "building <service> on <server>"; a build
    /// with no known server collapses to "building <service>".
    public var label: String {
        switch kind {
        case .deploy:
            return "deploying server \(subject)"
        case .build:
            if let onServer, !onServer.isEmpty {
                return "building \(subject) on \(onServer)"
            }
            return "building \(subject)"
        }
    }
}

/// App-wide registry of in-progress operations. The global operations sliver
/// renders the `primary` one and a "+N" hint for the rest; tapping deep-links
/// to that operation. Mirrors the `ToastCenter` / `DeepLinker` pattern — an
/// `@Observable @MainActor` singleton injected into the environment at the App
/// scope, so it outlives any one screen and is the single source of truth the
/// sliver reads.
///
/// Two feeders, deliberately different in shape:
///   - **Deploy** operations are *derived* from the pending-pod list via
///     `syncDeployOperations` — pods are already global, persistent, and
///     polled, so a deploying server stays in the sliver across navigation
///     with zero extra plumbing.
///   - **Build** operations are *registered* imperatively
///     (`upsertBuild` / `removeBuild`) by the in-app build lifecycle, because
///     a service build has no global signal today.
@Observable
@MainActor
public final class ActiveOperationsCenter {
    public private(set) var operations: [ActiveOperation] = []
    private var nextSeq: Int = 0

    public init() {}

    /// The single operation the sliver shows: the most recently started.
    public var primary: ActiveOperation? {
        operations.max(by: { $0.seq < $1.seq })
    }

    /// Operations running beyond the primary, for the sliver's "+N" hint.
    public var additionalCount: Int { max(0, operations.count - 1) }

    // MARK: - Build operations (imperative)

    /// Register or refresh a build operation. An existing id keeps its `seq`
    /// so a mid-build label refresh (the service name arriving, say) doesn't
    /// jump it to the front of the sliver. Churn-free: identical upserts don't
    /// touch `operations`, so steady polling never spams observers.
    public func upsertBuild(id: String, subject: String, onServer: String?, target: DeepLink) {
        let opId = Self.buildId(id)
        if let idx = operations.firstIndex(where: { $0.id == opId }) {
            let updated = ActiveOperation(
                id: opId, kind: .build, subject: subject,
                onServer: onServer, target: target, seq: operations[idx].seq
            )
            if operations[idx] != updated { operations[idx] = updated }
        } else {
            operations.append(ActiveOperation(
                id: opId, kind: .build, subject: subject,
                onServer: onServer, target: target, seq: bump()
            ))
        }
    }

    public func removeBuild(id: String) {
        let opId = Self.buildId(id)
        if operations.contains(where: { $0.id == opId }) {
            operations.removeAll { $0.id == opId }
        }
    }

    // MARK: - Deploy operations (derived from pending pods)

    /// Reconcile deploy operations against the current pods. A pod in
    /// `.pending` gets (or keeps) a deploy op; a pod that has left `.pending`
    /// — went live, was cancelled, was removed — drops its op. Existing ops
    /// keep their `seq` so a steady re-sync never reorders the sliver, and the
    /// whole `operations` array is only reassigned when something actually
    /// changed (so calling this on every pod-list tick is free). Build
    /// operations are untouched.
    public func syncDeployOperations(pods: [PodInfo]) {
        let pending = pods.filter { $0.status == .pending }
        let desiredIds = Set(pending.map { Self.deployId($0.podId) })

        // Start from everything that isn't a now-defunct deploy op.
        var next = operations.filter { $0.kind != .deploy || desiredIds.contains($0.id) }

        for pod in pending {
            let opId = Self.deployId(pod.podId)
            let keptSeq = next.first(where: { $0.id == opId })?.seq
            let op = ActiveOperation(
                id: opId, kind: .deploy, subject: pod.name,
                target: .serverDetail(podId: pod.podId),
                seq: keptSeq ?? bump()
            )
            if let idx = next.firstIndex(where: { $0.id == opId }) {
                next[idx] = op
            } else {
                next.append(op)
            }
        }

        if next != operations { operations = next }
    }

    // MARK: - Internals

    private func bump() -> Int {
        nextSeq += 1
        return nextSeq
    }

    /// Namespaced ids keep the two feeders from ever colliding (a pod and a
    /// build session could share a raw string).
    private static func deployId(_ podId: String) -> String { "deploy:\(podId)" }
    private static func buildId(_ id: String) -> String { "build:\(id)" }
}
