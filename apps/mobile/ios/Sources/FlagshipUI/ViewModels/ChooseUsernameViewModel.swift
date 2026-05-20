import Foundation
import Observation
import FlagshipAPI

/// Backs ChooseUsernameScreen. Owns the debounced availability check
/// against /api/users/check on flagshipserver.com (the Worker) and the
/// resolved state the view renders.
///
/// Test-account branch: when the Worker returns a non-null
/// `testAccount` block, the typed username matched the off-git secret
/// list and the screen flips its CTA to "Enter <display>". Activation
/// itself lives in DemoFixtures in FlagshipCore — the view-model only
/// surfaces the metadata.
@MainActor
@Observable
public final class ChooseUsernameViewModel {
    public enum Status: Equatable {
        case empty
        case invalid(String)
        case checking
        case available
        case taken
        /// Legacy + Plan A demo branch. `demoServer` is non-nil when
        /// the Worker also returned a live `demoServer` block (Plan A
        /// — on-connect Hetzner). Nil ⇒ legacy fixtures-only path so
        /// already-shipped binaries / reviewers without a live VPS
        /// still get the three-pod sandbox.
        case testAccount(TestAccountMeta, demoServer: DemoServerBlock?)
        case networkFallbackAvailable  // regex passed but Worker unreachable

        public var allowsContinue: Bool {
            switch self {
            case .available, .testAccount, .networkFallbackAvailable: return true
            default: return false
            }
        }

        public var testAccountMeta: TestAccountMeta? {
            if case .testAccount(let m, _) = self { return m }
            return nil
        }

        /// Plan A — the server-supplied `demoServer` block, when the
        /// matched account has one. Nil for the legacy fixtures-only
        /// path. Callers (OnboardingFlow / ChooseUsernameScreen) pass
        /// this through to DemoFixtures.activate so the live "one
        /// real device" path is taken when available.
        public var demoServerBlock: DemoServerBlock? {
            if case .testAccount(_, let demo) = self { return demo }
            return nil
        }
    }

    /// RFC 1035 label — mirrors packages/control-plane/src/labels.ts
    /// Mirrors the Worker's USERNAME_RE (packages/control-plane/src/labels.ts).
    /// Used ONLY as a network-down fallback to keep the continue
    /// button useful when the Worker is unreachable; the
    /// authoritative check is the Worker's response. NO hyphens —
    /// usernames are alphanumerics only so `<creator>-<slug>` app ids
    /// parse unambiguously.
    public nonisolated static let usernameFallbackRegex = #"^[a-z0-9]{1,63}$"#

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
    /// authoritative source of "valid / reserved / claimed / test
    /// account." We do NOT pre-validate locally — that lets a typed
    /// hyphenated label or a Worker-secret test-account string still
    /// reach the network. The fallback regex only fires when the
    /// Worker is unreachable.
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
            if lower.range(of: Self.usernameFallbackRegex, options: .regularExpression) != nil {
                status = .networkFallbackAvailable
            } else {
                status = .invalid("Letters, digits, and hyphens only (not at the start or end).")
            }
            lastChecked = lower
            return
        }
        if Task.isCancelled { return }
        if let meta = resp.testAccount {
            // Plan A — propagate the optional demoServer block so the
            // host screen can hand it to DemoFixtures.activate. When
            // present, the host renders ONE live device backed by a
            // Hetzner VPS; when nil, the legacy 3-fixture path runs.
            status = .testAccount(meta, demoServer: resp.demoServer)
        } else if resp.available {
            status = .available
        } else if resp.reason == "already claimed" {
            status = .taken
        } else {
            status = .invalid(resp.reason ?? "Not available.")
        }
        lastChecked = lower
    }
}
