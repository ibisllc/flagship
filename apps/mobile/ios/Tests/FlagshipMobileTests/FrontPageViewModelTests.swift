import XCTest
import CryptoKit
@testable import FlagshipCore
@testable import FlagshipUI
@testable import FlagshipAPI

@MainActor
final class FrontPageViewModelTests: XCTestCase {
    private let server = "home.alice.flagship.services"
    private func key() -> Curve25519.Signing.PrivateKey {
        try! Curve25519.Signing.PrivateKey(rawRepresentation: Data(repeating: 9, count: 32))
    }

    func testLoadPopulatesCurrentAndOptions() async {
        let mock = MockFrontPageClient()
        mock.state = FrontPageState(label: "photos", active: true)
        mock.options = [
            FrontPageOption(urlLabel: "photos", name: "Photos"),
            FrontPageOption(urlLabel: "blog", name: "Blog"),
        ]
        let vm = FrontPageViewModel(client: mock, serverDomain: server, signer: { _ in self.key() })
        await vm.load()
        XCTAssertEqual(vm.phase, .ready)
        XCTAssertEqual(vm.current, "photos")
        XCTAssertTrue(vm.currentActive)
        XCTAssertEqual(vm.options.map(\.urlLabel), ["photos", "blog"])
    }

    func testSaveSignsAndPostsValidEnvelope() async {
        let mock = MockFrontPageClient()
        let k = key()
        let vm = FrontPageViewModel(client: mock, serverDomain: server, signer: { _ in k }, now: { 1700 })
        await vm.save(label: "photos")

        XCTAssertEqual(vm.phase, .ready)
        XCTAssertEqual(vm.current, "photos")
        XCTAssertEqual(mock.sent.count, 1)
        let sent = mock.sent[0]
        XCTAssertEqual(sent.serverDomain, server)
        XCTAssertEqual(sent.request["type"], "set-front-page")
        XCTAssertEqual(sent.request["label"], "photos")
        // The posted signature verifies against the exact canonical bytes.
        let order = SetFrontPageOrder(serverId: server, label: "photos", issuedAt: 1700)
        let sig = Data(HexUtil.decode(sent.signatureHex)!)
        XCTAssertTrue(k.publicKey.isValidSignature(sig, for: order.canonicalBytes()))
    }

    func testClearSendsEmptyLabel() async {
        let mock = MockFrontPageClient()
        let vm = FrontPageViewModel(client: mock, serverDomain: server, signer: { _ in self.key() }, now: { 9 })
        await vm.save(label: "")
        XCTAssertEqual(vm.current, nil)
        XCTAssertEqual(mock.sent[0].request["label"], "")
    }

    func testSignerFailureSurfacesWithoutPosting() async {
        struct Nope: Error {}
        let mock = MockFrontPageClient()
        let vm = FrontPageViewModel(client: mock, serverDomain: server, signer: { _ in throw Nope() })
        await vm.save(label: "photos")
        if case .failed = vm.phase {} else { XCTFail("expected .failed, got \(vm.phase)") }
        XCTAssertTrue(mock.sent.isEmpty)
    }

    func testPostFailureSurfacesDaemonMessage() async {
        let mock = MockFrontPageClient()
        mock.nextError = ScreensClientError.http(status: 422, message: "unknown service label")
        let vm = FrontPageViewModel(client: mock, serverDomain: server, signer: { _ in self.key() })
        await vm.save(label: "ghost")
        if case .failed = vm.phase {} else { XCTFail("expected .failed, got \(vm.phase)") }
    }

    func testLoadFailureIsGraceful() async {
        struct Down: Error {}
        let mock = MockFrontPageClient()
        mock.nextError = Down()
        let vm = FrontPageViewModel(client: mock, serverDomain: server, signer: { _ in self.key() })
        await vm.load()
        if case .failed = vm.phase {} else { XCTFail("expected .failed, got \(vm.phase)") }
    }
}
