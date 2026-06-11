import Foundation
import Observation
import FlagshipAPI

/// Backs the username-first **Join** ("I already have an account") flow.
///
/// The sign-in space is access-control evaluation, not a fetch: the user
/// types a bare username and we run a single preflight
/// (`/api/account/resolve/<username>`, 200 ALWAYS) and branch on `kind`.
/// A raw 404 here would be a category error — every "absent" is a node
/// in the decision tree, surfaced as a STATE, not an error card.
///
/// Phase 1 wires the **demo** branch fully (crypto no-op, attach + open)
/// and the **unknown** state. The `single` / `multi` branches hand off
/// to the existing passkey recovery container until Phase 3 replaces it.
/// See docs/login-and-account-redesign.md "The unified login decision
/// tree".
@MainActor
@Observable
public final class LoginViewModel {
    /// The outcome the host (OnboardingFlow) acts on once `submit()`
    /// resolves. Distinct from the transient `phase` so the view can
    /// render an idle/loading state independently of the branch.
    public enum Outcome: Equatable, Sendable {
        /// Demo account — skip every credential, attach a new device,
        /// open the sandbox with the server-supplied demoServer block.
        case demo(username: String, demoServer: DemoServerBlock?)
        /// No account by that name. Render a clean state, NOT a 404.
        case unknown(username: String)
        /// Real account (single/multi). Phase 1 hands these to the
        /// existing passkey recovery container; the win is the entry
        /// no longer STARTS with assertAny() + 404 — it starts with
        /// username → resolve. Phase 3 replaces this with the full
        /// state machine. `resolution` carries the preflight so the
        /// downstream flow doesn't re-resolve.
        case realAccount(resolution: AccountResolution)
    }

    public enum Phase: Equatable, Sendable {
        case idle
        case resolving
        /// Terminal: the preflight resolved to `outcome`. The host
        /// reads `outcome` and navigates.
        case resolved(Outcome)
        /// The preflight network call failed (a real outage — a 5xx /
        /// transport error, NOT a missing account, which is a resolved
        /// `.unknown`). The view shows a retry affordance.
        case failed(String)
    }

    /// RFC-1035-ish bare-handle rule, mirroring the Worker's
    /// USERNAME_RE (packages/control-plane/src/labels.ts): 1–63
    /// lowercase letters or digits, NO dots, NO hyphens, no specials.
    /// Demo usernames may legitimately carry hyphens (they live in
    /// their own table), so we do NOT pre-reject hyphens locally — the
    /// Worker is authoritative and a demo name must still reach the
    /// resolve call. The local check only blocks obviously-empty input.
    public nonisolated static let minLength = 1

    public private(set) var phase: Phase = .idle

    private let server: any FlagshipServerClient

    public init(server: any FlagshipServerClient) {
        self.server = server
    }

    /// True when there's enough typed to attempt a resolve. Used to
    /// gate the submit button.
    public func canSubmit(_ raw: String) -> Bool {
        !raw.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// Run the preflight for [raw] and land on a terminal `phase`.
    /// Never throws for a missing account — that's a resolved
    /// `.unknown`. Only a transport/5xx failure lands on `.failed`.
    public func submit(_ raw: String) async {
        let username = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !username.isEmpty else {
            phase = .idle
            return
        }
        phase = .resolving
        let resolution: AccountResolution
        do {
            resolution = try await server.resolveAccount(username: username)
        } catch {
            if Task.isCancelled { return }
            phase = .failed(humanizedError(error))
            return
        }
        if Task.isCancelled { return }
        switch resolution.kind {
        case .demo:
            phase = .resolved(.demo(
                username: resolution.username,
                demoServer: resolution.demoServer
            ))
        case .unknown:
            phase = .resolved(.unknown(username: resolution.username))
        case .single, .multi:
            phase = .resolved(.realAccount(resolution: resolution))
        }
    }

    /// Reset to idle so the user can edit the username and retry after
    /// a failure or after viewing the unknown state.
    public func reset() {
        phase = .idle
    }

    private func humanizedError(_ error: Error) -> String {
        // UX-B — never show a raw status code. The shared ScreensClientError
        // already maps to plain language (incl. the UX-A cert-pin case).
        if case let pinError as ScreensClientError = error,
           pinError.errorDescription != nil {
            return pinError.errorDescription!
        }
        return "Couldn't reach Flagship. Check your connection and try again."
    }
}
