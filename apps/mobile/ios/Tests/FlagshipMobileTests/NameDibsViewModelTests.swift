import XCTest
import CryptoKit
@testable import FlagshipAPI
@testable import FlagshipCore
@testable import FlagshipUI

@MainActor
final class NameDibsViewModelTests: XCTestCase {
    private let key = Curve25519.Signing.PrivateKey()

    private func vm(_ client: MockNameDibsClient, now: Int64 = 1_000) -> NameDibsViewModel {
        NameDibsViewModel(client: client, username: "Fresh-Poppy", signer: { [key] _ in key }, now: { now })
    }

    func test_closedWindow_explains_andFutureStartIsShown() async {
        let client = MockNameDibsClient()
        client.scriptedWindow = DibsWindow(configured: true, open: false, start: 5_000, end: 9_000)
        let model = vm(client)
        await model.load()
        XCTAssertEqual(model.phase, .closed(opensAt: 5_000))
    }

    func test_start_signsTheInitiate_andShowsWhereToPublish() async throws {
        let client = MockNameDibsClient()
        client.scriptedWindow = DibsWindow(configured: true, open: true, start: 0, end: 9_000)
        let model = vm(client)
        await model.load()
        XCTAssertEqual(model.phase, .enterName(closesAt: 9_000))
        await model.start(name: " Acme.com ")

        let body = try XCTUnwrap(client.initiates.first)
        XCTAssertEqual(body.request.username, "fresh-poppy")
        XCTAssertEqual(body.request.name, "acme")
        XCTAssertEqual(body.request.irkPubHex, HexUtil.encode(key.publicKey.rawRepresentation))
        let bytes = NameDibsInitiate.canonicalBytes(
            username: body.request.username, name: body.request.name,
            irkPubHex: body.request.irkPubHex, issuedAt: body.request.issuedAt
        )
        XCTAssertTrue(key.publicKey.isValidSignature(HexUtil.decode(body.signature)!, for: bytes))
        guard case .publish(let claim) = model.phase else { return XCTFail("expected .publish, got \(model.phase)") }
        XCTAssertEqual(claim.publishAt.dns.name, "_flagship-claim.acme.com")
    }

    func test_check_reportsProven() async {
        let client = MockNameDibsClient()
        client.scriptedWindow = DibsWindow(configured: true, open: true, start: 0, end: 9_000)
        let model = vm(client)
        await model.load()
        await model.start(name: "acme")
        await model.check()
        XCTAssertEqual(model.phase, .proven(name: "acme"))
        XCTAssertEqual(client.verifies.first?.request.nonce, client.verifies.first.map { _ in String(repeating: "0", count: 63) + "1" })
    }

    func test_check_keepsThePublishStep_andShowsTheRefusal() async {
        let client = MockNameDibsClient()
        client.scriptedWindow = DibsWindow(configured: true, open: true, start: 0, end: 9_000)
        client.verifyError = DibsClientError(status: 409, message: "no proof found yet")
        let model = vm(client)
        await model.load()
        await model.start(name: "acme")
        await model.check()
        guard case .publish = model.phase else { return XCTFail("expected .publish") }
        XCTAssertEqual(model.inlineError, "no proof found yet")
    }

    func test_bannerShowsOnlyWhileOpen_andUntilDismissed() {
        let open = DibsWindow(configured: true, open: true, start: 0, end: 1)
        XCTAssertTrue(NameDibsViewModel.shouldShowBanner(window: open, dismissed: false))
        XCTAssertFalse(NameDibsViewModel.shouldShowBanner(window: open, dismissed: true))
        XCTAssertFalse(NameDibsViewModel.shouldShowBanner(window: nil, dismissed: false))
    }
}
