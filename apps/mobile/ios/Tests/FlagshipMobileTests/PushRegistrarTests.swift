import XCTest
import CryptoKit
@testable import Flagship
@testable import FlagshipAPI
@testable import FlagshipCore
@testable import FlagshipUI

@MainActor
final class PushRegistrarTests: XCTestCase {
    private let deviceId = "00112233445566778899aabbccddeeff"

    private func pairedState(username: String = "harry") -> AppState {
        let profile = Profile(cloudName: username, accountId: username, deviceId: deviceId)
        return AppState(
            isPaired: true,
            currentUser: username,
            profiles: [profile],
            activeProfileCloudName: username
        )
    }

    override func setUp() async throws {
        try await super.setUp()
        // Each test runs against a freshly-wiped keystore so the
        // X25519 push key + UMK get re-generated rather than leaking
        // state across tests.
        Keystore.wipe()
        try await Keystore.generateUMK(reason: "test")
    }

    func test_handle_signsCanonicalBytes_postsRequest_savesTokenId() async throws {
        let state = pairedState()
        let mock = MockFlagshipServerClient()
        mock.simulatedLatency = 0
        let registrar = PushRegistrar(appState: state, client: mock)

        let rawToken = Data(repeating: 0xAB, count: 32)
        await registrar.handle(deviceToken: rawToken)

        // 1) Registration landed.
        XCTAssertNil(registrar.lastError)
        XCTAssertNotNil(registrar.lastRegisteredTokenId)
        XCTAssertEqual(mock.registeredPushTokens.count, 1)

        // 2) Token id persisted to keychain (or in-memory fallback).
        XCTAssertEqual(Keystore.pushTokenId(), registrar.lastRegisteredTokenId)

        // 3) The signature in the stored claim verifies under the IRK
        //    over canonical bytes — the most important invariant since
        //    .com will reject anything that doesn't.
        let inner = mock.registeredPushTokens.values.first!
        XCTAssertEqual(inner.username, "harry")
        XCTAssertEqual(inner.platform, "apns")
        XCTAssertEqual(inner.providerToken, HexUtil.encode(rawToken))
        let irk = try await Keystore.deriveIRK(reason: "test")
        let bytes = PushTokenRegister.canonicalBytes(
            username: inner.username,
            deviceId: inner.deviceId,
            platform: inner.platform,
            providerToken: inner.providerToken,
            pushX25519PubHex: inner.pushX25519Pub,
            issuedAt: inner.issuedAt
        )
        let sig = try irk.signature(for: bytes)
        XCTAssertTrue(irk.publicKey.isValidSignature(sig, for: bytes))
    }

    func test_handle_skipsWhenNoUsername() async throws {
        let state = AppState(isPaired: false, currentUser: nil, pods: [])
        let mock = MockFlagshipServerClient()
        mock.simulatedLatency = 0
        let registrar = PushRegistrar(appState: state, client: mock)
        await registrar.handle(deviceToken: Data([1, 2, 3]))
        XCTAssertNil(registrar.lastRegisteredTokenId)
        XCTAssertEqual(mock.registeredPushTokens.count, 0)
    }

    func test_handle_skipsOnEmptyToken() async throws {
        let state = pairedState()
        let mock = MockFlagshipServerClient()
        mock.simulatedLatency = 0
        let registrar = PushRegistrar(appState: state, client: mock)
        await registrar.handle(deviceToken: nil)
        await registrar.handle(deviceToken: Data())
        XCTAssertEqual(mock.registeredPushTokens.count, 0)
    }

    func test_pushX25519Key_isStableAcrossCalls() throws {
        let a = try Keystore.loadOrCreatePushX25519()
        let b = try Keystore.loadOrCreatePushX25519()
        XCTAssertEqual(a.publicKey.rawRepresentation, b.publicKey.rawRepresentation)
    }

    func test_revoke_deletesTokenIdAndWipesKeychain() async throws {
        let state = pairedState()
        let mock = MockFlagshipServerClient()
        mock.simulatedLatency = 0
        let registrar = PushRegistrar(appState: state, client: mock)

        // 1) Register a token so there's something to revoke.
        await registrar.handle(deviceToken: Data(repeating: 0x33, count: 32))
        let id = registrar.lastRegisteredTokenId
        XCTAssertNotNil(id)
        XCTAssertEqual(mock.registeredPushTokens.count, 1)
        XCTAssertEqual(Keystore.pushTokenId(), id)

        // 2) Revoke clears both server-side + Keychain.
        await registrar.revoke()
        XCTAssertEqual(mock.registeredPushTokens.count, 0)
        XCTAssertNil(Keystore.pushTokenId())
        XCTAssertNil(registrar.lastRegisteredTokenId)
    }

    func test_revoke_isNoOpWhenNothingRegistered() async {
        let state = pairedState()
        let mock = MockFlagshipServerClient()
        mock.simulatedLatency = 0
        let registrar = PushRegistrar(appState: state, client: mock)
        await registrar.revoke()
        XCTAssertNil(registrar.lastRegisteredTokenId)
        XCTAssertNil(Keystore.pushTokenId())
    }
}
