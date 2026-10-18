import XCTest
import CryptoKit
@testable import FlagshipAPI
@testable import FlagshipCore
@testable import FlagshipUI

/// Delete server: typed-name gate, one key fetch, erase order (best-effort)
/// BEFORE the name release, and the release as the point of no return.
@MainActor
final class DeleteServerViewModelTests: XCTestCase {
    private let fqdn = "home2.harry.flagship.services"
    private let stkHex = String(repeating: "ab", count: 32)
    private let now: Int64 = 1_700_000_000_000

    private func orderKey() -> Curve25519.Signing.PrivateKey {
        try! Curve25519.Signing.PrivateKey(rawRepresentation: Data(repeating: 7, count: 32))
    }
    private func irk() -> Curve25519.Signing.PrivateKey {
        try! Curve25519.Signing.PrivateKey(rawRepresentation: Data(repeating: 9, count: 32))
    }

    private struct Harness {
        let vm: DeleteServerViewModel
        let server: MockFlagshipServerClient
        let mailbox: MockSecretMailboxClient
        let deleted: () -> Int
        let keyCalls: () -> Int
    }

    private func harness(identity: String? = nil, adminRoot: Bool = true) -> Harness {
        let server = MockFlagshipServerClient()
        server.simulatedLatency = 0
        let mailbox = MockSecretMailboxClient()
        var deleted = 0
        var keyCalls = 0
        let order = orderKey()
        let mailboxIrk = adminRoot ? irk() : order
        let vm = DeleteServerViewModel(
            server: server,
            mailbox: mailbox,
            serverFqdn: fqdn,
            identityPubKeyHex: identity ?? stkHex,
            username: { "harry" },
            onDeleted: { deleted += 1 },
            keys: { _ in
                keyCalls += 1
                return .init(orderKey: order, mailboxIrk: mailboxIrk)
            },
            now: { self.now },
            randomNonce: { Data(repeating: 1, count: 32) }
        )
        return Harness(vm: vm, server: server, mailbox: mailbox, deleted: { deleted }, keyCalls: { keyCalls })
    }

    // MARK: - Typed-name gate

    func testConfirmationMatchesServerLabelCaseInsensitivelyAndTrimmed() {
        XCTAssertEqual(DeleteServerViewModel.serverLabel(forFqdn: "Home2.harry.flagship.services"), "home2")
        XCTAssertTrue(DeleteServerViewModel.confirmationMatches("home2", serverLabel: "home2"))
        XCTAssertTrue(DeleteServerViewModel.confirmationMatches("  HOME2 \n", serverLabel: "home2"))
        XCTAssertFalse(DeleteServerViewModel.confirmationMatches("home", serverLabel: "home2"))
        XCTAssertFalse(DeleteServerViewModel.confirmationMatches(fqdn, serverLabel: "home2"), "the label, not the FQDN")
        XCTAssertFalse(DeleteServerViewModel.confirmationMatches("", serverLabel: ""))
    }

    func testWrongNameSignsNothing() async {
        let h = harness()
        await h.vm.run(typedName: "home")
        guard case .failed = h.vm.phase else { return XCTFail("expected failure, got \(h.vm.phase)") }
        XCTAssertEqual(h.keyCalls(), 0, "no biometric before the name is typed")
        XCTAssertTrue(h.mailbox.decommissionDeposits.isEmpty)
        XCTAssertTrue(h.server.releasedServerNames.isEmpty)
        XCTAssertEqual(h.deleted(), 0)
    }

    // MARK: - Happy path

    func testDepositsEraseOrderThenReleasesNameWithOneKeyFetch() async throws {
        let h = harness()
        await h.vm.run(typedName: "Home2")
        XCTAssertEqual(h.vm.phase, .completed(eraseRequested: true))
        XCTAssertEqual(h.keyCalls(), 1, "one biometric for the whole flow")
        XCTAssertEqual(h.deleted(), 1)

        let deposit = try XCTUnwrap(h.mailbox.decommissionDeposits.first)
        XCTAssertEqual(deposit.serverDomain, fqdn)
        let o = deposit.body.order
        XCTAssertEqual(o.podCanonical, fqdn)
        XCTAssertEqual(o.retiredStkPubHex, stkHex)
        XCTAssertFalse(o.finalBackup)
        XCTAssertEqual(o.diskDisposition, "wipe-now")
        XCTAssertEqual(o.backupEpoch, 0)
        XCTAssertEqual(o.nonce, String(repeating: "01", count: 32))
        XCTAssertEqual(o.issuedAt, now)
        let order = ServerDecommissionOrder(
            podCanonical: o.podCanonical, retiredStkPubHex: o.retiredStkPubHex,
            finalBackup: o.finalBackup, diskDisposition: o.diskDisposition,
            backupEpoch: o.backupEpoch, nonce: o.nonce, issuedAt: o.issuedAt
        )
        let orderSig = try XCTUnwrap(HexUtil.decode(deposit.body.signature))
        XCTAssertTrue(order.verify(orderSig, with: orderKey().publicKey), "erase order is signed by the sensitive-order key")
        XCTAssertEqual(deposit.body.auth.username, "harry")
        XCTAssertEqual(deposit.body.auth.phoneIrkPub, HexUtil.encode(irk().publicKey.rawRepresentation),
                       "the deposit's mailbox auth is the IRK even when the order key is the admin root")

        let release = try XCTUnwrap(h.server.releasedServerNames.first)
        XCTAssertEqual(release.request.username, "harry")
        XCTAssertEqual(release.request.serverDomain, fqdn)
        let releaseSig = try XCTUnwrap(HexUtil.decode(release.signature))
        XCTAssertTrue(orderKey().publicKey.isValidSignature(
            releaseSig,
            for: ReleaseServerName.canonicalBytes(username: "harry", serverDomain: fqdn, issuedAt: release.request.issuedAt)
        ))
    }

    func testDepositFailureStillDeletes() async {
        let h = harness()
        h.mailbox.nextDecommissionError = ScreensClientError.http(status: 500, message: "boom")
        await h.vm.run(typedName: "home2")
        XCTAssertEqual(h.vm.phase, .completed(eraseRequested: false))
        XCTAssertEqual(h.server.releasedServerNames.count, 1)
        XCTAssertEqual(h.deleted(), 1)
    }

    /// The release fails, yet the erase order is already deposited: the
    /// deposit runs first. The pod is kept because the name is still reserved.
    func testReleaseFailureKeepsPodAfterDeposit() async {
        let h = harness()
        h.server.shouldFail = true
        await h.vm.run(typedName: "home2")
        guard case .failed(let msg) = h.vm.phase else { return XCTFail("expected failure, got \(h.vm.phase)") }
        XCTAssertTrue(msg.contains("still reserved"), msg)
        XCTAssertEqual(h.mailbox.decommissionDeposits.count, 1, "erase order goes out before the release")
        XCTAssertEqual(h.deleted(), 0)
    }

    /// The refusal's own sentence reaches the screen, not a claim about the connection.
    func testReleaseRefusalShowsTheReason() async {
        let h = harness()
        h.server.releaseError = ScreensClientError.http(status: 409, message: #"{"error":"That server is mid-update."}"#)
        await h.vm.run(typedName: "home2")
        guard case .failed(let msg) = h.vm.phase else { return XCTFail("expected failure, got \(h.vm.phase)") }
        XCTAssertTrue(msg.contains("That server is mid-update."), msg)
        XCTAssertFalse(msg.lowercased().contains("check your connection"), msg)
    }

    /// A row that names no `<server>.<user>` holds no name: removed without a call or a key.
    func testGhostRowIsRemovedWithoutACall() async {
        let server = MockFlagshipServerClient()
        server.simulatedLatency = 0
        var deleted = 0
        var keyCalls = 0
        let vm = DeleteServerViewModel(
            server: server, mailbox: MockSecretMailboxClient(),
            serverFqdn: "server.flagship.services", identityPubKeyHex: "",
            username: { "harry" }, onDeleted: { deleted += 1 },
            keys: { _ in keyCalls += 1; return .init(orderKey: self.orderKey(), mailboxIrk: nil) }
        )
        await vm.run(typedName: "server")
        XCTAssertEqual(vm.phase, .completed(eraseRequested: nil))
        XCTAssertEqual(deleted, 1)
        XCTAssertEqual(keyCalls, 0)
        XCTAssertTrue(server.releasedServerNames.isEmpty)
    }

    func testNoRegisteredIdentitySkipsEraseOrder() async {
        let h = harness(identity: "")
        await h.vm.run(typedName: "home2")
        XCTAssertEqual(h.vm.phase, .completed(eraseRequested: nil))
        XCTAssertTrue(h.mailbox.decommissionDeposits.isEmpty)
        XCTAssertEqual(h.server.releasedServerNames.count, 1)
    }

    func testCompletionCopy() {
        XCTAssertEqual(
            DeleteServerViewModel.completionMessage(name: "home2", eraseRequested: true),
            "Deleted home2. If it's online it will erase itself and power off."
        )
        XCTAssertEqual(
            DeleteServerViewModel.completionMessage(name: "home2", eraseRequested: false),
            "Deleted home2. It couldn't be asked to erase itself."
        )
        XCTAssertEqual(DeleteServerViewModel.completionMessage(name: "home2", eraseRequested: nil), "Deleted home2.")
    }
}
