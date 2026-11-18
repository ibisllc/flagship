import XCTest
import FlagshipAPI
import FlagshipCore
@testable import FlagshipUI

/// "Load into Flagship" (docs/anonymous-vouchers.md "Voucher links" → Failure handling): a link opened on the phone is
/// checked and added with no network call, once.
@MainActor
final class VoucherLinkCenterTests: XCTestCase {
    private var clock: Int64 = 1_795_000_000_000
    private let device: VoiciDeviceSigner = { _, _ in
        AccountDirectoryAuthorization(deviceId: "d1", signerPubHex: String(repeating: "a", count: 64), requestId: "r", issuedAt: 1, signatureHex: "s")
    }

    private func center(_ m: MockPaymentsComClient, defaults: UserDefaults, admin: Bool = true) -> PaymentsCenter {
        let device = self.device
        let c = PaymentsCenter(defaults: defaults) { u in
            .init(username: u, isAdmin: admin, umk: { [UInt8](repeating: 7, count: 32) }, device: device)
        }
        c.now = { [unowned self] in self.clock }
        c.random = { 0.25 }
        c.configure(client: m, username: "plucky-avocet", deviceId: "d1")
        return c
    }

    private func mock() -> MockPaymentsComClient {
        let m = MockPaymentsComClient()
        m.now = { [unowned self] in self.clock }
        return m
    }

    private func link(_ vs: [Voucher]) throws -> String { try VoucherLink.encodeLinks(vs, apex: "flagshipserver.com")[0] }

    func testOfflineAddThenSecondOpenAddsNothing() async throws {
        let m = mock()
        let defaults = UserDefaults(suiteName: UUID().uuidString)!
        await center(m, defaults: defaults).refreshAndTick()   // online once: the keys are remembered
        let l = try link(try m.makeVouchers(3))

        // A cold start with no network: the keys and the wallet copy come from this phone.
        m.failAll = "network"
        let c = center(m, defaults: defaults)
        guard case let .confirm(plan, part, parts) = c.reviewVoucherLink(l) else { return XCTFail("expected a confirm") }
        XCTAssertEqual(plan.add.count, 3)
        XCTAssertEqual(part, 1)
        XCTAssertEqual(parts, 1)
        let added = await c.addVoucherLink(plan)
        XCTAssertTrue(added)
        XCTAssertEqual(c.balanceUnits, 3)
        XCTAssertEqual(c.reviewVoucherLink(l), .refuse(.already))

        // Back online: the next refresh sends the wallet that was kept here.
        m.failAll = nil
        await c.refreshAndTick()
        let synced = VoucherWalletSync.open(key: VoucherWalletSync.deriveKey(umk: [UInt8](repeating: 7, count: 32)), blob: m.wallets["plucky-avocet"])
        XCTAssertEqual(synced?.balance, 3)
        XCTAssertEqual(c.reviewVoucherLink(l), .refuse(.already))
    }

    func testForgedSpentDamagedAndNotAdmin() async throws {
        let m = mock()
        let c = center(m, defaults: UserDefaults(suiteName: UUID().uuidString)!)
        await c.refreshAndTick()
        let vs = try m.makeVouchers(3)

        var forged = vs[0]
        var sig = CanonicalJson.b64Decode(forged.s)!
        sig[10] ^= 1
        forged.s = CanonicalJson.b64Encode(sig)
        XCTAssertEqual(c.reviewVoucherLink(try link([forged])), .refuse(.invalid))

        let l = try link(vs)
        XCTAssertEqual(c.reviewVoucherLink(String(l.dropLast(40))), .refuse(.damaged))
        guard case let .confirm(plan, _, _) = c.reviewVoucherLink(l) else { return XCTFail("expected a confirm") }
        _ = await c.addVoucherLink(plan)
        _ = await c.choosePlan(.pro, delayStart: false)      // spends one of the three
        XCTAssertEqual(c.balanceUnits, 2)
        // Two are in the wallet and one was spent from it: nothing to add, and the screen says they were spent.
        XCTAssertEqual(c.reviewVoucherLink(l), .refuse(.spent))
    }

    func testSpentOnlyLinkSaysSpent() async throws {
        let m = mock()
        let c = center(m, defaults: UserDefaults(suiteName: UUID().uuidString)!)
        await c.refreshAndTick()
        let vs = try m.makeVouchers(1)
        guard case let .confirm(plan, _, _) = c.reviewVoucherLink(try link(vs)) else { return XCTFail("expected a confirm") }
        _ = await c.addVoucherLink(plan)
        _ = await c.choosePlan(.pro, delayStart: false)
        XCTAssertEqual(c.balanceUnits, 0)
        XCTAssertEqual(c.reviewVoucherLink(try link(vs)), .refuse(.spent))
    }

    func testNotAdminAndSignedOut() async throws {
        let m = mock()
        let viewer = center(m, defaults: UserDefaults(suiteName: UUID().uuidString)!, admin: false)
        await viewer.refreshAndTick()
        let l = try link(try m.makeVouchers(1))
        XCTAssertEqual(viewer.reviewVoucherLink(l), .refuse(.notAdmin))
        let nobody = PaymentsCenter(defaults: UserDefaults(suiteName: UUID().uuidString)!)
        XCTAssertEqual(nobody.reviewVoucherLink(l), .refuse(.signedOut))
    }

    func testRoutingAndNoScanEntry() throws {
        let m = mock()
        let l = try link(try m.makeVouchers(1))
        guard case .voucherLink = DeepLink.parse(URL(string: l)!) else { return XCTFail("the app link must route to the voucher screen") }
        guard case .voucherLink = DeepLink.parse(URL(string: "https://flagshipserver.com/app/vouchers#v=AAAA")!) else {
            return XCTFail("a damaged link still opens the screen that says so")
        }
        // Never through the scanner or the link field (App Review 3.1.1).
        XCTAssertNil(ScanOrLinkScreen.link(from: l))
        XCTAssertEqual(VoucherLinkScreen.sentence(.damaged), "This voucher link is incomplete or damaged. Open the whole link again, or use the voucher file.")
    }
}
