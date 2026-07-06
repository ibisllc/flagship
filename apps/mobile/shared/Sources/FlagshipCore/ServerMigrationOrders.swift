import Foundation
import CryptoKit
import FlagshipAPI

/// Server-migration order — the Swift mirror of the `server-migration`
/// envelope in `packages/protocol/src/serverMigration.ts`
/// (docs/server-migration.md). Same owner, same `<server>.<user>` name, NEW
/// hardware.
///
/// The admin-signed "migrate this server" authorization (phase 1). SENSITIVE:
/// it ultimately retires + wipes a box and re-homes routing, so it signs under
/// the Slice-D admin master root (legacy owner-IRK when no admin root).
///
/// - `oldStkPubHex` binds the order to the CURRENT live instance, so a
///   replayed order can never re-migrate a later tenant of the same name.
/// - `diskDisposition` ∈ {"keep","wipe-after-handoff"} — a migration NEVER
///   authorizes `wipe-now` (invariant 1: the old box is wiped only after the
///   new box confirms take-over).
///
/// Canonical bytes (byte-identical to TS + the webapp mirror, pinned by
/// `packages/protocol/tests/serverMigrationVectors.test.ts`):
///
///   flagship/server-migration/v1|<serverDomain lc>|<oldStkPubHex lc>|<diskDisposition>|<nonce lc>|<issuedAt>
public struct ServerMigrationOrder: Equatable, Sendable {
    public static let canonicalTag = "flagship/server-migration/v1"

    public let serverDomain: String
    public let oldStkPubHex: String
    /// One of "keep" | "wipe-after-handoff".
    public let diskDisposition: String
    public let nonce: String
    public let issuedAt: Int64

    public init(
        serverDomain: String,
        oldStkPubHex: String,
        diskDisposition: String,
        nonce: String,
        issuedAt: Int64
    ) {
        self.serverDomain = serverDomain
        self.oldStkPubHex = oldStkPubHex
        self.diskDisposition = diskDisposition
        self.nonce = nonce
        self.issuedAt = issuedAt
    }

    public func canonicalBytes() -> Data {
        Data(
            [
                Self.canonicalTag,
                serverDomain.lowercased(),
                oldStkPubHex.lowercased(),
                diskDisposition,
                nonce.lowercased(),
                String(issuedAt),
            ].joined(separator: "|").utf8
        )
    }

    public func sign(with authority: Curve25519.Signing.PrivateKey) throws -> Data {
        try authority.signature(for: canonicalBytes())
    }

    public func verify(_ signature: Data, with authorityPub: Curve25519.Signing.PublicKey) -> Bool {
        authorityPub.isValidSignature(signature, for: canonicalBytes())
    }
}

/// The admin-signed phase-4/abort control (`confirm-ready` | `abort`) — same
/// authority as the order; its own nonce so each control action is a distinct
/// signature. Canonical bytes:
///
///   flagship/server-migration-control/v1|<serverDomain lc>|<action>|<nonce lc>|<issuedAt>
public struct ServerMigrationControl: Equatable, Sendable {
    public static let canonicalTag = "flagship/server-migration-control/v1"

    public let serverDomain: String
    /// One of "confirm-ready" | "abort".
    public let action: String
    public let nonce: String
    public let issuedAt: Int64

    public init(serverDomain: String, action: String, nonce: String, issuedAt: Int64) {
        self.serverDomain = serverDomain
        self.action = action
        self.nonce = nonce
        self.issuedAt = issuedAt
    }

    public func canonicalBytes() -> Data {
        Data(
            [
                Self.canonicalTag,
                serverDomain.lowercased(),
                action,
                nonce.lowercased(),
                String(issuedAt),
            ].joined(separator: "|").utf8
        )
    }

    public func sign(with authority: Curve25519.Signing.PrivateKey) throws -> Data {
        try authority.signature(for: canonicalBytes())
    }

    public func verify(_ signature: Data, with authorityPub: Curve25519.Signing.PublicKey) -> Bool {
        authorityPub.isValidSignature(signature, for: canonicalBytes())
    }
}

/// Pure (testable) builders for the "Migrate to new hardware" flow — the exact
/// wire bodies the `.com` migration lane accepts, mirroring the webapp's
/// `lib/serverMigration.js`. Split like `ReplaceServerFlow` so the
/// crypto/canonical-bytes is `swift test`-able without the UIKit-bound VM.
public enum ServerMigrationFlow {

    /// Migration disk dispositions — deliberately EXCLUDES `wipe-now`
    /// (invariant 1). MUST match @flagship/protocol `MigrationDisposition`.
    public enum Disposition: String, Sendable, Equatable, CaseIterable {
        case keep
        case wipeAfterHandoff = "wipe-after-handoff"
    }

    public static let defaultDisposition: Disposition = .wipeAfterHandoff

    /// Mint + sign the ServerMigrationOrder and wrap it with the IRK
    /// mailbox-auth into the initiate deposit body. The ORDER signs with the
    /// admin master root (`orderKey`) when supplied, else the IRK (legacy);
    /// the mailbox AUTH stays IRK-signed (the owner deposit credential).
    public static func buildStartDeposit(
        serverFqdn: String,
        username: String,
        irk: Curve25519.Signing.PrivateKey,
        orderKey: Curve25519.Signing.PrivateKey? = nil,
        oldStkPubHex: String,
        disposition: Disposition,
        issuedAt: Int64,
        nonce: Data,
        authNonce: Data
    ) throws -> MigrationStartBody {
        let order = ServerMigrationOrder(
            serverDomain: serverFqdn,
            oldStkPubHex: oldStkPubHex.lowercased(),
            diskDisposition: disposition.rawValue,
            nonce: HexUtil.encode(nonce),
            issuedAt: issuedAt
        )
        let sig = try order.sign(with: orderKey ?? irk)
        let auth = try ServerTransferFlow.buildMailboxAuth(
            username: username, irk: irk, issuedAt: issuedAt, nonce: authNonce
        )
        return MigrationStartBody(
            auth: auth.auth,
            authSignature: auth.authSignature,
            order: .init(
                serverDomain: order.serverDomain,
                oldStkPubHex: order.oldStkPubHex,
                diskDisposition: order.diskDisposition,
                nonce: order.nonce,
                issuedAt: order.issuedAt
            ),
            signature: HexUtil.encode(sig)
        )
    }

    /// Mint + sign a confirm-ready / abort control deposit.
    public static func buildControlDeposit(
        action: String,
        serverFqdn: String,
        username: String,
        irk: Curve25519.Signing.PrivateKey,
        orderKey: Curve25519.Signing.PrivateKey? = nil,
        issuedAt: Int64,
        nonce: Data,
        authNonce: Data
    ) throws -> MigrationControlBody {
        let control = ServerMigrationControl(
            serverDomain: serverFqdn,
            action: action,
            nonce: HexUtil.encode(nonce),
            issuedAt: issuedAt
        )
        let sig = try control.sign(with: orderKey ?? irk)
        let auth = try ServerTransferFlow.buildMailboxAuth(
            username: username, irk: irk, issuedAt: issuedAt, nonce: authNonce
        )
        return MigrationControlBody(
            auth: auth.auth,
            authSignature: auth.authSignature,
            control: .init(
                serverDomain: control.serverDomain,
                action: control.action,
                nonce: control.nonce,
                issuedAt: control.issuedAt
            ),
            signature: HexUtil.encode(sig)
        )
    }

    public enum FreezeError: Error, Equatable {
        case invalidDisposition(String)
    }

    /// Phase 5 — freeze: EXACTLY the graceful-decommission deposit (reuses
    /// `ReplaceServerFlow.buildDeposit` — the canonical bytes are the existing
    /// `ServerDecommissionOrder`, never re-implemented). The order targets the
    /// session's OLD instance, ALWAYS carries a final backup (the final delta
    /// the new box restores before take-over — the freeze handler rejects a
    /// no-final-backup order), and must match the migration order's disposition.
    public static func buildFreezeDeposit(
        serverFqdn: String,
        username: String,
        irk: Curve25519.Signing.PrivateKey,
        orderKey: Curve25519.Signing.PrivateKey? = nil,
        oldStkPubHex: String,
        disposition: String,
        issuedAt: Int64,
        nonce: Data,
        authNonce: Data
    ) throws -> DecommissionDepositBody {
        guard let d = ReplaceServerFlow.Disposition(rawValue: disposition),
              d != .wipeNow
        else { throw FreezeError.invalidDisposition(disposition) }
        return try ReplaceServerFlow.buildDeposit(
            serverFqdn: serverFqdn,
            username: username,
            irk: irk,
            orderKey: orderKey,
            retiredStkPubHex: oldStkPubHex.lowercased(),
            finalBackup: true,
            disposition: d,
            issuedAt: issuedAt,
            nonce: nonce,
            authNonce: authNonce
        )
    }

    /// A fresh 32-byte random nonce.
    public static func random32() -> Data { ServerTransferFlow.random32() }
}

/// The spec's 8-step timeline + honest waiting copy, mapped from the GET body —
/// the Swift mirror of the webapp's `migrationSteps` / `migrationWaitCopy`.
public enum ServerMigrationTimeline {

    public enum StepState: Equatable, Sendable { case done, active, pending }

    public struct Step: Equatable, Sendable, Identifiable {
        public let key: String
        public let label: String
        public let at: Int64?
        public let state: StepState
        public var id: String { key }
    }

    /// Session phases in which the migration is live (mirror of the `.com` set).
    public static let activePhases: Set<String> = [
        "initiated", "provisioned", "pre-seeded", "ready", "freezing",
    ]

    /// How long an attached-but-not-pre-seeded session waits before we surface
    /// the "is backup enabled?" hint (the GET carries no manifest signal).
    public static let preSeedStuckMs: Int64 = 10 * 60_000

    /// Aborted sessions mark every un-stamped step pending (no "active" spinner
    /// on a dead machine).
    public static func steps(for s: MigrationSession) -> [Step] {
        let aborted = s.abortedAt != nil
        let rows: [(String, String, Int64?)] = [
            ("initiate", "Migration authorized", s.initiatedAt),
            ("provision", "New box online + attached", s.attachedAt),
            ("pre-seed", "Data restored to the new box", s.preSeededAt),
            ("ready", "Confirmed ready to take over", s.readyAt),
            ("freeze", "Old server frozen — final backup", s.freezeAt),
            ("final-delta", "Final backup flushed", s.finalDeltaAt),
            ("take-over", "New box took over the name", s.takenOverAt),
            ("close-out", "Old box closed out", s.oldClosedOutAt),
        ]
        var activeSeen = false
        return rows.map { key, label, at in
            let state: StepState
            if at != nil {
                state = .done
            } else if aborted || activeSeen {
                state = .pending
            } else {
                state = .active
                activeSeen = true
            }
            return Step(key: key, label: label, at: at, state: state)
        }
    }

    /// Honest waiting copy for the CURRENT wait, plus the stuck-pre-seed hint.
    public static func waitCopy(for s: MigrationSession, nowMs: Int64) -> String {
        if s.abortedAt != nil {
            return "Migration aborted — your old server stays active with all its data."
        }
        if s.done { return "Migration complete — the server now runs on the new box." }
        switch s.phase {
        case "initiated":
            return "Waiting for the new box to come online. Apply the recipe on the new hardware; it will attach itself here."
        case "provisioned":
            if let attachedAt = s.attachedAt, nowMs - attachedAt > preSeedStuckMs {
                return "The new box attached but hasn't restored any data yet. If this server has no backup enabled, enable backup first — the migration restores from it."
            }
            return "New box attached — restoring this server's data from backup. The old server keeps serving meanwhile."
        case "pre-seeded":
            return "Data restored. Confirm the hand-off when you're ready — the old server will briefly freeze writes while the name moves."
        case "ready":
            return "Ready — freeze the old server to flush the final backup and hand the name over."
        case "freezing":
            return s.finalDeltaAt == nil
                ? "Old server is frozen and flushing its final backup…"
                : "Final backup flushed — the new box is applying it and claiming the name…"
        case "taken-over":
            return "The new box is serving the name. Waiting for the old box to close out."
        default:
            return ""
        }
    }
}
