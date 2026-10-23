import Foundation
import Observation
import CryptoKit
import Flagship
import FlagshipAPI
import FlagshipCore

/// Manual lock/power-off orchestrator for the server-detail screen.
///
/// Signs a `power-off` PhoneOrder (mode "off" | "restart") with the owner
/// IRK — the same key the daemon's `/api/power` pins (on this
/// account the box's "PSK" pubkey IS the owner IRK, exactly as the webapp's
/// `add-paired-session` order is IRK-signed) — behind a biometric prompt, and
/// POSTs it box-direct over the pinned session.
///
/// SECURITY: it powers off / locks a box, so the UI gates each tap with an
/// "Are you sure?" confirm AND the biometric prompt fires inside `signer`.
@Observable
@MainActor
public final class LockPowerViewModel {

    public enum Phase: Equatable, Sendable {
        case idle
        case signing
        case posting
        /// The box was told to power off / restart — the UI reflects this as
        /// "powering off…" → offline.
        case sent(PowerMode)
        case failed(String)
        /// A restart was requested but the lock could not be recorded at the boot
        /// service, so nothing was sent. The screen offers a shutdown instead.
        case lockUnconfirmed(String)
    }

    public private(set) var phase: Phase = .idle
    /// The durable lock at the boot service, reported apart from the power order
    /// (SEC-LOCK-001). Never `.confirmed` for less than a recorded lock.
    public private(set) var lockOutcome: BootLockOutcome?
    /// What the screen says about the last action, in words that don't overclaim.
    public private(set) var summary: String = ""

    private let client: any LockPowerClient
    private let serverDomain: String
    private let signer: @MainActor (String) async throws -> Curve25519.Signing.PrivateKey
    private let now: () -> Int64
    /// Locks the server at the boot service. nil on a box that doesn't unlock from the phone.
    private let bootLock: BootLock?
    private let irkSigner: @MainActor (String) async throws -> Curve25519.Signing.PrivateKey
    private let lockStore: BootLockStateStore

    public init(
        client: any LockPowerClient,
        serverDomain: String,
        signer: (@MainActor (String) async throws -> Curve25519.Signing.PrivateKey)? = nil,
        bootLock: BootLock? = nil,
        irkSigner: (@MainActor (String) async throws -> Curve25519.Signing.PrivateKey)? = nil,
        lockStore: BootLockStateStore = BootLockStateStore(),
        now: @escaping () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) }
    ) {
        self.client = client
        self.serverDomain = serverDomain
        self.bootLock = bootLock
        self.lockStore = lockStore
        self.irkSigner = irkSigner ?? { reason in try await Keystore.deriveIRK(reason: reason) }
        self.now = now
        // Slice D — power-off / restart is a SENSITIVE order: sign with the admin
        // master root when this device holds one, else the legacy owner IRK.
        self.signer = signer ?? { reason in try await Keystore.sensitiveOrderSigningKey(reason: reason) }
    }

    public func run(mode: PowerMode) async {
        summary = ""
        lockOutcome = nil
        phase = .signing
        let reason = mode == .off
            ? "Lock and turn off \(serverDomain)"
            : "Lock and restart \(serverDomain)"
        let irk: Curve25519.Signing.PrivateKey?
        if bootLock != nil {
            do {
                irk = try await irkSigner(reason)
            } catch {
                phase = .failed("Couldn't access your account key: \(UserErrorText.of(error))")
                return
            }
        } else {
            irk = nil
        }

        // A restart is sent only once the lock is durable: a reboot into a lease that
        // was never revoked is exactly what the lock exists to prevent.
        if mode == .restart, let bootLock, let irk {
            phase = .posting
            let lock = await bootLock.setOwner(serverDomain: serverDomain, action: .suspend, irk: irk)
            lockOutcome = lock
            guard case .confirmed = lock else {
                lockStore.markPending(serverDomain)
                let msg = "Couldn't lock this server at the boot service, so it was not restarted. Shut it down instead? It will lock as soon as the service answers."
                summary = msg
                phase = .lockUnconfirmed(msg)
                return
            }
            lockStore.setLastKnown(true, for: serverDomain)
            lockStore.clearPending(serverDomain)
        }

        let outcome = await sendPower(mode: mode, reason: reason, concurrentLock: mode == .off ? (bootLock.flatMap { b in irk.map { (b, $0) } }) : nil)
        guard let sent = outcome else { return }
        summary = LockWords.describe(lock: lockOutcome, powerSent: true, mode: mode,
                                     executed: sent.mode == mode.rawValue ? nil : PowerMode(rawValue: sent.mode))
        phase = .sent(PowerMode(rawValue: sent.mode) ?? mode)
    }

    /// The user chose "shut down" after a restart could not be locked.
    public func shutDownInstead() async {
        await run(mode: .off)
    }

    /// Retry a lock the boot service did not confirm earlier.
    public func retryPendingLock() async -> BootLockOutcome? {
        guard let bootLock else { return nil }
        let irk: Curve25519.Signing.PrivateKey
        do { irk = try await irkSigner("Lock \(serverDomain)") } catch { return nil }
        let r = await bootLock.setOwner(serverDomain: serverDomain, action: .suspend, irk: irk)
        if case .confirmed = r {
            lockStore.setLastKnown(true, for: serverDomain)
            lockStore.clearPending(serverDomain)
        }
        lockOutcome = r
        return r
    }

    /// Resume: a signed new epoch. The next start can use a lease again once the
    /// owner turns auto-unlock back on; resume alone does not deposit one.
    public func resume() async -> BootLockOutcome? {
        guard let bootLock else { return nil }
        let irk: Curve25519.Signing.PrivateKey
        do { irk = try await irkSigner("Resume \(serverDomain)") } catch { return nil }
        let r = await bootLock.setOwner(serverDomain: serverDomain, action: .resume, irk: irk)
        if case .confirmed = r {
            lockStore.setLastKnown(false, for: serverDomain)
            lockStore.clearPending(serverDomain)
        }
        return r
    }

    /// Sign and POST the power order; for "off", the lock is made at the same time and the
    /// power order never waits for the boot service. Returns what the box did, or nil after
    /// setting `phase` to a failure.
    private func sendPower(
        mode: PowerMode,
        reason: String,
        concurrentLock: (BootLock, Curve25519.Signing.PrivateKey)?
    ) async -> PowerOffResult? {
        let key: Curve25519.Signing.PrivateKey
        do {
            key = try await signer(reason)
        } catch {
            phase = .failed("Couldn't access your account key: \(UserErrorText.of(error))")
            return nil
        }
        let order = PowerOffOrder(serverId: serverDomain, mode: mode, issuedAt: now())
        let signature: Data
        do {
            signature = try order.sign(with: key)
        } catch {
            phase = .failed("Couldn't sign: \(UserErrorText.of(error))")
            return nil
        }

        phase = .posting
        let env = order.envelope(signatureHex: HexUtil.encode(signature))
        let request = env["request"] as! [String: Any]
        let sig = env["signature"] as! String
        let domain = serverDomain

        async let lockTask: BootLockOutcome? = {
            guard let (lock, irk) = concurrentLock else { return nil }
            return await lock.setOwner(serverDomain: domain, action: .suspend, irk: irk)
        }()
        let result: PowerOffResult?
        var failure: String?
        do {
            result = try await client.sendPower(serverDomain: serverDomain, request: request, signatureHex: sig)
        } catch let e as ScreensClientError {
            result = nil
            failure = e.errorDescription ?? "That didn't work. Try again in a moment."
        } catch {
            result = nil
            failure = "Couldn't reach the server. Check your connection and try again."
        }
        if let lock = await lockTask {
            lockOutcome = lock
            if case .confirmed = lock { lockStore.setLastKnown(true, for: serverDomain); lockStore.clearPending(serverDomain) }
            else { lockStore.markPending(serverDomain) }
        }
        if let failure {
            summary = LockWords.describe(lock: lockOutcome, powerSent: false, mode: mode)
            phase = .failed(failure)
            return nil
        }
        return result
    }
}
