import Foundation
import FlagshipAPI

/// A provisioning PHASE checkpoint delivered by a `provision-status`
/// push from .com (mirror of the Worker fan-out payload's `meta` block in
/// packages/control-plane/src/provisionStatus.ts `fanOutStatusPush`).
///
/// The canonical push fires on the milestone transitions
/// (`registering`/`sealing`/`live`/`error`); foregrounded apps still see
/// every phase by polling `GET /api/order/<serial>/status`. The shell
/// routes a received push into the install-progress Live Activity + the
/// Watch timeline so provisioning is a glass box even backgrounded.
///
/// The phase is the single canonical `ProvisionStatusPhase` — there is no
/// fine-grained second vocabulary. `serial` is the per-order key; `detail`
/// carries the optional error / sub-phase text.
public struct ProvisionPhaseEvent: Equatable, Sendable {
    public let serial: String
    public let phase: ProvisionStatusPhase
    /// Optional detail (error reason, ACME sub-phase, …).
    public let detail: String?
    public init(serial: String, phase: ProvisionStatusPhase, detail: String? = nil) {
        self.serial = serial
        self.phase = phase
        self.detail = detail
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

    /// Parse a `provision-status` push `userInfo` into an event, if it is
    /// one. Returns nil for any other category so the caller can fall
    /// through to its other routes. Exposed (not just used internally) so
    /// it's unit-testable without UNUserNotificationCenter.
    ///
    /// Recognises the canonical payload (design §2.3):
    ///   - `category == "provision-status"` OR `meta.kind == "provision-status"`
    ///   - the phase lives in `meta.phase` (a `ProvisionStatusPhase`), with
    ///     `meta.serial` / `meta.detail` alongside.
    /// Two delivery shapes, mirroring the rest of the push handler:
    ///   - APNs/FCM sealed-payload pushes flatten `meta.*` to the top
    ///     level of userInfo (kind/phase/serial[/detail]).
    ///   - Web Push (RFC 8291) carries a nested `meta` dictionary the SW
    ///     unwraps; we read either shape.
    public static func parse(_ info: [AnyHashable: Any]) -> ProvisionPhaseEvent? {
        let meta = info["meta"] as? [AnyHashable: Any]

        func field(_ key: String) -> Any? {
            meta?[key] ?? info[key]
        }

        let category = info["category"] as? String
        let kind = (field("kind") as? String)
        guard category == "provision-status" || kind == "provision-status" else { return nil }

        guard let phaseRaw = field("phase") as? String, !phaseRaw.isEmpty,
              let phase = ProvisionStatusPhase(rawValue: phaseRaw)
        else { return nil }

        let serial = (field("serial") as? String) ?? ""
        let detail = field("detail") as? String
        return ProvisionPhaseEvent(
            serial: serial,
            phase: phase,
            detail: (detail?.isEmpty ?? true) ? nil : detail
        )
    }
}
