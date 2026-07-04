import XCTest
import CryptoKit
@testable import FlagshipAPI
@testable import FlagshipCore

/// Pins the Swift canonical bytes for the `server-migration` order + control
/// envelopes (docs/server-migration.md) to the EXACT cross-platform vectors in
/// `packages/protocol/tests/serverMigrationVectors.test.ts`. `.com` re-derives
/// these bytes to verify the admin signature, so any drift in the tag, `|`
/// separator, field order, the lowercasing, or the number stringification
/// would break the migration lane.
///
/// CryptoKit signing is randomized (not RFC8032-deterministic), so the pinned
/// TS signatures are asserted the VERIFY way: the pinned hex must validate
/// over the mirror-built bytes under the vector pubkey (seed 32×0x07).
final class ServerMigrationCanonicalTests: XCTestCase {
    private func str(_ d: Data) -> String { String(data: d, encoding: .utf8)! }

    /// seed = 32×0x07 → this Ed25519 pub (the TS `makeKey(7)` vector key).
    private let vectorPubHex =
        "ea4a6c63e29c520abef5507b132ec5f9954776aebebe7b92421eea691446d22c"

    private func vectorKey() -> Curve25519.Signing.PrivateKey {
        try! Curve25519.Signing.PrivateKey(rawRepresentation: Data(repeating: 7, count: 32))
    }

    // MARK: - Order vector

    private let orderCanonical =
        "flagship/server-migration/v1|home.alice.flagship.services|"
        + String(repeating: "aa", count: 32)
        + "|wipe-after-handoff|deadbeef|1700"

    /// RFC8032-deterministic signature over `orderCanonical` by the vector key
    /// (pinned in serverMigrationVectors — the TS `ed.sign` output).
    private let orderPinnedSigHex =
        "26ecec473730a5b84f043e3a25da1b41a27e07b65302701f327779d1fd119cb6"
        + "072fbc79d3bed9ed65f67113aaa6549f809a2e0b45b0abd1c7825895dc601f06"

    private func orderVector() -> ServerMigrationOrder {
        ServerMigrationOrder(
            serverDomain: "home.alice.flagship.services",
            oldStkPubHex: String(repeating: "aa", count: 32),
            diskDisposition: "wipe-after-handoff",
            nonce: "deadbeef",
            issuedAt: 1700
        )
    }

    func testVectorKeyMatchesPinnedPub() {
        XCTAssertEqual(
            HexUtil.encode(vectorKey().publicKey.rawRepresentation),
            vectorPubHex
        )
    }

    func testOrderCanonicalBytesMatchPinnedVector() {
        XCTAssertEqual(str(orderVector().canonicalBytes()), orderCanonical)
    }

    func testOrderPinnedTsSignatureVerifiesOverMirrorBuiltBytes() {
        let sig = Data(HexUtil.decode(orderPinnedSigHex)!)
        let pub = try! Curve25519.Signing.PublicKey(rawRepresentation: Data(HexUtil.decode(vectorPubHex)!))
        XCTAssertTrue(orderVector().verify(sig, with: pub))
    }

    func testOrderSignVerifyRoundTripWithFreshKey() throws {
        let key = Curve25519.Signing.PrivateKey()
        let o = orderVector()
        let sig = try o.sign(with: key)
        XCTAssertTrue(key.publicKey.isValidSignature(sig, for: Data(orderCanonical.utf8)))
        XCTAssertTrue(o.verify(sig, with: key.publicKey))
        XCTAssertFalse(o.verify(sig, with: Curve25519.Signing.PrivateKey().publicKey))
    }

    func testOrderLowercasesDomainStkAndNonce() {
        let o = ServerMigrationOrder(
            serverDomain: "HOME.Alice.Flagship.Services",
            oldStkPubHex: String(repeating: "AA", count: 32),
            diskDisposition: "wipe-after-handoff",
            nonce: "DEADBEEF",
            issuedAt: 1700
        )
        XCTAssertEqual(str(o.canonicalBytes()), orderCanonical)
    }

    func testOrderOldStkBindingIsInTheBytes() throws {
        let key = vectorKey()
        let sigA = try orderVector().sign(with: key)
        let other = ServerMigrationOrder(
            serverDomain: "home.alice.flagship.services",
            oldStkPubHex: String(repeating: "cc", count: 32),
            diskDisposition: "wipe-after-handoff",
            nonce: "deadbeef",
            issuedAt: 1700
        )
        XCTAssertFalse(other.verify(sigA, with: key.publicKey))
    }

    func testMigrationDispositionVocabularyExcludesWipeNow() {
        // Invariant 1 — a migration never authorizes wipe-now.
        XCTAssertEqual(
            ServerMigrationFlow.Disposition.allCases.map(\.rawValue).sorted(),
            ["keep", "wipe-after-handoff"]
        )
        XCTAssertNil(ServerMigrationFlow.Disposition(rawValue: "wipe-now"))
        XCTAssertEqual(ServerMigrationFlow.defaultDisposition, .wipeAfterHandoff)
    }

    // MARK: - Control vector

    private let controlCanonical =
        "flagship/server-migration-control/v1|home.alice.flagship.services|abort|0badcafe|1800"

    private let controlPinnedSigHex =
        "9387fc92a2f85b473655500099f591d2157e2e9da7caa6fc96d310cffc05bc91"
        + "0ecd4e3b20a218992686cc547bb233af0241925d6f19f7d64e95f4a055ec070e"

    private func controlVector() -> ServerMigrationControl {
        ServerMigrationControl(
            serverDomain: "home.alice.flagship.services",
            action: "abort",
            nonce: "0badcafe",
            issuedAt: 1800
        )
    }

    func testControlCanonicalBytesMatchPinnedVector() {
        XCTAssertEqual(str(controlVector().canonicalBytes()), controlCanonical)
    }

    func testControlPinnedTsSignatureVerifiesOverMirrorBuiltBytes() {
        let sig = Data(HexUtil.decode(controlPinnedSigHex)!)
        let pub = try! Curve25519.Signing.PublicKey(rawRepresentation: Data(HexUtil.decode(vectorPubHex)!))
        XCTAssertTrue(controlVector().verify(sig, with: pub))
    }

    func testControlLowercasesDomainAndNonce() {
        let c = ServerMigrationControl(
            serverDomain: "HOME.Alice.Flagship.Services",
            action: "abort",
            nonce: "0BADCAFE",
            issuedAt: 1800
        )
        XCTAssertEqual(str(c.canonicalBytes()), controlCanonical)
    }

    func testControlActionIsInTheBytes() throws {
        let key = vectorKey()
        let sig = try controlVector().sign(with: key)
        let confirm = ServerMigrationControl(
            serverDomain: "home.alice.flagship.services",
            action: "confirm-ready",
            nonce: "0badcafe",
            issuedAt: 1800
        )
        XCTAssertFalse(confirm.verify(sig, with: key.publicKey))
    }
}

/// The `ServerMigrationFlow` deposit builders produce the exact `.com` wire
/// bodies: admin-root order signature (orderKey ?? irk), IRK mailbox-auth, and
/// a freeze deposit that REUSES the existing ServerDecommission canonical
/// bytes with finalBackup forced on.
final class ServerMigrationFlowTests: XCTestCase {
    private let server = "home.alice.flagship.services"
    private let username = "alice"
    private let oldStk = String(repeating: "ab", count: 32)

    private func irk() -> Curve25519.Signing.PrivateKey {
        try! Curve25519.Signing.PrivateKey(rawRepresentation: Data(repeating: 9, count: 32))
    }
    private func adminRoot() -> Curve25519.Signing.PrivateKey {
        try! Curve25519.Signing.PrivateKey(rawRepresentation: Data(repeating: 5, count: 32))
    }

    func testStartDepositSignsOrderUnderAdminRootAndAuthUnderIrk() throws {
        let irk = irk()
        let admin = adminRoot()
        let body = try ServerMigrationFlow.buildStartDeposit(
            serverFqdn: server, username: username,
            irk: irk, orderKey: admin,
            oldStkPubHex: String(repeating: "AB", count: 32),
            disposition: .wipeAfterHandoff,
            issuedAt: 1700,
            nonce: Data(repeating: 7, count: 32),
            authNonce: Data(repeating: 8, count: 32)
        )
        XCTAssertEqual(body.order.serverDomain, server)
        XCTAssertEqual(body.order.oldStkPubHex, oldStk, "old STK is lowercased onto the wire")
        XCTAssertEqual(body.order.diskDisposition, "wipe-after-handoff")
        XCTAssertEqual(body.order.nonce.count, 64, "32-byte nonce hex")
        XCTAssertEqual(body.order.issuedAt, 1700)

        // The order signature verifies under the ADMIN root over the exact
        // canonical bytes `.com` re-derives — and NOT under the IRK.
        let order = ServerMigrationOrder(
            serverDomain: body.order.serverDomain,
            oldStkPubHex: body.order.oldStkPubHex,
            diskDisposition: body.order.diskDisposition,
            nonce: body.order.nonce,
            issuedAt: body.order.issuedAt
        )
        let sig = Data(HexUtil.decode(body.signature)!)
        XCTAssertTrue(order.verify(sig, with: admin.publicKey))
        XCTAssertFalse(order.verify(sig, with: irk.publicKey))

        // The mailbox auth stays the IRK deposit credential.
        XCTAssertEqual(body.auth.username, username)
        XCTAssertEqual(body.auth.phoneIrkPub, HexUtil.encode(irk.publicKey.rawRepresentation))
        let claim = DeviceEndpointClaim(
            username: body.auth.username,
            endpointLabel: body.auth.endpointLabel,
            phoneIrkPub: Data(HexUtil.decode(body.auth.phoneIrkPub)!),
            issuedAt: body.auth.issuedAt,
            expiresAt: body.auth.expiresAt,
            nonce: Data(HexUtil.decode(body.auth.nonce)!)
        )
        XCTAssertTrue(DeviceEndpointClaim.verify(
            claim,
            signature: Data(HexUtil.decode(body.authSignature)!),
            irkPub: irk.publicKey
        ))
    }

    func testStartDepositFallsBackToIrkWithoutAdminRoot() throws {
        let irk = irk()
        let body = try ServerMigrationFlow.buildStartDeposit(
            serverFqdn: server, username: username,
            irk: irk, orderKey: nil,
            oldStkPubHex: oldStk, disposition: .keep,
            issuedAt: 1700,
            nonce: Data(repeating: 7, count: 32),
            authNonce: Data(repeating: 8, count: 32)
        )
        let order = ServerMigrationOrder(
            serverDomain: body.order.serverDomain,
            oldStkPubHex: body.order.oldStkPubHex,
            diskDisposition: body.order.diskDisposition,
            nonce: body.order.nonce,
            issuedAt: body.order.issuedAt
        )
        XCTAssertTrue(order.verify(Data(HexUtil.decode(body.signature)!), with: irk.publicKey))
    }

    func testControlDepositCarriesActionAndVerifies() throws {
        let irk = irk()
        let admin = adminRoot()
        let body = try ServerMigrationFlow.buildControlDeposit(
            action: "confirm-ready",
            serverFqdn: server, username: username,
            irk: irk, orderKey: admin,
            issuedAt: 1800,
            nonce: Data(repeating: 3, count: 32),
            authNonce: Data(repeating: 4, count: 32)
        )
        XCTAssertEqual(body.control.action, "confirm-ready")
        let control = ServerMigrationControl(
            serverDomain: body.control.serverDomain,
            action: body.control.action,
            nonce: body.control.nonce,
            issuedAt: body.control.issuedAt
        )
        XCTAssertTrue(control.verify(Data(HexUtil.decode(body.signature)!), with: admin.publicKey))
    }

    func testFreezeDepositReusesDecommissionCanonicalWithFinalBackupForced() throws {
        let irk = irk()
        let body = try ServerMigrationFlow.buildFreezeDeposit(
            serverFqdn: server, username: username,
            irk: irk, orderKey: nil,
            oldStkPubHex: String(repeating: "AB", count: 32),
            disposition: "wipe-after-handoff",
            issuedAt: 1700,
            nonce: Data(repeating: 7, count: 32),
            authNonce: Data(repeating: 8, count: 32)
        )
        // The freeze handler's session constraints, satisfied by construction:
        // targets the old instance, finalBackup === true, disposition matches.
        XCTAssertEqual(body.order.retiredStkPubHex, oldStk)
        XCTAssertTrue(body.order.finalBackup, "the final delta IS the point of the freeze")
        XCTAssertEqual(body.order.diskDisposition, "wipe-after-handoff")

        // The signature is the EXISTING ServerDecommissionOrder canonical —
        // no migration-specific re-implementation.
        let order = ServerDecommissionOrder(
            podCanonical: body.order.podCanonical,
            retiredStkPubHex: body.order.retiredStkPubHex,
            finalBackup: body.order.finalBackup,
            diskDisposition: body.order.diskDisposition,
            backupEpoch: body.order.backupEpoch,
            nonce: body.order.nonce,
            issuedAt: body.order.issuedAt
        )
        XCTAssertTrue(order.verify(Data(HexUtil.decode(body.signature)!), with: irk.publicKey))
    }

    func testFreezeDepositRejectsWipeNowAndJunkDispositions() {
        for bad in ["wipe-now", "nuke", ""] {
            XCTAssertThrowsError(try ServerMigrationFlow.buildFreezeDeposit(
                serverFqdn: server, username: username,
                irk: irk(), orderKey: nil,
                oldStkPubHex: oldStk, disposition: bad,
                issuedAt: 1700,
                nonce: Data(repeating: 7, count: 32),
                authNonce: Data(repeating: 8, count: 32)
            ), "disposition \(bad) must be rejected")
        }
    }
}

/// The 8-step timeline + waiting-copy mapping (mirror of the webapp's
/// `migrationSteps` / `migrationWaitCopy`).
final class ServerMigrationTimelineTests: XCTestCase {
    private func session(
        phase: String,
        initiatedAt: Int64? = 1, attachedAt: Int64? = nil, preSeededAt: Int64? = nil,
        readyAt: Int64? = nil, freezeAt: Int64? = nil, finalDeltaAt: Int64? = nil,
        takenOverAt: Int64? = nil, abortedAt: Int64? = nil, oldClosedOutAt: Int64? = nil,
        done: Bool = false
    ) -> MigrationSession {
        MigrationSession(
            serverDomain: "home.alice.flagship.services", phase: phase,
            disposition: "wipe-after-handoff", oldStkPubHex: String(repeating: "ab", count: 32),
            initiatedAt: initiatedAt, attachedAt: attachedAt, preSeededAt: preSeededAt,
            readyAt: readyAt, freezeAt: freezeAt, finalDeltaAt: finalDeltaAt,
            takenOverAt: takenOverAt, abortedAt: abortedAt, oldClosedOutAt: oldClosedOutAt,
            done: done
        )
    }

    func testStepsMarkDoneActivePendingInOrder() {
        let steps = ServerMigrationTimeline.steps(for: session(phase: "provisioned", attachedAt: 2))
        XCTAssertEqual(steps.count, 8)
        XCTAssertEqual(steps[0].state, .done)      // initiate
        XCTAssertEqual(steps[1].state, .done)      // provision
        XCTAssertEqual(steps[2].state, .active)    // pre-seed — the ONE active step
        XCTAssertTrue(steps[3...].allSatisfy { $0.state == .pending })
    }

    func testAbortedSessionHasNoActiveStep() {
        let steps = ServerMigrationTimeline.steps(for: session(phase: "aborted", abortedAt: 9))
        XCTAssertFalse(steps.contains { $0.state == .active })
    }

    func testWaitCopyHonestPerPhase() {
        XCTAssertTrue(ServerMigrationTimeline.waitCopy(for: session(phase: "initiated"), nowMs: 10)
            .contains("Waiting for the new box"))
        XCTAssertTrue(ServerMigrationTimeline.waitCopy(for: session(phase: "pre-seeded", attachedAt: 2, preSeededAt: 3), nowMs: 10)
            .contains("Confirm the hand-off"))
        XCTAssertTrue(ServerMigrationTimeline.waitCopy(for: session(phase: "aborted", abortedAt: 9), nowMs: 10)
            .contains("old server stays active"))
        XCTAssertTrue(ServerMigrationTimeline.waitCopy(for: session(phase: "taken-over", takenOverAt: 8, done: true), nowMs: 10)
            .contains("Migration complete"))
    }

    func testStuckPreSeedHintAfterTenMinutes() {
        let s = session(phase: "provisioned", attachedAt: 1_000)
        let fresh = ServerMigrationTimeline.waitCopy(for: s, nowMs: 1_000 + 60_000)
        XCTAssertFalse(fresh.contains("enable backup first"))
        let stuck = ServerMigrationTimeline.waitCopy(
            for: s, nowMs: 1_000 + ServerMigrationTimeline.preSeedStuckMs + 1
        )
        XCTAssertTrue(stuck.contains("enable backup first"))
    }

    func testFreezingCopyFlipsOnFinalDelta() {
        let flushing = session(phase: "freezing", freezeAt: 5)
        XCTAssertTrue(ServerMigrationTimeline.waitCopy(for: flushing, nowMs: 10).contains("flushing"))
        let flushed = session(phase: "freezing", freezeAt: 5, finalDeltaAt: 6)
        XCTAssertTrue(ServerMigrationTimeline.waitCopy(for: flushed, nowMs: 10).contains("claiming the name"))
    }
}
