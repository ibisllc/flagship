import XCTest
import CryptoKit
@testable import FlagshipCore
@testable import FlagshipUI
@testable import FlagshipAPI

@MainActor
final class UpdateServerViewModelTests: XCTestCase {
    private let server = "home.alice.flagship.services"
    private let username = "alice"
    private let current = "1234567890abcdef1234567890abcdef12345678"
    private let target = "9f2c1ab3de4567890abcdef1234567890abcdef1"

    private func irk() -> Curve25519.Signing.PrivateKey {
        try! Curve25519.Signing.PrivateKey(rawRepresentation: Data(repeating: 9, count: 32))
    }
    private func adminRoot() -> Curve25519.Signing.PrivateKey {
        try! Curve25519.Signing.PrivateKey(rawRepresentation: Data(repeating: 7, count: 32))
    }

    private let store = PendingUpdateStore(defaults: UserDefaults(suiteName: "update-vm-\(UUID().uuidString)")!)

    private func vm(
        mailbox: MockSecretMailboxClient,
        currentCommit: String?,
        adminRoot root: Curve25519.Signing.PrivateKey? = nil,
        onSign: (() -> Void)? = nil,
        serverFqdn: String? = nil,
        now: Int64 = 1700
    ) -> UpdateServerViewModel {
        UpdateServerViewModel(
            username: username,
            serverFqdn: serverFqdn ?? server,
            currentCommit: currentCommit,
            mailbox: mailbox,
            signer: { _ in onSign?(); return self.irk() },
            adminRootKey: { _ in root },
            now: { now },
            pendingStore: store
        )
    }

    // MARK: - Gating

    func testCannotUpdateWithoutBoxReportedCommit() async {
        let mb = MockSecretMailboxClient()
        let m = vm(mailbox: mb, currentCommit: nil)
        XCTAssertFalse(m.canUpdate)
        await m.update(targetCommit: target)
        if case .failed = m.phase {} else { XCTFail("expected failed, got \(m.phase)") }
        XCTAssertTrue(mb.updateDeposits.isEmpty, "must never mint without a box-reported fromCommit")
    }

    func testRejectsMalformedTargetWithoutSigning() async {
        let mb = MockSecretMailboxClient()
        var signed = false
        let m = vm(mailbox: mb, currentCommit: current, onSign: { signed = true })
        await m.update(targetCommit: "deadbeef")
        if case .failed = m.phase {} else { XCTFail("expected failed") }
        XCTAssertFalse(signed, "must validate before prompting the biometric")
        XCTAssertTrue(mb.updateDeposits.isEmpty)
    }

    func testRejectsTargetEqualToCurrent() async {
        let mb = MockSecretMailboxClient()
        let m = vm(mailbox: mb, currentCommit: current)
        XCTAssertFalse(m.canOrder(current))
        await m.update(targetCommit: current)
        if case .failed = m.phase {} else { XCTFail("expected failed") }
        XCTAssertTrue(mb.updateDeposits.isEmpty)
    }

    // MARK: - Mint → sign → deposit

    func testUpdateMintsSignsAndDepositsVerifiableOrder_adminRoot() async {
        let mb = MockSecretMailboxClient()
        let root = adminRoot()
        let m = vm(mailbox: mb, currentCommit: current, adminRoot: root)
        let ok = await m.update(targetCommit: target.uppercased()) // input normalizes
        XCTAssertTrue(ok)
        XCTAssertEqual(m.phase, .done)
        XCTAssertEqual(mb.updateDeposits.count, 1)
        let dep = mb.updateDeposits[0]
        XCTAssertEqual(dep.serverDomain, server)
        let body = dep.body
        XCTAssertEqual(body.order.serverDomain, server)
        XCTAssertEqual(body.order.targetCommit, target)
        XCTAssertEqual(body.order.fromCommit, current, "fromCommit is the BOX-reported truth")
        XCTAssertEqual(body.order.issuedAt, 1700)

        // The order signature verifies under the ADMIN ROOT (Slice D), not the IRK.
        let order = ServerUpdateOrder(
            serverDomain: body.order.serverDomain,
            targetCommit: body.order.targetCommit,
            fromCommit: body.order.fromCommit,
            nonce: body.order.nonce,
            issuedAt: body.order.issuedAt
        )
        let sig = Data(HexUtil.decode(body.signature)!)
        XCTAssertTrue(order.verify(sig, with: root.publicKey))
        XCTAssertFalse(order.verify(sig, with: irk().publicKey))
        // The mailbox auth stays IRK-bound.
        XCTAssertEqual(body.auth.phoneIrkPub, HexUtil.encode(irk().publicKey.rawRepresentation))
    }

    func testUpdateSignsWithIrkWhenNoAdminRoot() async {
        let mb = MockSecretMailboxClient()
        let m = vm(mailbox: mb, currentCommit: current, adminRoot: nil)
        await m.update(targetCommit: target)
        XCTAssertEqual(m.phase, .done)
        let body = mb.updateDeposits[0].body
        let order = ServerUpdateOrder(
            serverDomain: body.order.serverDomain,
            targetCommit: body.order.targetCommit,
            fromCommit: body.order.fromCommit,
            nonce: body.order.nonce,
            issuedAt: body.order.issuedAt
        )
        let sig = Data(HexUtil.decode(body.signature)!)
        XCTAssertTrue(order.verify(sig, with: irk().publicKey))
    }

    func testDepositFailureSurfaces() async {
        let mb = MockSecretMailboxClient()
        mb.nextUpdateError = ScreensClientError.http(status: 403, message: "no")
        let m = vm(mailbox: mb, currentCommit: current)
        let ok = await m.update(targetCommit: target)
        XCTAssertFalse(ok)
        if case .failed = m.phase {} else { XCTFail("expected failed") }
        XCTAssertTrue(mb.updateDeposits.isEmpty)
    }

    // MARK: - Display helpers

    func testRunningShortAndTargetProblemCopy() {
        let m = vm(mailbox: MockSecretMailboxClient(), currentCommit: current)
        XCTAssertEqual(m.runningShort, "12345678")
        XCTAssertNil(m.targetProblem(""))
        XCTAssertNotNil(m.targetProblem("nothex"))
        XCTAssertNotNil(m.targetProblem(current))
        XCTAssertNil(m.targetProblem(target))
        XCTAssertTrue(m.canOrder(" \(target) "))
    }

    // MARK: - Pending order

    func testSuccessfulDepositRemembersPendingOrder() async {
        let mb = MockSecretMailboxClient()
        let m = vm(mailbox: mb, currentCommit: current)
        XCTAssertNil(store.load(serverFqdn: server))
        let ok = await m.update(targetCommit: target.uppercased(), targetTag: "v1.4.0")
        XCTAssertTrue(ok)
        XCTAssertEqual(
            store.load(serverFqdn: server),
            PendingUpdateOrder(targetCommit: target, targetTag: "v1.4.0", fromCommit: current, orderedAt: 1700)
        )
        XCTAssertEqual(store.load(serverFqdn: server.uppercased())?.targetCommit, target)
    }

    func testFailedDepositStoresNothing() async {
        let mb = MockSecretMailboxClient()
        mb.nextUpdateError = ScreensClientError.http(status: 403, message: "no")
        let m = vm(mailbox: mb, currentCommit: current)
        await m.update(targetCommit: target)
        XCTAssertNil(store.load(serverFqdn: server))
    }

    func testRejectedTargetStoresNothing() async {
        let m = vm(mailbox: MockSecretMailboxClient(), currentCommit: current)
        await m.update(targetCommit: current)
        XCTAssertNil(store.load(serverFqdn: server))
    }

    func testResendReplacesPendingOrderAndForgetClears() async {
        let mb = MockSecretMailboxClient()
        let old = PendingUpdateOrder(targetCommit: target, targetTag: "v1.4.0", fromCommit: current, orderedAt: 10)
        store.save(old, serverFqdn: server)
        let m = vm(mailbox: mb, currentCommit: current, now: 5_000_000)
        let ok = await m.resend(old)
        XCTAssertTrue(ok)
        XCTAssertEqual(mb.updateDeposits.count, 1)
        XCTAssertEqual(mb.updateDeposits[0].body.order.targetCommit, target)
        XCTAssertEqual(store.load(serverFqdn: server)?.orderedAt, 5_000_000)
        XCTAssertEqual(store.load(serverFqdn: server)?.targetTag, "v1.4.0")
        m.forgetPending()
        XCTAssertNil(store.load(serverFqdn: server))
    }

    func testPendingOrderIsPerServer() async {
        let other = "work.alice.flagship.services"
        let m = vm(mailbox: MockSecretMailboxClient(), currentCommit: current)
        await m.update(targetCommit: target)
        XCTAssertNotNil(store.load(serverFqdn: server))
        XCTAssertNil(store.load(serverFqdn: other))
        vm(mailbox: MockSecretMailboxClient(), currentCommit: current, serverFqdn: other).forgetPending()
        XCTAssertNotNil(store.load(serverFqdn: server), "forgetting one server leaves the other's order")
    }
}
