import Foundation

/// A provisioning PHASE checkpoint delivered by a `provision-phase`
/// push from .com (mirror of the Worker fan-out payload's `meta` block
/// in packages/control-plane/src/provisionEvents.ts).
///
/// The phone receives one of these on every provisioning step the box
/// pushes (`boot`/`cloned`/`deps`/`built`/`identity`/`registered` from
/// the cloud-init bootstrap, `tunnel-online`/`cert-issued`/`ready` from
/// the daemon, and a terminal `failed`). The shell routes it into the
/// install-progress Live Activity so provisioning is a glass box.
public struct ProvisionPhaseEvent: Equatable, Sendable {
    public let username: String
    public let fqdn: String
    /// One of `@flagship/protocol` PROVISION_PHASES.
    public let phase: String
    /// Present only when `phase == "failed"`.
    public let error: String?
    public init(username: String, fqdn: String, phase: String, error: String? = nil) {
        self.username = username
        self.fqdn = fqdn
        self.phase = phase
        self.error = error
    }
}

/// Bridge between the push handler (FlagshipCore) and the FlagshipUI
/// install-progress surface. FlagshipCore can't import FlagshipUI
/// (dependency direction), so the App wires `onPhase` at boot — same
/// pattern as `InstallProgressBridge` for the App→ActivityKit hop.
///
/// Set `onPhase` on `.shared` from your @main App; leave it nil in
/// previews/tests so the handler stays side-effect-free there.
@MainActor
public final class ProvisionPhaseBridge {
    public static let shared = ProvisionPhaseBridge()
    public var onPhase: ((_ event: ProvisionPhaseEvent) -> Void)?
    private init() {}

    /// Parse a `provision-phase` push `userInfo` into an event, if it is
    /// one. Returns nil for any other category so the caller can fall
    /// through to its other routes. Exposed (not just used internally)
    /// so it's unit-testable without UNUserNotificationCenter.
    public static func parse(_ info: [AnyHashable: Any]) -> ProvisionPhaseEvent? {
        // Two shapes, mirroring the rest of the push handler:
        //   - APNs/FCM sealed-payload pushes surface discrete fields in
        //     userInfo (kind/phase/username/fqdn[/error]).
        //   - Web Push (RFC 8291) carries a JSON `meta` the SW unwraps;
        //     when it lands flattened the same discrete keys appear.
        guard (info["kind"] as? String) == "provision-phase" else { return nil }
        guard let phase = info["phase"] as? String, !phase.isEmpty else { return nil }
        let username = (info["username"] as? String) ?? ""
        let fqdn = (info["fqdn"] as? String) ?? ""
        let error = info["error"] as? String
        return ProvisionPhaseEvent(
            username: username,
            fqdn: fqdn,
            phase: phase,
            error: (error?.isEmpty ?? true) ? nil : error
        )
    }
}
