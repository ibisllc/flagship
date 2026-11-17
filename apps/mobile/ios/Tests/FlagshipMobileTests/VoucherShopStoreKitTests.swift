import XCTest
import StoreKit
import StoreKitTest
import FlagshipAPI
import FlagshipCore
@testable import FlagshipUI

/// The real StoreKit 2 path in a local StoreKit test session (apps/mobile/ios/App/StoreKit/FlagshipVouchers.storekit):
/// a pack is bought, its JWS goes to `.com` (the in-memory one), and the transaction is finished only after the
/// wallet is saved.
@MainActor
final class VoucherShopStoreKitTests: XCTestCase {
    private var session: SKTestSession!

    override func setUp() async throws {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("App/StoreKit/FlagshipVouchers.storekit")
        session = try SKTestSession(contentsOf: url)
        session.resetToDefaultState()
        session.disableDialogs = true
        session.clearTransactions()
    }

    override func tearDown() async throws {
        session?.clearTransactions()
        session = nil
    }

    func testBuyHandsTheJwsToComAndFinishesAfterTheSave() async throws {
        let mock = MockPaymentsComClient()
        let com = RecordingPaymentsCom(mock)
        var unfinishedAtSave: [String] = []
        com.beforePut = {
            for await r in Transaction.unfinished { unfinishedAtSave.append(String(r.unsafePayloadValue.id)) }
        }
        let device: VoiciDeviceSigner = { _, _ in
            AccountDirectoryAuthorization(deviceId: "d1", signerPubHex: String(repeating: "a", count: 64), requestId: "r", issuedAt: 1, signatureHex: "s")
        }
        let center = PaymentsCenter(defaults: UserDefaults(suiteName: UUID().uuidString)!, context: { u in
            .init(username: u, isAdmin: true, umk: { [UInt8](repeating: 7, count: 32) }, device: device)
        }, store: StoreKitVoucherStore(), vault: MemoryShopVault())
        center.configure(client: com, username: "plucky-avocet", deviceId: "d1")
        await center.refreshAndTick()
        let shop = try XCTUnwrap(center.shop)
        // SwiftPM test bundles run in the host-less xctest tool, where a local StoreKit session serves no products.
        // The test runs in full only from an app-hosted test target.
        if shop.products.isEmpty, Bundle.main.bundleIdentifier == "com.apple.dt.xctest.tool" {
            throw XCTSkip("StoreKit test sessions need an app-hosted test bundle (got the xctest tool)")
        }
        XCTAssertEqual(shop.products.map(\.units), [10, 30, 120], "StoreKit sells the three packs.")

        let ok = await center.buy(units: 30)
        XCTAssertTrue(ok, "outcome: \(String(describing: shop.outcome))")
        XCTAssertEqual(center.balanceUnits, 30)

        let jws = try XCTUnwrap(com.proofs.first?["jws"]?.string)
        XCTAssertEqual(jws.split(separator: ".").count, 3, "A compact JWS.")
        let payload = try XCTUnwrap(MockPaymentsComClient.jwsPayload(jws))
        XCTAssertEqual(payload["productId"]?.string, "com.flagshipserver.app.vouchers.30")
        XCTAssertNil(payload["appAccountToken"], "No account token rides with the purchase.")
        let txId = try XCTUnwrap(payload["transactionId"]?.string)
        XCTAssertTrue(unfinishedAtSave.contains(txId), "Still unfinished while the wallet was being saved.")
        XCTAssertEqual(com.events.filter { $0 == "issue" || $0 == "put" }, ["issue", "put"])
        var stillOpen: [String] = []
        for await r in Transaction.unfinished { stillOpen.append(String(r.unsafePayloadValue.id)) }
        XCTAssertFalse(stillOpen.contains(txId), "Finished once the wallet held the vouchers.")
    }
}
