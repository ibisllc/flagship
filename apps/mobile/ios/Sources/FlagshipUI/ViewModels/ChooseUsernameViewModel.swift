import Foundation
import Observation
import FlagshipAPI

/// Backs ChooseUsernameScreen (the **create** path). Owns the debounced
/// availability check against /api/users/check on flagshipserver.com
/// (the Worker) and the resolved state the view renders.
///
/// **Create-only.** As of the login redesign, the demo / test-account /
/// device-capability branches moved OUT of create and into the
/// username-first Join flow (LoginViewModel → `/api/account/resolve`).
/// This view-model only resolves available / taken / invalid for a
/// fresh username reservation; it no longer surfaces demo metadata.
@MainActor
@Observable
public final class ChooseUsernameViewModel {
    public enum Status: Equatable {
        case empty
        case invalid(String)
        case checking
        case available
        case taken
        case networkFallbackAvailable  // regex passed but Worker unreachable

        public var allowsContinue: Bool {
            switch self {
            case .available, .networkFallbackAvailable:
                return true
            default:
                return false
            }
        }
    }

    /// Mirrors the Worker's USERNAME_RE (packages/control-plane/src/labels.ts):
    /// 3–30 lowercase chars, interior single dashes OK (no leading/trailing,
    /// no `--`). Used ONLY as a network-down fallback to keep the continue
    /// button useful when the Worker is unreachable; the authoritative check is
    /// the Worker's response. The `--` ban is what keeps the `<slug>--<creator>`
    /// app-id delimiter unambiguous (docs/service-addressing-double-dash.md).
    public nonisolated static let usernameFallbackRegex = #"^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$"#

    /// 350ms matches Android (ChooseUsernameScreen.kt) so both clients
    /// rate-limit the Worker identically.
    public nonisolated static let debounceMillis: UInt64 = 350

    public private(set) var status: Status = .empty
    public private(set) var lastChecked: String?

    private let server: any FlagshipServerClient
    private let debounce: UInt64

    public init(server: any FlagshipServerClient, debounceMillis: UInt64 = ChooseUsernameViewModel.debounceMillis) {
        self.server = server
        self.debounce = debounceMillis * 1_000_000   // → nanoseconds
    }

    /// Called from a `.task(id: username)` on the view. Cancelling
    /// the previous task is how we debounce — each new keystroke
    /// cancels the in-flight check before the network call fires.
    ///
    /// Mirrors Android (ChooseUsernameScreen.kt): the Worker is the
    /// authoritative source of "valid / reserved / claimed." We do NOT
    /// pre-validate locally — that lets a typed hyphenated label still
    /// reach the network for a proper Worker reason. The fallback regex
    /// only fires when the Worker is unreachable.
    public func evaluate(_ raw: String) async {
        let lower = raw.lowercased()
        if lower.isEmpty {
            status = .empty
            lastChecked = nil
            return
        }
        status = .checking
        do {
            try await Task.sleep(nanoseconds: debounce)
        } catch {
            return                                              // cancelled by next keystroke
        }
        let resp: UsernameAvailabilityResponse
        do {
            resp = try await server.usernameAvailable(lower)
        } catch {
            if Task.isCancelled { return }
            // Network down — fall back to a permissive label check
            // so the screen still moves. The real claim path will
            // surface the proper error when connectivity returns.
            if lower.range(of: Self.usernameFallbackRegex, options: .regularExpression) != nil
                && !lower.contains("--") {
                status = .networkFallbackAvailable
            } else {
                status = .invalid("3–30 lowercase letters, digits, and interior dashes (no double dash).")
            }
            lastChecked = lower
            return
        }
        if Task.isCancelled { return }
        if resp.available {
            status = .available
        } else if resp.reason == "already claimed" {
            status = .taken
        } else {
            status = .invalid(resp.reason ?? "Not available.")
        }
        lastChecked = lower
    }
}
