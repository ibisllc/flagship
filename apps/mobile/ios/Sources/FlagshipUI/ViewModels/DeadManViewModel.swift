import Foundation
import Observation
import CryptoKit
import Flagship
import FlagshipAPI
import FlagshipCore

/// Dead-man heartbeat-lock orchestrator for the per-server settings screen.
///
/// Two owner-IRK-signed actions, each behind a biometric prompt:
///   - `applyPolicy` — enable/disable + window + lockout (`SetDeadManPolicy`
///     → `POST /api/deadman/policy`).
///   - `affirm` — the manual "keep unlocked" renewal (`DeadManAffirmation` →
///     `POST /api/deadman/affirm`). NEVER automatic: the user must tap, and
///     the biometric prompt fires inside `signer` every time.
///
/// On a successful affirm it persists the returned `leaseExpiry` and
/// (re)schedules the T-6h/T-1h/T-15m local reminders.
@Observable
@MainActor
public final class DeadManViewModel {

    public enum Phase: Equatable, Sendable {
        case idle
        case savingPolicy
        case affirming
        case failed(String)
    }

    public private(set) var phase: Phase = .idle

    // Mirrors the persisted store; the view binds to these for the editor.
    public var enabled: Bool
    public var window: DeadManStore.WindowPreset
    public var lockoutMode: PowerMode
    public private(set) var leaseExpiry: Int64?

    private let client: any LockPowerClient
    private let store: DeadManStore
    private let serverDomain: String
    private let serverName: String
    private let signer: @MainActor (String) async throws -> Curve25519.Signing.PrivateKey
    private let now: () -> Int64
    /// Side-effect hook for reminders; injected so tests don't touch
    /// UNUserNotificationCenter. Default reschedules the real reminders.
    private let scheduleReminders: (String, String, Int64) -> Void
    private let cancelReminders: (String) -> Void

    public init(
        client: any LockPowerClient,
        serverDomain: String,
        serverName: String,
        store: DeadManStore = DeadManStore(),
        signer: (@MainActor (String) async throws -> Curve25519.Signing.PrivateKey)? = nil,
        now: @escaping () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) },
        scheduleReminders: ((String, String, Int64) -> Void)? = nil,
        cancelReminders: ((String) -> Void)? = nil
    ) {
        self.client = client
        self.serverDomain = serverDomain
        self.serverName = serverName
        self.store = store
        self.now = now
        self.signer = signer ?? { reason in try await Keystore.deriveIRK(reason: reason) }
        self.scheduleReminders = scheduleReminders ?? { domain, name, expiry in
            #if canImport(UserNotifications)
            DeadManReminders.reschedule(serverDomain: domain, serverName: name, leaseExpiryMs: expiry)
            #endif
        }
        self.cancelReminders = cancelReminders ?? { domain in
            #if canImport(UserNotifications)
            DeadManReminders.cancel(serverDomain: domain)
            #endif
        }
        self.enabled = store.isEnabled(for: serverDomain)
        self.window = DeadManStore.WindowPreset.nearest(ms: store.windowMs(for: serverDomain))
        self.lockoutMode = PowerMode(rawValue: store.lockoutMode(for: serverDomain)) ?? .off
        self.leaseExpiry = store.leaseExpiry(for: serverDomain)
    }

    /// Time remaining (ms) on the dead-man lease, or nil if no lease known.
    public func leaseRemainingMs() -> Int64? {
        guard let leaseExpiry else { return nil }
        return leaseExpiry - now()
    }

    /// Sign + POST the current policy (enabled/window/lockout). On enable
    /// the user should then affirm to start the first lease; on disable we
    /// clear the local lease + reminders.
    public func applyPolicy(enabled: Bool, window: DeadManStore.WindowPreset, lockoutMode: PowerMode) async {
        phase = .savingPolicy
        let windowMs = window.ms
        let graceMs = DeadManStore.defaultGraceMs
        let key: Curve25519.Signing.PrivateKey
        do {
            key = try await signer(enabled ? "Enable lock-down for \(serverDomain)" : "Disable lock-down for \(serverDomain)")
        } catch {
            phase = .failed("Couldn't access your account key. \(HumanError.humanize(error))")
            return
        }
        let policy = DeadManPolicy(
            serverId: serverDomain,
            enabled: enabled,
            windowMs: windowMs,
            graceMs: graceMs,
            lockoutMode: lockoutMode,
            issuedAt: now()
        )
        let sig: Data
        do { sig = try policy.sign(with: key) } catch {
            phase = .failed("Couldn't sign. \(HumanError.humanize(error))")
            return
        }
        do {
            let env = policy.envelope(signatureHex: HexUtil.encode(sig))
            let result = try await client.setDeadManPolicy(
                serverDomain: serverDomain,
                request: env["request"] as! [String: Any],
                signatureHex: env["signature"] as! String
            )
            guard result.ok else {
                phase = .failed("The box rejected the change. Try again.")
                return
            }
        } catch let e as ScreensClientError {
            phase = .failed(e.errorDescription ?? "That didn't work. Try again in a moment.")
            return
        } catch {
            phase = .failed("Couldn't reach the box. Check your connection and try again.")
            return
        }

        store.save(serverDomain: serverDomain, enabled: enabled, windowMs: windowMs, graceMs: graceMs, lockoutMode: lockoutMode.rawValue)
        self.enabled = enabled
        self.window = window
        self.lockoutMode = lockoutMode
        if !enabled {
            store.setLeaseExpiry(nil, for: serverDomain)
            leaseExpiry = nil
            cancelReminders(serverDomain)
        }
        phase = .idle
    }

    /// The manual keep-unlocked affirmation. Biometric inside `signer`;
    /// never invoked automatically.
    public func affirm() async {
        phase = .affirming
        let key: Curve25519.Signing.PrivateKey
        do {
            key = try await signer("Keep \(serverDomain) unlocked")
        } catch {
            phase = .failed("Couldn't access your account key. \(HumanError.humanize(error))")
            return
        }
        let affirmation = DeadManAffirmation(
            serverId: serverDomain,
            nonce: DeadManAffirmation.freshNonce(),
            issuedAt: now()
        )
        let sig: Data
        do { sig = try affirmation.sign(with: key) } catch {
            phase = .failed("Couldn't sign. \(HumanError.humanize(error))")
            return
        }
        do {
            let env = affirmation.envelope(signatureHex: HexUtil.encode(sig))
            let result = try await client.affirmDeadMan(
                serverDomain: serverDomain,
                request: env["request"] as! [String: Any],
                signatureHex: env["signature"] as! String
            )
            guard result.ok else {
                phase = .failed("The box rejected the affirmation. Try again.")
                return
            }
            store.setLeaseExpiry(result.leaseExpiry, for: serverDomain)
            leaseExpiry = result.leaseExpiry
            scheduleReminders(serverDomain, serverName, result.leaseExpiry)
        } catch let e as ScreensClientError {
            phase = .failed(e.errorDescription ?? "That didn't work. Try again in a moment.")
            return
        } catch {
            phase = .failed("Couldn't reach the box. Check your connection and try again.")
            return
        }
        phase = .idle
    }
}
