import XCTest
import LocalAuthentication
import CryptoKit
@testable import Flagship
@testable import FlagshipCore

/// The iPhone's identity ML-DSA keys (architecture v2): made without a prompt, sealed to the
/// Secure Enclave wrapping key, usable only while the session holds its keys, never bound for a
/// classically recovered root.
final class PqKeyStoreTests: XCTestCase {
    override func setUp() async throws {
        Keystore.setActiveProfile(nil)
        Keystore.wipe()
        Keystore.clearSessionKeyCache()
        try await Keystore.generateUMK(reason: "test")
    }

    override func tearDown() async throws {
        Keystore.clearSessionKeyCache()
        Keystore.setActiveProfile(nil)
        Keystore.wipe()
    }

    func testMakesAWrappedKeyWithoutAPromptAndItBinds() async throws {
        let store = PqKeyStore()
        let irk = PqIdentity(role: .accountIrk, subjectId: "alice", edKey: .init())
        let k1 = await store.key(for: irk)
        let held = try XCTUnwrap(k1)
        XCTAssertEqual(held.custody, .hardwareWrapped)
        XCTAssertEqual(held.custody.label, "PQ, hardware-wrapped")
        let wire = try PqIdentityBinder.sign(irk, held, issuedAt: 1_790_000_000_000)
        XCTAssertEqual(wire.mldsaPubHex, held.mldsaPubHex)
        // The same key comes back for the same identity.
        let k2 = await store.key(for: irk)
        let again = try XCTUnwrap(k2)
        XCTAssertEqual(again.mldsaPubHex, held.mldsaPubHex)
    }

    func testASealedSeedNeedsTheSessionAndOtherwiseDefers() async throws {
        let irk = PqIdentity(role: .accountIrk, subjectId: "alice", edKey: .init())
        let k3 = await PqKeyStore().key(for: irk)
        let made = try XCTUnwrap(k3)
        Keystore.clearSessionKeyCache()
        let fresh = PqKeyStore()
        let locked = await fresh.key(for: irk)
        XCTAssertNil(locked, "no unlocked session: defer, never prompt")
        Keystore.cacheSessionUMK(authenticatedBy: LAContext())
        let k4 = await fresh.key(for: irk)
        let reopened = try XCTUnwrap(k4)
        XCTAssertEqual(reopened.mldsaPubHex, made.mldsaPubHex)
        _ = try PqIdentityBinder.sign(irk, reopened, issuedAt: 1)
    }

    func testRecoveredRootsAreNeverBoundFromThisDevice() {
        let store = PqKeyStore()
        let irk = PqIdentity(role: .accountIrk, subjectId: "bob", edKey: .init())
        let admin = PqIdentity(role: .adminRoot, subjectId: "bob", edKey: .init())
        let device = PqIdentity(role: .device, subjectId: String(repeating: "cd", count: 16), edKey: .init())
        store.markRecovered(username: "bob")
        XCTAssertEqual(store.withoutRecoveredRoots([irk, admin, device], username: "bob").map(\.role), [.device])
        // Later unlocks still skip those keys; a rotated IRK (a new key) binds.
        XCTAssertEqual(store.withoutRecoveredRoots([irk], username: "bob").count, 0)
        let rotated = PqIdentity(role: .accountIrk, subjectId: "bob", edKey: .init())
        XCTAssertEqual(store.withoutRecoveredRoots([rotated], username: "bob").count, 1)
        UserDefaults.standard.removeObject(forKey: "flagship.pq.recoveredKeys.bob")
    }

    func testBoundElsewhereDiscardsTheKey() async throws {
        let store = PqKeyStore()
        let irk = PqIdentity(role: .accountIrk, subjectId: "alice", edKey: .init())
        let k5 = await store.key(for: irk)
        _ = try XCTUnwrap(k5)
        store.discard(irk)
        store.setStatus(.boundElsewhere, for: irk)
        XCTAssertEqual(store.status(for: irk), .boundElsewhere, "remembered after the key is gone")
        XCTAssertEqual(PqKeyStore().status(for: irk), .boundElsewhere)
    }
}
