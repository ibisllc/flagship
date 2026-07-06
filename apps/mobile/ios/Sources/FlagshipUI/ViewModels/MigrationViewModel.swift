import Foundation
import Observation
import CryptoKit
import Flagship
import FlagshipAPI
import FlagshipCore

/// "Migrate to new hardware" — the server-migration orchestrator for the
/// server-detail screen (docs/server-migration.md). Same owner, same
/// `<server>.<user>` name, NEW box.
///
/// Two modes, mirroring the webapp dialog:
///   - no session → the admin-signed INITIATE ceremony (resolve the box's
///     CURRENT STK from the directory, disposition picker, backup pre-flight
///     gate, sign + deposit, record the SWK migration hold);
///   - live session → the 8-step progress timeline (5s poll while visible)
///     with the phase-appropriate action (hand off / abort).
///
/// The migration ORDER/CONTROL are SENSITIVE (Slice D) → they sign with the
/// admin master root when this device holds one, else the legacy owner IRK
/// (the same key `Keystore.sensitiveOrderSigningKey` would return); the
/// mailbox AUTH stays IRK-signed. The box STK is resolved from the directory
/// BEFORE the biometric (same trust model as the Replace flow).
@Observable
@MainActor
public final class MigrationViewModel {

    public enum Mode: Equatable, Sendable {
        case loading
        /// No live session — show the initiate ceremony.
        case initiate
        /// A session exists — show the timeline (poll drives updates).
        case progress
        case failed(String)
    }

    public private(set) var mode: Mode = .loading
    /// True once the backup pre-flight found NO enrolled peer-backup. The
    /// restore rides peer-backup, so a no-backup box can only migrate with
    /// `keep` (the old disk remains the fallback copy) — same fail-closed
    /// posture as the Replace pre-flight gate.
    public private(set) var backupMissing = false
    /// The migrating box's CURRENT STK from the directory (nil ⇒ can't start).
    public private(set) var oldStkPubHex: String?
    public var disposition: ServerMigrationFlow.Disposition = ServerMigrationFlow.defaultDisposition
    public private(set) var session: MigrationSession?
    public private(set) var working = false
    /// Inline error surfaced next to the action (the mode stays usable).
    public private(set) var errorMessage: String?

    public let serverFqdn: String
    private let username: String
    private let migration: any ServerMigrationClient
    private let mailbox: any SecretMailboxClient
    private let screens: any ScreensClient
    private let holdStore: MigrationHoldStore
    /// ONE biometric ceremony → the IRK (mailbox auth) + the admin root when
    /// this device holds one (the sensitive order signer, `orderKey ?? irk`).
    private let signer: @MainActor (String) async throws -> (irk: Curve25519.Signing.PrivateKey, orderKey: Curve25519.Signing.PrivateKey?)
    private let now: () -> Int64
    private let randomNonce: () -> Data
    private let pollIntervalNs: UInt64

    public init(
        migration: any ServerMigrationClient,
        mailbox: any SecretMailboxClient,
        screens: any ScreensClient,
        serverFqdn: String,
        username: String,
        holdStore: MigrationHoldStore = MigrationHoldStore(),
        signer: (@MainActor (String) async throws -> (irk: Curve25519.Signing.PrivateKey, orderKey: Curve25519.Signing.PrivateKey?))? = nil,
        now: @escaping () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) },
        randomNonce: @escaping () -> Data = { ServerMigrationFlow.random32() },
        pollIntervalNs: UInt64 = 5_000_000_000
    ) {
        self.migration = migration
        self.mailbox = mailbox
        self.screens = screens
        self.serverFqdn = serverFqdn
        self.username = username
        self.holdStore = holdStore
        self.now = now
        self.randomNonce = randomNonce
        self.pollIntervalNs = pollIntervalNs
        self.signer = signer ?? { reason in
            let irk = try await Keystore.deriveIRK(reason: reason)
            let orderKey = Keystore.hasAdminRoot
                ? try await Keystore.adminRootKey(reason: reason)
                : nil
            return (irk, orderKey)
        }
    }

    // MARK: - Timeline projection

    public var steps: [ServerMigrationTimeline.Step] {
        guard let session else { return [] }
        return ServerMigrationTimeline.steps(for: session)
    }

    public var waitCopy: String {
        guard let session else { return "" }
        return ServerMigrationTimeline.waitCopy(for: session, nowMs: now())
    }

    /// Abort is offered at every pre-take-over step — everything before
    /// take-over aborts cleanly (the old box stays authoritative with all its
    /// data); `.com` 409s after (the point of no return).
    public var canAbort: Bool {
        guard let session else { return false }
        return session.abortedAt == nil && session.takenOverAt == nil
    }

    public var isTerminal: Bool {
        guard let session else { return false }
        return session.done || session.abortedAt != nil
    }

    /// The wipe-after-handoff gate (mirrors the Replace pre-flight posture).
    public var startBlocked: Bool {
        (disposition == .wipeAfterHandoff && backupMissing) || oldStkPubHex == nil
    }

    // MARK: - Load / poll

    /// An in-flight session wins — render its timeline. Otherwise resolve the
    /// initiate context (STK + backup signal) before offering the ceremony.
    public func load() async {
        mode = .loading
        let existing: MigrationSession?
        do {
            existing = try await migration.fetchMigration(serverDomain: serverFqdn)
        } catch {
            mode = .failed("Couldn't check for a migration in progress. Check your connection and try again.")
            return
        }
        if let existing, existing.abortedAt == nil {
            session = existing
            reconcileHold(existing)
            mode = .progress
            return
        }
        await prepareInitiate()
    }

    private func prepareInitiate() async {
        do {
            let pods = try await mailbox.fetchPods(username: username)
            guard let stk = pods.identityPubKey(forServerDomain: serverFqdn) else {
                mode = .failed("Couldn't read this box's current key from the directory — is it online? It must be reachable to migrate.")
                return
            }
            oldStkPubHex = stk
        } catch {
            mode = .failed("Couldn't reach your account directory. Check your connection and try again.")
            return
        }
        do {
            let status = try await screens.peerBackupStatus()
            backupMissing = !(status.participating && !status.peersBackingYouUp.isEmpty)
        } catch {
            // An unreadable backup signal gates CONSERVATIVELY, like the
            // Replace pre-flight — wipe-after-handoff stays blocked.
            backupMissing = true
        }
        mode = .initiate
    }

    /// One poll tick. Transient errors keep the last render.
    public func refresh() async {
        guard let s = try? await migration.fetchMigration(serverDomain: serverFqdn) else { return }
        session = s
        reconcileHold(s)
        if mode != .progress { mode = .progress }
    }

    /// Poll while the screen is visible — run from `.task` so SwiftUI cancels
    /// it on disappear.
    public func pollLoop() async {
        while !Task.isCancelled, mode == .progress, !isTerminal {
            try? await Task.sleep(nanoseconds: pollIntervalNs)
            if Task.isCancelled { return }
            await refresh()
        }
    }

    private func reconcileHold(_ s: MigrationSession) {
        // Terminal ⇒ the SWK hold is moot: aborted keeps the old box, and at
        // take-over the directory identity is already rebound to the new box.
        if s.abortedAt != nil || s.takenOverAt != nil {
            holdStore.clearHold(for: serverFqdn)
        }
    }

    // MARK: - Initiate (phase 1)

    public func start() async {
        errorMessage = nil
        guard let oldStk = oldStkPubHex else {
            errorMessage = "Couldn't read this box's current key — refresh and try again."
            return
        }
        if disposition == .wipeAfterHandoff && backupMissing {
            errorMessage = "This server has no backup — enable backup first, or keep the old disk as the fallback."
            return
        }
        working = true
        defer { working = false }
        do {
            let (irk, orderKey) = try await signer("Migrate \(serverFqdn) to new hardware")
            let body = try ServerMigrationFlow.buildStartDeposit(
                serverFqdn: serverFqdn,
                username: username,
                irk: irk,
                orderKey: orderKey,
                oldStkPubHex: oldStk,
                disposition: disposition,
                issuedAt: now(),
                nonce: randomNonce(),
                authNonce: randomNonce()
            )
            try await migration.startMigration(serverDomain: serverFqdn, body: body)
        } catch let e as ScreensClientError {
            errorMessage = e.errorDescription ?? "That didn't work. Try again in a moment."
            return
        } catch {
            errorMessage = "Couldn't start the migration: \(error.localizedDescription)"
            return
        }
        // The SWK hold makes the NEXT added pod's SWK deposit migration-aware
        // (MigrationSwkResolver, consulted by SwkDepositCoordinator).
        holdStore.setHold(for: serverFqdn)
        mode = .progress
        await refresh()
    }

    // MARK: - Hand off (phases 4+5)

    /// Confirm-ready + freeze under ONE biometric ceremony (two signatures,
    /// one user tap — mirrors the webapp: the confirm is the health checkpoint
    /// the user is looking at right now, and splitting them into two
    /// ceremonies adds a prompt without adding safety; the machine still
    /// enforces pre-seeded → ready → freezing server-side). If the freeze half
    /// fails after confirm-ready landed, the next poll shows `ready` and the
    /// button becomes a freeze-only retry.
    public func handOff() async {
        guard let s = session else { return }
        errorMessage = nil
        working = true
        defer { working = false }
        do {
            let (irk, orderKey) = try await signer("Hand \(serverFqdn) off to the new box")
            if s.phase == "pre-seeded" {
                let confirm = try ServerMigrationFlow.buildControlDeposit(
                    action: "confirm-ready",
                    serverFqdn: serverFqdn,
                    username: username,
                    irk: irk,
                    orderKey: orderKey,
                    issuedAt: now(),
                    nonce: randomNonce(),
                    authNonce: randomNonce()
                )
                try await migration.confirmReady(serverDomain: serverFqdn, body: confirm)
            }
            let freeze = try ServerMigrationFlow.buildFreezeDeposit(
                serverFqdn: serverFqdn,
                username: username,
                irk: irk,
                orderKey: orderKey,
                oldStkPubHex: s.oldStkPubHex,
                disposition: s.disposition,
                issuedAt: now(),
                nonce: randomNonce(),
                authNonce: randomNonce()
            )
            try await migration.freeze(serverDomain: serverFqdn, body: freeze)
        } catch let e as ScreensClientError {
            errorMessage = e.errorDescription ?? "That didn't work. Try again in a moment."
        } catch {
            errorMessage = "Couldn't hand off: \(error.localizedDescription)"
        }
        // CUTOVER (client side of phase 6/7): after `takenOverAt` there is NO
        // client RCK re-point — no surface persists the RCK private key
        // (CreateServerViewModel mints it at create, registers the pub, and
        // discards it), so a SetRoutingTarget cannot be signed. The `.com`
        // take-over handler rebinds the directory identity server-side, and
        // the hub's eviction + the new box's HELLO claim move the live route.
        // Cert re-pin is automatic: the migrated box re-derives the SAME
        // status STK (it runs the same SWK — deriveStkPub is SWK-derived and
        // the SWK is unchanged across migration), so its first verified
        // daemon-status report REPLACES the old fingerprint pin in
        // CertPinRegistry.update (case 2 of the reconcile).
        await refresh()
    }

    // MARK: - Abort

    public func abort() async {
        errorMessage = nil
        working = true
        defer { working = false }
        do {
            let (irk, orderKey) = try await signer("Abort migrating \(serverFqdn)")
            let body = try ServerMigrationFlow.buildControlDeposit(
                action: "abort",
                serverFqdn: serverFqdn,
                username: username,
                irk: irk,
                orderKey: orderKey,
                issuedAt: now(),
                nonce: randomNonce(),
                authNonce: randomNonce()
            )
            try await migration.abortMigration(serverDomain: serverFqdn, body: body)
            holdStore.clearHold(for: serverFqdn)
        } catch let e as ScreensClientError {
            errorMessage = e.errorDescription ?? "That didn't work. Try again in a moment."
        } catch {
            errorMessage = "Couldn't abort: \(error.localizedDescription)"
        }
        await refresh()
    }
}
