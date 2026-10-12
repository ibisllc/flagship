import XCTest
import CryptoKit
@testable import FlagshipAPI
@testable import FlagshipCore
@testable import FlagshipUI

@MainActor
final class UnrevokeServerViewModelTests: XCTestCase {
    private let fqdn = "home.harry.flagship.services"

    private func key() -> Curve25519.Signing.PrivateKey {
        try! Curve25519.Signing.PrivateKey(rawRepresentation: Data(repeating: 4, count: 32))
    }

    private func vm(_ server: any FlagshipServerClient, user: String? = "harry") -> UnrevokeServerViewModel {
        UnrevokeServerViewModel(
            server: server,
            serverDomain: fqdn,
            username: { user },
            signer: { _ in self.key() },
            now: { 1_700_000_000_000 }
        )
    }

    func testSignsCanonicalBytesWithSensitiveOrderKey() async throws {
        let mock = MockFlagshipServerClient()
        mock.simulatedLatency = 0
        try await mock.revokeServer(.init(
            request: .init(userId: "harry", revokedServerId: fqdn, reason: "lost", issuedAt: 1),
            signature: String(repeating: "0", count: 128)
        ))
        let m = vm(mock)
        await m.run()
        XCTAssertEqual(m.phase, .completed)
        let req = try XCTUnwrap(mock.unrevokedServers.first)
        XCTAssertEqual(req.request.username, "harry")
        XCTAssertEqual(req.request.serverDomain, fqdn)
        XCTAssertEqual(req.request.issuedAt, 1_700_000_000_000)
        XCTAssertEqual(req.signature.count, 128)
        let sig = try XCTUnwrap(HexUtil.decode(req.signature))
        XCTAssertTrue(key().publicKey.isValidSignature(
            sig,
            for: ServerUnrevocation.canonicalBytes(username: "harry", serverDomain: fqdn, issuedAt: 1_700_000_000_000)
        ))
    }

    func testAlreadyActiveIsSuccess() async {
        let mock = MockFlagshipServerClient()
        mock.simulatedLatency = 0
        let m = vm(mock)
        await m.run()
        XCTAssertEqual(m.phase, .completed)
    }

    func test409ReadsCantBeRestored() async {
        let mock = MockFlagshipServerClient()
        mock.simulatedLatency = 0
        mock.nonRestorableRevokes = [fqdn]
        let m = vm(mock)
        await m.run()
        XCTAssertEqual(m.phase, .failed("This server was deleted, transferred or retired and can't be restored."))
    }

    func test403And404AreFriendly() async {
        let forbidden = RevokeServerTests.ThrowingServer(error: ScreensClientError.http(status: 403, message: "invalid signature"))
        let a = vm(forbidden)
        await a.run()
        XCTAssertEqual(a.phase, .failed("The server rejected the request. Sign in again and retry."))

        let missing = RevokeServerTests.ThrowingServer(error: ScreensClientError.http(status: 404, message: "unknown server"))
        let b = vm(missing)
        await b.run()
        XCTAssertEqual(b.phase, .failed("That server no longer exists."))
    }

    func testNoAccountFailsWithoutSigning() async {
        let mock = MockFlagshipServerClient()
        mock.simulatedLatency = 0
        let m = vm(mock, user: nil)
        await m.run()
        guard case .failed = m.phase else { return XCTFail("expected failure") }
        XCTAssertTrue(mock.unrevokedServers.isEmpty)
    }
}
