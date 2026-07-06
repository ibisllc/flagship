import Foundation
import Observation
import CryptoKit
import Flagship
import FlagshipAPI
import FlagshipCore

/// "Replace this server" — graceful-decommission orchestrator for the
/// server-detail screen (docs/server-replacement-graceful-decommission.md).
///
/// Mirrors the transfer-a-box giver flow + the lock-and-power flow:
///   1. PRE-FLIGHT backup gate (HARD): a box with no peer-backup enrolled loses
///      its data on replacement. We block, surfacing "set up backup, or accept
///      loss (wipe-now only)". The gate reads the box's `peerBackupStatus`.
///   2. The owner picks a disk DISPOSITION (keep / wipe-after-handoff / wipe-now).
///   3. We mint + sign a `ServerDecommissionOrder` (retiredStkPubHex = the box's
///      CURRENT STK from the directory) under the owner IRK behind the biometric,
///      then DEPOSIT it to `<controlApex>/api/server/<domain>/decommission`.
///   4. L3 — on 200 we retire the box instance LOCALLY (remove the pod) so a
///      rebooting encrypted zombie is never re-surfaced for unlock approval.
///
/// The biometric fires ONCE (in `signer`); the box STK is resolved from the
/// directory BEFORE the biometric so a lying relay can't get us to sign for a
/// box it controls (the directory is the canonical STK source, same trust model
/// as the unlock coordinator).
@Observable
@MainActor
public final class ReplaceServerViewModel {

    public enum Phase: Equatable, Sendable {
        /// Checking peer-backup enrollment before anything else.
        case checkingBackup
        /// Backup is enrolled → the owner picks a disposition + confirms.
        case ready
        /// No peer-backup enrolled → replacing loses data. Only `wipe-now`
        /// (accept-loss) may proceed from here.
        case backupGate
        case signing
        case posting
        /// Deposited + the instance retired locally. `disposition` echoes what
        /// was ordered so the completion copy can point at the create-server flow.
        case completed(ReplaceServerFlow.Disposition)
        case failed(String)
    }

    public private(set) var phase: Phase = .checkingBackup
    /// True once the backup pre-flight has run and found NO enrolled peer-backup.
    /// Drives the gate copy; `wipe-now` is the only disposition that may proceed.
    public private(set) var backupMissing = false

    private let mailbox: any SecretMailboxClient
    private let screens: any ScreensClient
    private let serverFqdn: String
    private let username: String
    private let signer: @MainActor (String) async throws -> Curve25519.Signing.PrivateKey
    private let now: () -> Int64
    private let randomNonce: () -> Data
    /// L3 — called on a successful deposit to retire the box instance locally.
    private let onRetired: @MainActor () -> Void

    public init(
        mailbox: any SecretMailboxClient,
        screens: any ScreensClient,
        serverFqdn: String,
        username: String,
        onRetired: @escaping @MainActor () -> Void,
        signer: (@MainActor (String) async throws -> Curve25519.Signing.PrivateKey)? = nil,
        now: @escaping () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) },
        randomNonce: @escaping () -> Data = { ReplaceServerFlow.random32() }
    ) {
        self.mailbox = mailbox
        self.screens = screens
        self.serverFqdn = serverFqdn
        self.username = username
        self.onRetired = onRetired
        self.now = now
        self.randomNonce = randomNonce
        self.signer = signer ?? { reason in try await Keystore.deriveIRK(reason: reason) }
    }

    /// Pre-flight: is peer-backup enrolled for this box? Conservatively, backup
    /// counts as enrolled ONLY when the box is participating AND at least one
    /// peer is actually holding its data (`peersBackingYouUp`). Anything we can't
    /// confirm gates HARD (treat as "no backup" — replacing would lose data).
    public func preflight() async {
        phase = .checkingBackup
        do {
            let status = try await screens.peerBackupStatus()
            let enrolled = status.participating && !status.peersBackingYouUp.isEmpty
            if enrolled {
                backupMissing = false
                phase = .ready
            } else {
                backupMissing = true
                phase = .backupGate
            }
        } catch {
            // TODO: the box BFF may not expose peerBackupStatus on every build /
            // un-rebuilt box (404 → "not set up"). We gate CONSERVATIVELY: an
            // unreadable backup signal blocks like "no backup", so a replacement
            // can never silently lose data on an unconfirmed box.
            backupMissing = true
            phase = .backupGate
        }
    }

    /// Mint + sign + deposit the decommission order, then L3-retire the box
    /// locally on success. `disposition` is the owner's pick. When backup is
    /// missing, only `wipe-now` may proceed (the caller enforces this in the UI,
    /// and we re-assert it here as a backstop).
    public func replace(disposition: ReplaceServerFlow.Disposition) async {
        if backupMissing && disposition != .wipeNow {
            phase = .failed("This server has no backup. Set up backup first, or choose “Wipe now” to replace it and accept the data loss.")
            return
        }

        // Resolve the box's CURRENT STK from the directory BEFORE the biometric.
        // The order's `retiredStkPubHex` is the load-bearing replay guard (I2);
        // it must name THIS instance. A box with no directory entry can't be
        // decommissioned (nothing to retire) — fail without prompting.
        let retiredStkPubHex: String
        do {
            let pods = try await mailbox.fetchPods(username: username)
            guard let stk = pods.identityPubKey(forServerDomain: serverFqdn) else {
                phase = .failed("Couldn't find this box in your account directory. Refresh and try again.")
                return
            }
            retiredStkPubHex = stk
        } catch {
            phase = .failed("Couldn't reach your account directory. Check your connection and try again.")
            return
        }

        phase = .signing
        let key: Curve25519.Signing.PrivateKey
        do {
            key = try await signer("Replace \(serverFqdn)")
        } catch {
            phase = .failed("Couldn't access your account key: \(error.localizedDescription)")
            return
        }

        // `keep` has no final flush; the wipe dispositions flush first when a
        // backup exists. With a missing backup (wipe-now accept-loss) there is
        // nothing to flush, so finalBackup is false there too.
        let finalBackup = disposition != .keep && !backupMissing

        let body: DecommissionDepositBody
        do {
            // Slice D — the decommission ORDER is SENSITIVE ⇒ sign with the admin
            // master root when this device holds one; the mailbox auth stays IRK.
            let orderKey = Keystore.hasAdminRoot
                ? try await Keystore.adminRootKey(reason: "Replace \(serverFqdn)")
                : nil
            body = try ReplaceServerFlow.buildDeposit(
                serverFqdn: serverFqdn,
                username: username,
                irk: key,
                orderKey: orderKey,
                retiredStkPubHex: retiredStkPubHex,
                finalBackup: finalBackup,
                disposition: disposition,
                issuedAt: now(),
                nonce: randomNonce(),
                authNonce: randomNonce()
            )
        } catch {
            phase = .failed("Couldn't sign the replacement order: \(error.localizedDescription)")
            return
        }

        phase = .posting
        do {
            try await mailbox.depositDecommission(serverDomain: serverFqdn, body: body)
        } catch let e as ScreensClientError {
            phase = .failed(e.errorDescription ?? "That didn't work. Try again in a moment.")
            return
        } catch {
            phase = .failed("Couldn't reach the server directory. Check your connection and try again.")
            return
        }

        // L3 — retire the instance locally so a rebooting encrypted zombie is
        // never re-surfaced for unlock approval.
        onRetired()
        phase = .completed(disposition)
    }
}
