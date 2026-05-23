import XCTest
@testable import FlagshipCore
@testable import FlagshipUI
@testable import Flagship
@testable import FlagshipAPI

/// Two-tier boot-unlock app-shell glue: the per-server `BootUnlockStore`,
/// the create-server view-model default, and the on-wire blob's
/// bootUnlockMode parity with the webapp (only "approve" rides the wire;
/// "auto" stays absent so the recipe bytes match byte-for-byte).
final class BootUnlockStoreTests: XCTestCase {
    private func freshStore() -> (BootUnlockStore, UserDefaults) {
        let suite = "flagship.bootunlock.tests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defaults.removePersistentDomain(forName: suite)
        return (BootUnlockStore(defaults: defaults), defaults)
    }

    func test_modeRoundTrips() {
        let (store, _) = freshStore()
        let domain = "home.harry.flagship.services"
        XCTAssertNil(store.mode(for: domain))
        store.setMode(.approve, for: domain)
        XCTAssertEqual(store.mode(for: domain), .approve)
        store.setMode(.auto, for: domain)
        XCTAssertEqual(store.mode(for: domain), .auto)
    }

    // Absent ⇒ the product default ("auto"), matching the box's "absence ⇒
    // auto" rule (so cross-device approvals still deposit a self-unlock lease).
    func test_effectiveModeDefaultsToAutoWhenUnset() {
        let (store, _) = freshStore()
        XCTAssertEqual(store.effectiveMode(for: "unknown.harry.flagship.services"), .auto)
    }

    func test_modeKeyIsCaseInsensitiveOnDomain() {
        let (store, _) = freshStore()
        store.setMode(.approve, for: "Home.Harry.Flagship.Services")
        XCTAssertEqual(store.mode(for: "home.harry.flagship.services"), .approve)
    }

    func test_leaseIdRoundTripsAndClears() {
        let (store, _) = freshStore()
        let domain = "home.harry.flagship.services"
        XCTAssertNil(store.leaseId(for: domain))
        store.setLeaseId("deadbeefdeadbeef", for: domain)
        XCTAssertEqual(store.leaseId(for: domain), "deadbeefdeadbeef")
        // The kill switch clears with nil.
        store.setLeaseId(nil, for: domain)
        XCTAssertNil(store.leaseId(for: domain))
    }
}

@MainActor
final class CreateServerBootUnlockTests: XCTestCase {
    private func makeVM() -> CreateServerViewModel {
        CreateServerViewModel(
            username: "harry",
            server: MockFlagshipServerClient(),
            relay: MockQrRelayClient()
        )
    }

    func test_defaultBootUnlockModeIsAuto() {
        XCTAssertEqual(makeVM().bootUnlockMode, .auto)
    }
}

/// The on-wire blob serialization the box reads. Mirrors the webapp's
/// create-server.js: `onWireBlob.bootUnlockMode` is set ONLY for "approve";
/// "auto" omits the key entirely (recipe-byte parity + old-verifier accept).
final class OnWireBootUnlockTests: XCTestCase {
    private func signed(bootUnlockMode: String?) -> SignedInstallBlob {
        let auth = AuthCode(
            serial: "01ABCD",
            username: "harry",
            serverName: "home",
            serverDomain: "home.harry.flagship.services",
            delegatedPubKey: Data(repeating: 0x11, count: 32),
            userPubKey: Data(repeating: 0x22, count: 32),
            issuedAt: 1_000,
            expiresAt: 2_000
        )
        let blob = InstallBlob(
            serverDomain: "home.harry.flagship.services",
            username: "harry",
            serverName: "home",
            phoneDelegatedPubKey: Data(repeating: 0x33, count: 32),
            authCode: auth,
            authCodeUserSignature: Data(repeating: 0x44, count: 64),
            rckPubKey: Data(repeating: 0x55, count: 32),
            bootUnlockMode: bootUnlockMode
        )
        return SignedInstallBlob(blob: blob, signatureHex: "ab")
    }

    private func json(_ s: SignedInstallBlob) throws -> String {
        String(data: try JSONEncoder().encode(s.onWire()), encoding: .utf8)!
    }

    func test_autoOmitsBootUnlockModeFromWire() throws {
        let j = try json(signed(bootUnlockMode: nil))
        XCTAssertFalse(j.contains("bootUnlockMode"))
    }

    func test_approveIncludesBootUnlockModeOnWire() throws {
        let j = try json(signed(bootUnlockMode: "approve"))
        XCTAssertTrue(j.contains("\"bootUnlockMode\":\"approve\""))
    }
}
