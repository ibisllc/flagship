import XCTest
import CryptoKit
import FlagshipAPI
@testable import FlagshipCore

/// SEC-LOCK-001 on the phone: the canonical bytes are the shared vectors', and
/// lock/resume behave against a worker that follows the same rules.
final class BootSuspensionTests: XCTestCase {
    private func vectors() throws -> [String: Any] {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<14 {
            let url = dir.appendingPathComponent("packages/protocol/test-vectors/boot-suspension/vectors.json")
            if FileManager.default.fileExists(atPath: url.path) {
                return try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
            }
            dir = dir.deletingLastPathComponent()
        }
        throw XCTSkip("vectors.json not found above \(#filePath)")
    }

    private func order(_ o: [String: Any]) -> BootSuspensionOrder {
        BootSuspensionOrder(
            serverDomain: o["serverDomain"] as! String,
            epoch: (o["epoch"] as! NSNumber).int64Value,
            seq: (o["seq"] as! NSNumber).int64Value,
            action: BootSuspensionOrder.Action(rawValue: o["action"] as! String)!,
            reason: o["reason"] as! String,
            signer: o["signer"] as! String,
            issuedAt: (o["issuedAt"] as! NSNumber).int64Value
        )
    }

    func testEveryStepHasTheSharedCanonicalBytesAndItsSignatureVerifies() throws {
        let v = try vectors()
        let steps = try XCTUnwrap(v["steps"] as? [[String: Any]])
        XCTAssertFalse(steps.isEmpty)
        let ownerPub = try Curve25519.Signing.PublicKey(rawRepresentation: XCTUnwrap(HexUtil.decode(v["ownerPubHex"] as! String)))
        let boxPub = try Curve25519.Signing.PublicKey(rawRepresentation: XCTUnwrap(HexUtil.decode(v["boxPubHex"] as! String)))
        for s in steps {
            let o = order(s["order"] as! [String: Any])
            let canonical = try o.canonicalBytes()
            XCTAssertEqual(String(decoding: canonical, as: UTF8.self), s["canonical"] as? String, s["name"] as? String ?? "")
            let sig = try XCTUnwrap(HexUtil.decode(s["signatureHex"] as! String))
            let (right, wrong) = o.signer == "owner" ? (ownerPub, boxPub) : (boxPub, ownerPub)
            XCTAssertTrue(right.isValidSignature(sig, for: canonical), s["name"] as? String ?? "")
            XCTAssertFalse(wrong.isValidSignature(sig, for: canonical))
        }
    }

    func testFieldsThatWouldBreakTheFormAreRefused() {
        let ok = BootSuspensionOrder(serverDomain: "a.b", epoch: 1, action: .suspend, reason: "manual-lock", issuedAt: 1)
        XCTAssertNoThrow(try ok.canonicalBytes())
        XCTAssertThrowsError(try BootSuspensionOrder(serverDomain: "a|b", epoch: 1, action: .suspend, reason: "x", issuedAt: 1).canonicalBytes())
        XCTAssertThrowsError(try BootSuspensionOrder(serverDomain: "a.b", epoch: -1, action: .suspend, reason: "x", issuedAt: 1).canonicalBytes())
        XCTAssertThrowsError(try BootSuspensionOrder(serverDomain: "a.b", epoch: 1, action: .suspend, reason: "x\ny", issuedAt: 1).canonicalBytes())
        XCTAssertThrowsError(try BootSuspensionOrder(serverDomain: "a.b", epoch: 1, action: .suspend, reason: "x", signer: "root", issuedAt: 1).canonicalBytes())
    }

    // MARK: - against a worker that follows the rules

    /// A worker in memory: the owner always starts epoch + 1; a stale epoch is a 409.
    final class FakeWorker: SecretMailboxClient, @unchecked Sendable {
        var state = BootSuspensionStateWire(serverDomain: "home.alice.flagship.services", suspended: false, epoch: 0, seq: 0)
        var leases = 2
        var down = false
        var failWrites = false
        var puts: [BootSuspensionOrderWire] = []
        var revokedAll = 0
        func fetchPendingRequests(auth: MailboxAuthEnvelope) async throws -> SecretRequestsResponse { throw ScreensClientError.notImplemented("x") }
        func postResponse(response: SecretResponseBody, bootAuth: String) async throws {}
        func fetchSealedLuksKey(serverDomain: String) async throws -> SealedLuksKeyResponse { throw ScreensClientError.notImplemented("x") }
        func fetchPods(username: String) async throws -> PodsDirectoryResponse { throw ScreensClientError.notImplemented("x") }
        func fetchLiveSync(username: String, cursor: String?) async throws -> LiveSyncResponse { throw ScreensClientError.notImplemented("x") }
        func depositBoxSealedLease(lease: BoxSealedLeaseWire, signatureHex: String, bootAuth: String) async throws {}
        func revokeBoxSealedLease(request: LeaseRevokeWire, bootAuth: String) async throws {}
        func depositPairing(serverDomain: String, body: PairingDepositBody) async throws {}
        func depositEntitlement(serverDomain: String, body: PairingDepositBody) async throws {}
        func depositDecommission(serverDomain: String, body: DecommissionDepositBody) async throws {}
        func depositSwk(serverDomain: String, body: PairingDepositBody) async throws {}
        func depositCgk(serverDomain: String, body: PairingDepositBody) async throws {}
        func postServerOrder(username: String, body: SignedServerOrderWire) async throws {}
        func depositUpdate(serverDomain: String, body: UpdateDepositBody) async throws {}

        /// Runs once, between the phone's read and its write: the record moves on.
        var beforeFirstPut: (() -> Void)?

        func readBootSuspension(serverDomain: String, bootAuth: String) async throws -> BootSuspensionStateWire {
            if down { throw URLError(.notConnectedToInternet) }
            XCTAssertTrue(bootAuth.hasPrefix("Flagship-Boot-v1 "))
            return state
        }
        func putBootSuspension(order: BootSuspensionOrderWire, signatureHex: String, bootAuth: String) async throws -> BootSuspensionPutResult {
            if down { throw URLError(.notConnectedToInternet) }
            puts.append(order)
            if let hook = beforeFirstPut { beforeFirstPut = nil; hook() }
            if failWrites { return BootSuspensionPutResult(durable: false, refusal: "not-durable", status: 503) }
            guard order.epoch == state.epoch + 1 else { return BootSuspensionPutResult(durable: false, state: state, refusal: "stale-epoch", status: 409) }
            let revoked = order.action == "suspend" ? leases : 0
            if order.action == "suspend" { leases = 0 }
            state = BootSuspensionStateWire(serverDomain: order.serverDomain, suspended: order.action == "suspend", epoch: order.epoch, seq: 0, reason: order.reason, signer: "owner")
            return BootSuspensionPutResult(durable: true, leasesRevoked: revoked, state: state)
        }
        func revokeAllBoxSealedLeases(serverDomain: String, bootAuth: String) async throws { revokedAll += 1; leases = 0 }
    }

    private let S = "home.alice.flagship.services"
    private func irk() -> Curve25519.Signing.PrivateKey { Curve25519.Signing.PrivateKey() }

    func testLockIsDurableRevokesLeasesAndSignsTheNextEpoch() async throws {
        let w = FakeWorker()
        let key = irk()
        let r = await BootLock(client: w).setOwner(serverDomain: S, action: .suspend, irk: key)
        XCTAssertEqual(r, .confirmed(leasesRevoked: 2, alreadyInState: false))
        XCTAssertEqual(w.puts.map(\.epoch), [1])
        XCTAssertEqual(w.state.suspended, true)
        // locking a locked server is a no-op, not a second epoch
        let again = await BootLock(client: w).setOwner(serverDomain: S, action: .suspend, irk: key)
        XCTAssertEqual(again, .confirmed(leasesRevoked: 0, alreadyInState: true))
        XCTAssertEqual(w.puts.count, 1)
        // resume starts epoch 2 and leaves no lease behind
        let back = await BootLock(client: w).setOwner(serverDomain: S, action: .resume, irk: key)
        XCTAssertEqual(back, .confirmed(leasesRevoked: 0, alreadyInState: false))
        XCTAssertEqual(w.puts.map(\.epoch), [1, 2])
        XCTAssertEqual(w.leases, 0)
    }

    func testAnUnreachableOrNonDurableWorkerIsNeverReportedAsLocked() async throws {
        let down = FakeWorker(); down.down = true
        let r1 = await BootLock(client: down).setOwner(serverDomain: S, action: .suspend, irk: irk())
        XCTAssertEqual(r1, .pending(why: "unreachable"))
        let broken = FakeWorker(); broken.failWrites = true
        let r2 = await BootLock(client: broken).setOwner(serverDomain: S, action: .suspend, irk: irk())
        XCTAssertEqual(r2, .pending(why: "not-durable"))
        XCTAssertEqual(broken.state.suspended, false)
    }

    func testRetriesOnAMovedEpoch() async throws {
        let w = FakeWorker()
        // The record moves on after the phone read it (epoch 0) and before its write (epoch 1).
        w.beforeFirstPut = { w.state = BootSuspensionStateWire(serverDomain: self.S, suspended: false, epoch: 1, seq: 0) }
        let r = await BootLock(client: w).setOwner(serverDomain: S, action: .suspend, irk: irk())
        XCTAssertEqual(r, .confirmed(leasesRevoked: 2, alreadyInState: false))
        XCTAssertEqual(w.puts.map(\.epoch), [1, 2])
        XCTAssertEqual(w.state.epoch, 2)
    }

    func testDeadManBoundsALease() {
        XCTAssertEqual(DeadManLeaseBound.expiry(requested: 1_000, enabled: false, deadline: nil, now: 10), 1_000)
        XCTAssertEqual(DeadManLeaseBound.expiry(requested: 1_000, enabled: true, deadline: 500, now: 10), 500)
        XCTAssertEqual(DeadManLeaseBound.expiry(requested: 300, enabled: true, deadline: 500, now: 10), 300)
        XCTAssertNil(DeadManLeaseBound.expiry(requested: 1_000, enabled: true, deadline: 5, now: 10))
        XCTAssertNil(DeadManLeaseBound.expiry(requested: 1_000, enabled: true, deadline: nil, now: 10))
    }

    func testPendingLocksAreRememberedAndCleared() {
        let d = UserDefaults(suiteName: "bootlock-\(UUID().uuidString)")!
        let s = BootLockStateStore(defaults: d)
        XCTAssertEqual(s.pending(), [])
        s.markPending("Home.Alice.flagship.services"); s.markPending("home.alice.flagship.services")
        XCTAssertEqual(s.pending(), ["home.alice.flagship.services"])
        s.clearPending("HOME.alice.flagship.services")
        XCTAssertEqual(s.pending(), [])
        XCTAssertNil(s.lastKnownSuspended(S))
        s.setLastKnown(true, for: S)
        XCTAssertEqual(s.lastKnownSuspended(S), true)
    }

    func testTheWordsNeverOverclaim() {
        XCTAssertTrue(LockWords.describe(lock: .pending(why: "unreachable"), powerSent: true, mode: .off).contains("remote lock pending"))
        XCTAssertFalse(LockWords.describe(lock: .pending(why: "x"), powerSent: true, mode: .off).contains("can't unlock itself"))
        XCTAssertTrue(LockWords.describe(lock: .confirmed(leasesRevoked: 1, alreadyInState: false), powerSent: false, mode: .off).contains("didn't reach"))
        XCTAssertTrue(LockWords.describe(lock: .confirmed(leasesRevoked: 0, alreadyInState: false), powerSent: true, mode: .restart, executed: .off).contains("shut down instead"))
    }
}
