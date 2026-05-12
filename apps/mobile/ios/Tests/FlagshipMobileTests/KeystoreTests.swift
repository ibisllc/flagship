import XCTest
import CryptoKit
@testable import Flagship

final class KeystoreTests: XCTestCase {

    override func setUp() async throws {
        // The simulator-path Keystore persists its wrap key + ciphertext
        // in the Keychain. Wipe before each test so we start clean and
        // the generate→unwrap round-trip is deterministic.
        Keystore.wipe()
    }

    override func tearDown() async throws {
        Keystore.wipe()
    }

    func test_hasWrappedUMK_isFalseBeforeGeneration() {
        XCTAssertFalse(Keystore.hasWrappedUMK)
    }

    func test_generateUMK_persistsAndDerivesStableKeys() async throws {
        try await Keystore.generateUMK(reason: "test")
        XCTAssertTrue(Keystore.hasWrappedUMK)

        // Derive the same Curve25519 BAK twice — the seed should be
        // stable, so the public keys must match.
        let bak1 = try await Keystore.deriveBAK(serverId: "home", reason: "test")
        let bak2 = try await Keystore.deriveBAK(serverId: "home", reason: "test")
        XCTAssertEqual(bak1.publicKey.rawRepresentation, bak2.publicKey.rawRepresentation)
    }

    func test_differentServerIdsYieldDifferentBAKs() async throws {
        try await Keystore.generateUMK(reason: "test")
        let home   = try await Keystore.deriveBAK(serverId: "home",   reason: "test")
        let office = try await Keystore.deriveBAK(serverId: "office", reason: "test")
        XCTAssertNotEqual(home.publicKey.rawRepresentation,
                          office.publicKey.rawRepresentation)
    }

    func test_SWK_isStableAcrossDerivations() async throws {
        try await Keystore.generateUMK(reason: "test")
        let s1 = try await Keystore.deriveSWK(serverId: "home", reason: "test")
        let s2 = try await Keystore.deriveSWK(serverId: "home", reason: "test")
        XCTAssertEqual(
            s1.withUnsafeBytes { Data($0) },
            s2.withUnsafeBytes { Data($0) }
        )
    }

    func test_wipe_clearsExistence() async throws {
        try await Keystore.generateUMK(reason: "test")
        XCTAssertTrue(Keystore.hasWrappedUMK)
        Keystore.wipe()
        XCTAssertFalse(Keystore.hasWrappedUMK)
    }

    func test_IRK_derivesEd25519PrivateKey() async throws {
        try await Keystore.generateUMK(reason: "test")
        let irk = try await Keystore.deriveIRK(reason: "test")
        // Sign + verify a known message — that's the operational
        // contract the BootApproval flow needs.
        let msg = Data("flagship/test/v1|hello".utf8)
        let sig = try irk.signature(for: msg)
        XCTAssertTrue(irk.publicKey.isValidSignature(sig, for: msg))
    }
}
