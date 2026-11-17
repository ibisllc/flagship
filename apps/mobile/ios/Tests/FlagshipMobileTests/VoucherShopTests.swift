import XCTest
import FlagshipAPI
import FlagshipCore
@testable import FlagshipUI

/// A `.com` that forwards to the in-memory one and writes down what happened, in order.
final class RecordingPaymentsCom: PaymentsComClient, @unchecked Sendable {
    let inner: MockPaymentsComClient
    var events: [String] = []
    var blindedSent: [[String]] = []
    var proofs: [JSONValue] = []
    var failPut: String?
    var beforePut: (() async -> Void)?

    init(_ inner: MockPaymentsComClient) { self.inner = inner }

    func paymentsInfo() async throws -> PaymentsInfo { try await inner.paymentsInfo() }
    func wallet(username: String) async throws -> JSONValue? { try await inner.wallet(username: username) }
    func putWallet(username: String, sealed: JSONValue, device: VoiciDeviceSigner) async throws {
        await beforePut?()
        if let c = failPut { events.append("put-failed"); throw PaymentsComError(status: 0, code: c) }
        try await inner.putWallet(username: username, sealed: sealed, device: device)
        events.append("put")
    }
    func redeem(username: String, for what: String, vouchers: [Voucher], route: SpendRoute) async throws -> VoucherRedeemResult {
        try await inner.redeem(username: username, for: what, vouchers: vouchers, route: route)
    }
    func testIssue(keyId: String, blinded: [String]) async throws -> [String] { try await inner.testIssue(keyId: keyId, blinded: blinded) }
    func paidIssue(rail: String, proof: JSONValue, keyId: String, blinded: [String]) async throws -> PaidIssueResult {
        blindedSent.append(blinded)
        proofs.append(proof)
        do {
            let r = try await inner.paidIssue(rail: rail, proof: proof, keyId: keyId, blinded: blinded)
            events.append("issue")
            return r
        } catch let e as PaymentsComError {
            events.append("issue-\(e.code)")
            throw e
        }
    }
    func plan(username: String) async throws -> AccountPlanState { try await inner.plan(username: username) }
    func allowance(username: String) async throws -> AccountAllowance { try await inner.allowance(username: username) }
}

/// A vault that writes down when requests are kept and dropped.
final class RecordingVault: ShopVault {
    var stored: [String: [ShopPendingRequest]] = [:]
    var records: [ShopPurchaseRecord] = []
    var log: (String) -> Void = { _ in }
    func pending(_ transactionId: String) -> [ShopPendingRequest]? { stored[transactionId] }
    func setPending(_ transactionId: String, _ requests: [ShopPendingRequest]?) {
        stored[transactionId] = requests
        log(requests == nil ? "pending-dropped" : "pending-kept")
    }
    func purchases() -> [ShopPurchaseRecord] { records }
    func setPurchases(_ records: [ShopPurchaseRecord]) { self.records = records }
}

/// The in-app voucher shop (docs/payments-privacy-and-rails.md §11 "Apple") over a fake App Store and the in-memory
/// `.com`: blind, issue, unblind, save, and only then finish.
@MainActor
final class VoucherShopTests: XCTestCase {
    private var clock: Int64 = 1_795_000_000_000
    private let device: VoiciDeviceSigner = { _, _ in
        AccountDirectoryAuthorization(deviceId: "d1", signerPubHex: String(repeating: "a", count: 64), requestId: "r", issuedAt: 1, signatureHex: "s")
    }

    @MainActor private struct Rig {
        let center: PaymentsCenter
        let com: RecordingPaymentsCom
        let mock: MockPaymentsComClient
        let store: MockVoucherStore
        let vault: RecordingVault
        var shop: VoucherShop { center.shop! }
    }

    private func rig(admin: Bool = true) async -> Rig {
        let mock = MockPaymentsComClient()
        mock.now = { [unowned self] in self.clock }
        let com = RecordingPaymentsCom(mock)
        let store = MockVoucherStore()
        let vault = RecordingVault()
        vault.log = { [unowned com] in com.events.append($0) }
        store.onFinish = { [unowned com] _ in com.events.append("finish") }
        let device = self.device
        let c = PaymentsCenter(defaults: UserDefaults(suiteName: UUID().uuidString)!, context: { u in
            .init(username: u, isAdmin: admin, umk: { [UInt8](repeating: 7, count: 32) }, device: device)
        }, store: store, vault: vault)
        c.now = { [unowned self] in self.clock }
        c.random = { 0.25 }
        c.configure(client: com, username: "plucky-avocet", deviceId: "d1")
        await c.refreshAndTick()
        com.events = []
        return Rig(center: c, com: com, mock: mock, store: store, vault: vault)
    }

    func testProductsFollowTheAppleRail() async {
        let r = await rig()
        XCTAssertEqual(r.shop.products.map(\.units), [10, 30, 120])
        XCTAssertTrue(r.shop.products[1].product.displayPrice.contains("30"))
        r.mock.rails = PaymentRails(apple: false)
        await r.center.refreshAndTick()
        XCTAssertTrue(r.shop.products.isEmpty, "Rail off: nothing on sale.")
    }

    func testBuyBlindsIssuesSavesThenFinishes() async throws {
        let r = await rig()
        let ok = await r.center.buy(units: 10)
        XCTAssertTrue(ok)
        XCTAssertEqual(r.com.events, ["pending-kept", "issue", "put", "finish", "pending-dropped"])
        XCTAssertEqual(r.center.balanceUnits, 10)
        XCTAssertEqual(r.store.finished.count, 1)
        XCTAssertTrue(r.vault.stored.isEmpty)
        XCTAssertEqual(r.vault.records.map(\.units), [10])
        XCTAssertEqual(r.shop.outcome?.code, "added")
        XCTAssertEqual(r.store.purchases, ["com.flagshipserver.app.vouchers.10"])
        let proof = try XCTUnwrap(r.com.proofs.first)
        XCTAssertEqual(proof.object?.keys.sorted(), ["jws"], "The proof is the JWS alone.")
        XCTAssertTrue(PlanDisplay.shopOutcome("added", units: 10, .defaults).contains("10"))
    }

    func testRetryReusesTheKeptRequests() async {
        let r = await rig()
        r.mock.paidIssueFailures = ["rail-unreachable"]
        let first = await r.center.buy(units: 30)
        XCTAssertFalse(first)
        XCTAssertEqual(r.shop.outcome?.code, "rail-unreachable")
        XCTAssertEqual(r.store.finished, [], "Not finished while the vouchers aren't in the wallet.")
        XCTAssertEqual(r.vault.stored.values.first?.count, 30)
        XCTAssertEqual(r.center.balanceUnits, 0)
        await r.center.refreshAndTick()
        XCTAssertEqual(r.com.blindedSent.count, 2)
        XCTAssertEqual(r.com.blindedSent[0], r.com.blindedSent[1], "The same blinded set goes again.")
        XCTAssertEqual(r.center.balanceUnits, 30)
        XCTAssertEqual(r.store.finished.count, 1)
        XCTAssertTrue(r.vault.stored.isEmpty)
    }

    func testWalletSaveFailureKeepsTheTransactionOpen() async {
        let r = await rig()
        r.com.failPut = "network"
        let ok = await r.center.buy(units: 10)
        XCTAssertFalse(ok)
        XCTAssertFalse(r.com.events.contains("finish"))
        XCTAssertEqual(r.store.finished, [])
        XCTAssertEqual(r.vault.stored.count, 1)
        r.com.failPut = nil
        await r.center.refreshAndTick()
        XCTAssertEqual(r.store.finished.count, 1)
        XCTAssertEqual(r.center.balanceUnits, 10, "The same signatures again: the same ten vouchers, once.")
        XCTAssertEqual(r.mock.paidIssues.count, 1, "`.com` signed once; the retry got the same answer.")
    }

    func testNewRequestsWhenNoneKeptAndPaymentUsed() async throws {
        let r = await rig()
        let t = r.store.add(productId: "com.flagshipserver.app.vouchers.10")
        // Another device already had this payment signed for its own requests.
        let key = try XCTUnwrap(MockPaymentsComClient.key)
        let other = try (0..<10).map { _ in try Vouchers.newRequest(key: key).blinded }
        _ = try await r.mock.paidIssue(rail: "apple", proof: ["jws": .string(t.jws)], keyId: key.keyId, blinded: other)
        let ok = await r.shop.deliver(t)
        XCTAssertFalse(ok)
        XCTAssertEqual(r.shop.outcome?.code, "payment-used")
        XCTAssertTrue(r.store.isOpen(t.id), "Kept unfinished.")
        XCTAssertEqual(r.center.balanceUnits, 0)
    }

    func testRefundFinishesWithNothingAdded() async {
        let r = await rig()
        let t = r.store.add(productId: "com.flagshipserver.app.vouchers.30")
        r.mock.refunded.insert(t.id)
        let ok = await r.shop.deliver(t)
        XCTAssertFalse(ok)
        XCTAssertEqual(r.shop.outcome?.code, "payment-refunded")
        XCTAssertFalse(r.store.isOpen(t.id))
        XCTAssertTrue(r.vault.stored.isEmpty)
        XCTAssertEqual(r.center.balanceUnits, 0)
        let revoked = r.store.add(productId: "com.flagshipserver.app.vouchers.10", revoked: true)
        _ = await r.shop.deliver(revoked)
        XCTAssertFalse(r.store.isOpen(revoked.id))
        XCTAssertEqual(r.mock.paidIssues.count, 0)
    }

    func testUnpaidAndUnverifiedStayOpen() async {
        let r = await rig()
        let t = r.store.add(productId: "com.flagshipserver.app.vouchers.10")
        r.mock.paidIssueFailures = ["payment-unpaid"]
        _ = await r.shop.deliver(t)
        XCTAssertEqual(r.shop.outcome?.code, "payment-unpaid")
        XCTAssertTrue(r.store.isOpen(t.id))
        let bad = r.store.add(productId: "com.flagshipserver.app.vouchers.10", verified: false)
        r.com.proofs = []
        _ = await r.shop.deliver(bad)
        XCTAssertEqual(r.shop.outcome?.code, "payment-unverified")
        XCTAssertTrue(r.com.proofs.isEmpty, "An unverified transaction never goes to `.com`.")
        XCTAssertTrue(r.store.isOpen(bad.id))
    }

    func testEveryRefusalHasASentence() {
        let generic = PlanDisplay.error("whatever")
        for code in ["payment-invalid", "payment-unpaid", "payment-refunded", "payment-used", "wrong-count", "rail-off", "no-key",
                     "rail-unreachable", "malformed", "too-many", "network", "device-cap", "store-failed", "payment-unverified",
                     "purchase-pending", "added"] {
            let s = PlanDisplay.shopOutcome(code, units: 30, .defaults)
            XCTAssertFalse(s.isEmpty)
            XCTAssertNotEqual(s, generic, code)
        }
    }

    func testDeviceCap() async {
        let r = await rig()
        let today = (clock / 86_400_000) * 86_400_000
        r.vault.records = [ShopPurchaseRecord(units: 120, day: today - 40 * 86_400_000), ShopPurchaseRecord(units: 120, day: today),
                           ShopPurchaseRecord(units: 115, day: today - 5 * 86_400_000)]
        XCTAssertEqual(r.shop.boughtRecently, 235)
        let refused = await r.center.buy(units: 10)
        XCTAssertFalse(refused)
        XCTAssertEqual(r.shop.outcome?.code, "device-cap")
        XCTAssertTrue(r.store.purchases.isEmpty, "The store is never asked.")
        XCTAssertTrue(PlanDisplay.shopOutcome("device-cap", units: 10, .defaults).contains("240"))
        r.vault.records.removeLast()
        let ok = await r.center.buy(units: 120)
        XCTAssertTrue(ok)
        XCTAssertFalse(r.vault.records.contains { $0.day < today - 31 * 86_400_000 }, "Old entries are dropped.")
    }

    func testOnlyAdminDevicesBuy() async {
        let r = await rig(admin: false)
        let ok = await r.center.buy(units: 10)
        XCTAssertFalse(ok)
        XCTAssertTrue(r.store.purchases.isEmpty)
        let t = r.store.add(productId: "com.flagshipserver.app.vouchers.10")
        let delivered = await r.shop.deliver(t)
        XCTAssertFalse(delivered)
        XCTAssertTrue(r.store.isOpen(t.id), "A non-admin device leaves it for an admin device.")
    }

    func testUpdatesAreDelivered() async throws {
        let r = await rig()
        let t = r.store.add(productId: "com.flagshipserver.app.vouchers.10")
        r.store.push(t)
        for _ in 0..<100 where r.store.isOpen(t.id) { try await Task.sleep(nanoseconds: 20_000_000) }
        XCTAssertFalse(r.store.isOpen(t.id))
        XCTAssertEqual(r.center.balanceUnits, 10)
    }

    func testPendingPurchaseIsLoggedAndExplained() async {
        let r = await rig()
        r.store.nextOutcome = "pending"
        _ = await r.center.buy(units: 30)
        XCTAssertEqual(r.shop.outcome?.code, "purchase-pending")
        XCTAssertEqual(r.vault.records.map(\.units), [30])
        r.store.nextOutcome = "cancelled"
        _ = await r.center.buy(units: 10)
        XCTAssertNil(r.shop.outcome)
        XCTAssertEqual(r.vault.records.map(\.units), [30])
    }

    // MARK: the config fields and the live client's wire

    func testConfigRailsAndProducts() {
        let off = PaymentsInfo.parse(["config": ["packs": [10, 30]]])
        XCTAssertEqual(off.rails, .off)
        XCTAssertEqual(off.products.map(\.productId), ["com.flagshipserver.app.vouchers.10", "com.flagshipserver.app.vouchers.30"])
        let on = PaymentsInfo.parse(["rails": ["stripe": true, "apple": true, "google": false],
                                     "products": [["units": 30, "productId": "com.flagshipserver.app.vouchers.30"],
                                                  ["units": 5, "productId": "com.flagshipserver.app.vouchers.6"]]])
        XCTAssertEqual(on.rails, PaymentRails(stripe: true, apple: true, google: false))
        XCTAssertEqual(on.products, [VoucherProduct(units: 30, productId: "com.flagshipserver.app.vouchers.30")])
        XCTAssertEqual(VoucherProducts.units(productId: "com.flagshipserver.app.vouchers.120"), 120)
        XCTAssertNil(VoucherProducts.units(productId: "com.flagshipserver.app.vouchers.010"))
        XCTAssertNil(VoucherProducts.units(productId: "com.other.vouchers.10"))
    }

    func testLivePaidIssueSendsNoCredentialAndDecodesRefusals() async throws {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [PaidIssueStub.self]
        let client = LivePaymentsComClient(session: URLSession(configuration: config), base: URL(string: "https://com.test")!, readTokens: nil)
        PaidIssueStub.answer = (200, #"{"k":"abcd","sigs":["AA==","AQ=="],"units":2}"#)
        let ok = try await client.paidIssue(rail: "apple", proof: ["jws": "a.b.c"], keyId: "abcd", blinded: ["x", "y"])
        XCTAssertEqual(ok, PaidIssueResult(k: "abcd", sigs: ["AA==", "AQ=="], units: 2))
        let req = try XCTUnwrap(PaidIssueStub.last)
        XCTAssertEqual(req.url?.path, "/api/vouchers/paid-issue")
        XCTAssertEqual(req.httpMethod, "POST")
        let headers = (req.allHTTPHeaderFields ?? [:]).keys.map { $0.lowercased() }
        XCTAssertFalse(headers.contains { $0 == "authorization" || $0 == "cookie" || $0.hasPrefix("x-flagship-") }, "\(headers)")
        let body = try XCTUnwrap(JSONValue.parse(utf8: Array(PaidIssueStub.lastBody)))
        XCTAssertEqual(body["rail"], "apple")
        XCTAssertEqual(body["proof"]?["jws"], "a.b.c")
        XCTAssertEqual(body["k"], "abcd")
        XCTAssertEqual(body["v"]?.safeInt, 1)
        XCTAssertNil(body["username"])
        PaidIssueStub.answer = (409, #"{"error":"x","code":"wrong-count","units":30}"#)
        do {
            _ = try await client.paidIssue(rail: "apple", proof: ["jws": "a.b.c"], keyId: "abcd", blinded: ["x"])
            XCTFail("refused")
        } catch let e as PaymentsComError {
            XCTAssertEqual(e.code, "wrong-count")
            XCTAssertEqual(e.units, 30)
        }
    }
}

final class PaidIssueStub: URLProtocol {
    nonisolated(unsafe) static var answer: (Int, String) = (200, "{}")
    nonisolated(unsafe) static var last: URLRequest?
    nonisolated(unsafe) static var lastBody = Data()

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.last = request
        if let b = request.httpBody { Self.lastBody = b } else if let s = request.httpBodyStream {
            s.open(); defer { s.close() }
            var d = Data(); var buf = [UInt8](repeating: 0, count: 4096)
            while s.hasBytesAvailable { let n = s.read(&buf, maxLength: buf.count); if n <= 0 { break }; d.append(buf, count: n) }
            Self.lastBody = d
        }
        let (status, body) = Self.answer
        let res = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: ["content-type": "application/json"])!
        client?.urlProtocol(self, didReceive: res, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}
