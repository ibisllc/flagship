import XCTest
import CryptoKit
@testable import FlagshipCore
@testable import FlagshipUI
@testable import FlagshipAPI

@MainActor
final class LockPowerViewModelTests: XCTestCase {
    private let server = "home.alice.flagship.services"
    private func key() -> Curve25519.Signing.PrivateKey {
        try! Curve25519.Signing.PrivateKey(rawRepresentation: Data(repeating: 9, count: 32))
    }

    func testPowerOffSignsAndPostsValidEnvelope() async {
        let mock = MockLockPowerClient()
        let k = key()
        let vm = LockPowerViewModel(
            client: mock,
            serverDomain: server,
            signer: { _ in k },
            now: { 1700 }
        )
        await vm.run(mode: .off)

        XCTAssertEqual(vm.phase, .sent(.off))
        XCTAssertEqual(mock.sent.count, 1)
        let sent = mock.sent[0]
        XCTAssertEqual(sent.path, "/api/power")
        XCTAssertEqual(sent.serverDomain, server)
        XCTAssertEqual(sent.request["type"], "power-off")
        XCTAssertEqual(sent.request["mode"], "off")
        // The posted signature verifies against the exact canonical bytes.
        let order = PowerOffOrder(serverId: server, mode: .off, issuedAt: 1700)
        let sig = Data(HexUtil.decode(sent.signatureHex)!)
        XCTAssertTrue(k.publicKey.isValidSignature(sig, for: order.canonicalBytes()))
    }

    func testRestartMode() async {
        let mock = MockLockPowerClient()
        let k = key()
        let vm = LockPowerViewModel(client: mock, serverDomain: server, signer: { _ in k }, now: { 42 })
        await vm.run(mode: .restart)
        XCTAssertEqual(vm.phase, .sent(.restart))
        XCTAssertEqual(mock.sent[0].request["mode"], "restart")
    }

    func testPostFailureSurfaces() async {
        let mock = MockLockPowerClient()
        mock.nextError = ScreensClientError.http(status: 403, message: "no")
        let vm = LockPowerViewModel(client: mock, serverDomain: server, signer: { _ in self.key() })
        await vm.run(mode: .off)
        if case .failed = vm.phase {} else { XCTFail("expected failed, got \(vm.phase)") }
    }

    func testSignerFailureSurfacesWithoutPost() async {
        let mock = MockLockPowerClient()
        struct E: Error {}
        let vm = LockPowerViewModel(client: mock, serverDomain: server, signer: { _ in throw E() })
        await vm.run(mode: .off)
        if case .failed = vm.phase {} else { XCTFail("expected failed") }
        XCTAssertTrue(mock.sent.isEmpty, "must not POST when signing fails")
    }
}
