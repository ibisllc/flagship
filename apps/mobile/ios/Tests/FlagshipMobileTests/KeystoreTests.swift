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

/// Per-profile keystore keying — each cloud profile holds its OWN device
/// key. The active-profile pointer routes UMK / IRK derivation to the
/// chosen slot; the default sentinel reuses the legacy keychain layout.
final class KeystorePerProfileTests: XCTestCase {

    /// Every named profile slot any case in this class touches. Wiped in
    /// setUp + tearDown so cases are hermetic regardless of run order and
    /// no named slot leaks into another test class.
    private static let usedProfiles = [
        "personal", "work", "alpha", "beta", "Jay-Family",
        "keep", "drop", "family", "p1", "p2"
    ]

    private func resetAll() {
        for name in Self.usedProfiles {
            Keystore.setActiveProfile(name)
            Keystore.wipe()
        }
        Keystore.setActiveProfile(nil)
        Keystore.wipe()           // default/legacy slot + device-global push
        Keystore.wipeAllProfiles()
    }

    override func setUp() async throws { resetAll() }
    override func tearDown() async throws { resetAll() }

    private func umkBytes(reason: String) async throws -> Data {
        // Surface the active profile's UMK as raw bytes for comparison.
        let umk = try await Keystore.currentUMK(reason: reason)
        return umk.withUnsafeBytes { Data($0) }
    }

    func test_twoProfiles_eachGetADistinctUMK() async throws {
        Keystore.setActiveProfile("personal")
        try await Keystore.generateUMK(reason: "test")
        let personalUmk = try await umkBytes(reason: "test")

        Keystore.setActiveProfile("work")
        try await Keystore.generateUMK(reason: "test")
        let workUmk = try await umkBytes(reason: "test")

        XCTAssertNotEqual(personalUmk, workUmk,
                          "each profile must get its own UMK")
    }

    func test_setActiveProfile_switchesWhichUMKDerives() async throws {
        Keystore.setActiveProfile("personal")
        try await Keystore.generateUMK(reason: "test")
        let personalIrk = try await Keystore.deriveIRK(reason: "test")

        Keystore.setActiveProfile("work")
        try await Keystore.generateUMK(reason: "test")
        let workIrk = try await Keystore.deriveIRK(reason: "test")

        XCTAssertNotEqual(personalIrk.publicKey.rawRepresentation,
                          workIrk.publicKey.rawRepresentation,
                          "the active profile selects which IRK derives")

        // Switching back yields the SAME IRK as before (stable per slot).
        Keystore.setActiveProfile("personal")
        let personalIrkAgain = try await Keystore.deriveIRK(reason: "test")
        XCTAssertEqual(personalIrk.publicKey.rawRepresentation,
                       personalIrkAgain.publicKey.rawRepresentation,
                       "switching back to a profile recovers its IRK")
    }

    func test_installingProfileB_doesNotChangeProfileA_UMK() async throws {
        Keystore.setActiveProfile("alpha")
        try await Keystore.generateUMK(reason: "test")
        let alphaBefore = try await umkBytes(reason: "test")

        // Add (install) profile B with a freshly-generated UMK.
        let bSeed = SymmetricKey(size: .bits256)
        try await Keystore.installUMK(bSeed, reason: "test", profile: "beta")
        XCTAssertTrue(Keystore.hasWrappedUMK, "beta now has a UMK")

        // Profile A's UMK is untouched.
        Keystore.setActiveProfile("alpha")
        let alphaAfter = try await umkBytes(reason: "test")
        XCTAssertEqual(alphaBefore, alphaAfter,
                       "installing profile B must not clobber profile A's UMK")
    }

    func test_caseInsensitiveProfileId_mapsToSameSlot() async throws {
        Keystore.setActiveProfile("Jay-Family")
        try await Keystore.generateUMK(reason: "test")
        let mixed = try await umkBytes(reason: "test")

        // The profileId is lowercased; a differently-cased name is the
        // SAME slot, not a new one.
        Keystore.setActiveProfile("jay-family")
        XCTAssertTrue(Keystore.hasWrappedUMK, "lowercased id resolves the same slot")
        let lower = try await umkBytes(reason: "test")
        XCTAssertEqual(mixed, lower)
    }

    func test_wipe_clearsOnlyActiveProfile() async throws {
        Keystore.setActiveProfile("keep")
        try await Keystore.generateUMK(reason: "test")
        let keepUmk = try await umkBytes(reason: "test")

        Keystore.setActiveProfile("drop")
        try await Keystore.generateUMK(reason: "test")
        XCTAssertTrue(Keystore.hasWrappedUMK)

        // Wipe ONLY the active ("drop") profile.
        Keystore.wipe()
        XCTAssertFalse(Keystore.hasWrappedUMK, "active profile's UMK is gone")

        // The other profile survives.
        Keystore.setActiveProfile("keep")
        XCTAssertTrue(Keystore.hasWrappedUMK, "non-active profile must survive a per-profile wipe")
        let keepAfter = try await umkBytes(reason: "test")
        XCTAssertEqual(keepUmk, keepAfter)
    }

    func test_defaultProfile_matchesLegacyPath() async throws {
        // No setActiveProfile (or the default sentinel) → legacy slot.
        // Generate on default, then prove the SAME bytes are visible
        // whether referenced as nil or the default sentinel.
        Keystore.setActiveProfile(nil)
        try await Keystore.generateUMK(reason: "test")
        XCTAssertTrue(Keystore.hasWrappedUMK)
        let viaNil = try await umkBytes(reason: "test")

        Keystore.setActiveProfile(Keystore.defaultProfileId)
        XCTAssertTrue(Keystore.hasWrappedUMK,
                      "the default sentinel resolves the same legacy slot as nil")
        let viaSentinel = try await umkBytes(reason: "test")
        XCTAssertEqual(viaNil, viaSentinel)

        // An empty / whitespace id also normalizes to the default slot.
        Keystore.setActiveProfile("   ")
        XCTAssertTrue(Keystore.hasWrappedUMK)
        let viaBlank = try await umkBytes(reason: "test")
        XCTAssertEqual(viaNil, viaBlank)
    }

    func test_defaultSlot_isDistinctFromNamedProfileSlot() async throws {
        // The legacy/default slot and a named profile are different slots.
        Keystore.setActiveProfile(nil)
        try await Keystore.generateUMK(reason: "test")
        let defaultUmk = try await umkBytes(reason: "test")

        Keystore.setActiveProfile("family")
        try await Keystore.generateUMK(reason: "test")
        let familyUmk = try await umkBytes(reason: "test")
        XCTAssertNotEqual(defaultUmk, familyUmk)

        // The default slot is unchanged after the named profile installed.
        Keystore.setActiveProfile(nil)
        let defaultAfter = try await umkBytes(reason: "test")
        XCTAssertEqual(defaultUmk, defaultAfter)
    }

    func test_irkVersion_isPerProfile() async throws {
        Keystore.setActiveProfile("p1")
        try await Keystore.generateUMK(reason: "test")
        XCTAssertEqual(Keystore.currentIrkVersion(), 1)
        try Keystore.setCurrentIrkVersion(5)
        XCTAssertEqual(Keystore.currentIrkVersion(), 5)

        // A different profile starts at the default version, untouched.
        Keystore.setActiveProfile("p2")
        try await Keystore.generateUMK(reason: "test")
        XCTAssertEqual(Keystore.currentIrkVersion(), 1,
                       "IRK version is tracked per profile")

        // p1 still reads its bumped version.
        Keystore.setActiveProfile("p1")
        XCTAssertEqual(Keystore.currentIrkVersion(), 5)
    }
}
