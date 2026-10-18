import XCTest
import CryptoKit
@testable import FlagshipCore
@testable import FlagshipUI
@testable import Flagship
@testable import FlagshipAPI

/// A retry of the same pending name must register the SAME routing key:
/// `.com` pins a name to the first RCK it sees and answers a different one
/// with `409 subdomain already controlled by a different RCK`.
@MainActor
final class CreateServerRckReuseTests: XCTestCase {
    private var defaults: UserDefaults!

    override func setUp() async throws {
        try await super.setUp()
        defaults = UserDefaults(suiteName: "rck-reuse-\(UUID().uuidString)")
        Keystore.wipe()
        try await Keystore.generateUMK(reason: "test open account")
        try await Keystore.generateAdminRoot(reason: "test open account")
    }

    override func tearDown() async throws {
        Keystore.wipe()
        try? Keystore.setPendingIrkRotationVersion(nil)
        try await super.tearDown()
    }

    private func makeVM(_ server: MockFlagshipServerClient, name: String = "Home") -> CreateServerViewModel {
        let vm = CreateServerViewModel(
            username: "harry",
            server: server,
            relay: MockQrRelayClient(),
            rckStore: PendingRckStore(defaults: defaults),
            isDemoAccount: false
        )
        vm.name = name
        return vm
    }

    func test_mintingTwiceForOneName_registersTheSameRck() async throws {
        let server = MockFlagshipServerClient()
        server.simulatedLatency = 0
        let first = try await makeVM(server).mintInstallBlob()
        let second = try await makeVM(server).mintInstallBlob()
        XCTAssertEqual(first.blob.rckPubKey, second.blob.rckPubKey)
        XCTAssertEqual(server.registeredRcks["home.harry.flagship.services"], HexUtil.encode(first.blob.rckPubKey))
    }

    func test_aDifferentNameGetsItsOwnRck() async throws {
        let server = MockFlagshipServerClient()
        server.simulatedLatency = 0
        let a = try await makeVM(server, name: "Home").mintInstallBlob()
        let b = try await makeVM(server, name: "Garage").mintInstallBlob()
        XCTAssertNotEqual(a.blob.rckPubKey, b.blob.rckPubKey)
    }

    func test_withoutTheStore_aSecondMintIsRefusedLikeCom() async throws {
        // Documents the failure this fixes: two random keys for one name.
        let server = MockFlagshipServerClient()
        server.simulatedLatency = 0
        _ = try await makeVM(server).mintInstallBlob()
        let other = CreateServerViewModel(
            username: "harry", server: server, relay: MockQrRelayClient(),
            rckStore: PendingRckStore(defaults: UserDefaults(suiteName: "rck-reuse-\(UUID().uuidString)")!),
            isDemoAccount: false
        )
        other.name = "Home"
        do {
            _ = try await other.mintInstallBlob()
            XCTFail("a different RCK for a pinned name must be refused")
        } catch let ScreensClientError.http(status, _) {
            XCTAssertEqual(status, 409)
        }
    }

    func test_afterTheNameIsReleased_aNewKeyIsAccepted() async throws {
        let server = MockFlagshipServerClient()
        server.simulatedLatency = 0
        let first = try await makeVM(server).mintInstallBlob()
        let store = PendingRckStore(defaults: defaults)
        store.clear(for: "home.harry.flagship.services")
        let key = try await Keystore.sensitiveOrderSigningKey(reason: "release")
        let sig = try key.signature(for: ReleaseServerName.canonicalBytes(
            username: "harry", serverDomain: "home.harry.flagship.services", issuedAt: 1
        ))
        try await server.releaseServerName(.init(
            request: .init(username: "harry", serverDomain: "home.harry.flagship.services", issuedAt: 1),
            signature: HexUtil.encode(sig)
        ))
        let again = try await makeVM(server).mintInstallBlob()
        XCTAssertNotEqual(first.blob.rckPubKey, again.blob.rckPubKey)
    }
}
