import XCTest
import CryptoKit
@testable import FlagshipCore
@testable import FlagshipUI
@testable import FlagshipAPI

@MainActor
final class ReplaceServerViewModelTests: XCTestCase {
    private let server = "home.alice.flagship.services"
    private let username = "alice"
    private let stkHex = String(repeating: "ab", count: 32) // 32-byte hex

    private func key() -> Curve25519.Signing.PrivateKey {
        try! Curve25519.Signing.PrivateKey(rawRepresentation: Data(repeating: 9, count: 32))
    }

    /// A mock mailbox whose directory carries this box's STK.
    private func mailboxWithDirectory() -> MockSecretMailboxClient {
        let mb = MockSecretMailboxClient()
        mb.directory = [PodDirectoryEntry(serverDomain: server, identityPubKey: stkHex)]
        return mb
    }

    private func enrolledBackupScreens() -> MockScreensClient {
        let s = MockScreensClient()
        s.peerBackupStatusFixture = PeerBackupStatusResponse(
            participating: true,
            peersBackingYouUp: [PeerBackupPeerHostingYou(peerFqdn: "peer.bob.flagship.services", shardsHosted: 3, lastSeenMs: 1, online: true)],
            peersYouBackUp: [],
            shards: [],
            repair: PeerBackupRepairStatus(state: "idle", lastTickMs: nil, queued: 0, completed24h: 0, lastError: nil),
            stats: PeerBackupStats(total: 3, durable: 3, atRisk: 0, yourBytesStored: 100, peerBytesHosted: 0)
        )
        return s
    }

    // MARK: - Pre-flight backup gate

    func testPreflightWithEnrolledBackupGoesReady() async {
        let vm = ReplaceServerViewModel(
            mailbox: mailboxWithDirectory(), screens: enrolledBackupScreens(),
            serverFqdn: server, username: username, onRetired: {}, signer: { _ in self.key() }
        )
        await vm.preflight()
        XCTAssertEqual(vm.phase, .ready)
        XCTAssertFalse(vm.backupMissing)
    }

    func testPreflightWithNoBackupGatesHard() async {
        // Default mock screens returns participating:false → gate.
        let vm = ReplaceServerViewModel(
            mailbox: mailboxWithDirectory(), screens: MockScreensClient(),
            serverFqdn: server, username: username, onRetired: {}, signer: { _ in self.key() }
        )
        await vm.preflight()
        XCTAssertEqual(vm.phase, .backupGate)
        XCTAssertTrue(vm.backupMissing)
    }

    func testParticipatingButNoPeersStillGates() async {
        let s = MockScreensClient()
        s.peerBackupStatusFixture = PeerBackupStatusResponse(
            participating: true, peersBackingYouUp: [], peersYouBackUp: [], shards: [],
            repair: PeerBackupRepairStatus(state: "idle", lastTickMs: nil, queued: 0, completed24h: 0, lastError: nil),
            stats: PeerBackupStats(total: 0, durable: 0, atRisk: 0, yourBytesStored: 0, peerBytesHosted: 0)
        )
        let vm = ReplaceServerViewModel(
            mailbox: mailboxWithDirectory(), screens: s,
            serverFqdn: server, username: username, onRetired: {}, signer: { _ in self.key() }
        )
        await vm.preflight()
        XCTAssertEqual(vm.phase, .backupGate)
    }

    // MARK: - Mint → sign → deposit body

    func testReplaceMintsSignsAndDepositsVerifiableOrder() async {
        let mb = mailboxWithDirectory()
        let k = key()
        var retired = false
        let vm = ReplaceServerViewModel(
            mailbox: mb, screens: enrolledBackupScreens(),
            serverFqdn: server, username: username,
            onRetired: { retired = true }, signer: { _ in k },
            now: { 1700 }, randomNonce: { Data(repeating: 7, count: 32) }
        )
        await vm.preflight()
        await vm.replace(disposition: .wipeAfterHandoff)

        XCTAssertEqual(vm.phase, .completed(.wipeAfterHandoff))
        XCTAssertEqual(mb.decommissionDeposits.count, 1)
        let dep = mb.decommissionDeposits[0]
        XCTAssertEqual(dep.serverDomain, server)
        let body = dep.body
        XCTAssertEqual(body.order.podCanonical, server)
        XCTAssertEqual(body.order.retiredStkPubHex, stkHex)
        XCTAssertEqual(body.order.diskDisposition, "wipe-after-handoff")
        XCTAssertTrue(body.order.finalBackup, "wipe-after-handoff with a backup flushes a final epoch")
        XCTAssertEqual(body.order.backupEpoch, 1700)
        XCTAssertEqual(body.order.issuedAt, 1700)

        // The deposited signature verifies against the EXACT canonical bytes the
        // backend re-derives (lowercased pod/stk/nonce).
        let order = ServerDecommissionOrder(
            podCanonical: body.order.podCanonical,
            retiredStkPubHex: body.order.retiredStkPubHex,
            finalBackup: body.order.finalBackup,
            diskDisposition: body.order.diskDisposition,
            backupEpoch: body.order.backupEpoch,
            nonce: body.order.nonce,
            issuedAt: body.order.issuedAt
        )
        let sig = Data(HexUtil.decode(body.signature)!)
        XCTAssertTrue(k.publicKey.isValidSignature(sig, for: order.canonicalBytes()))

        // L3 — the box instance was retired locally on success.
        XCTAssertTrue(retired)
    }

    func testKeepDispositionDoesNotFinalBackup() async {
        let mb = mailboxWithDirectory()
        let vm = ReplaceServerViewModel(
            mailbox: mb, screens: enrolledBackupScreens(),
            serverFqdn: server, username: username, onRetired: {}, signer: { _ in self.key() }
        )
        await vm.preflight()
        await vm.replace(disposition: .keep)
        XCTAssertEqual(mb.decommissionDeposits.count, 1)
        XCTAssertFalse(mb.decommissionDeposits[0].body.order.finalBackup, "keep has nothing to flush")
    }

    // MARK: - Gate backstop + L3

    func testNoBackupBlocksNonWipeNow() async {
        let mb = mailboxWithDirectory()
        var retired = false
        let vm = ReplaceServerViewModel(
            mailbox: mb, screens: MockScreensClient(),
            serverFqdn: server, username: username,
            onRetired: { retired = true }, signer: { _ in self.key() }
        )
        await vm.preflight() // → backupGate
        await vm.replace(disposition: .wipeAfterHandoff)
        if case .failed = vm.phase {} else { XCTFail("expected failed gate, got \(vm.phase)") }
        XCTAssertTrue(mb.decommissionDeposits.isEmpty, "must not deposit when gated")
        XCTAssertFalse(retired, "L3 must not fire when nothing was deposited")
    }

    func testNoBackupAllowsWipeNowAcceptLoss() async {
        let mb = mailboxWithDirectory()
        let vm = ReplaceServerViewModel(
            mailbox: mb, screens: MockScreensClient(),
            serverFqdn: server, username: username, onRetired: {}, signer: { _ in self.key() }
        )
        await vm.preflight() // → backupGate
        await vm.replace(disposition: .wipeNow)
        XCTAssertEqual(vm.phase, .completed(.wipeNow))
        XCTAssertEqual(mb.decommissionDeposits.count, 1)
        // No backup → nothing to flush even on wipe-now.
        XCTAssertFalse(mb.decommissionDeposits[0].body.order.finalBackup)
    }

    func testDepositFailureSurfacesAndDoesNotRetire() async {
        let mb = mailboxWithDirectory()
        mb.nextDecommissionError = ScreensClientError.http(status: 403, message: "no")
        var retired = false
        let vm = ReplaceServerViewModel(
            mailbox: mb, screens: enrolledBackupScreens(),
            serverFqdn: server, username: username,
            onRetired: { retired = true }, signer: { _ in self.key() }
        )
        await vm.preflight()
        await vm.replace(disposition: .wipeAfterHandoff)
        if case .failed = vm.phase {} else { XCTFail("expected failed") }
        XCTAssertFalse(retired, "L3 must not fire on a failed deposit")
    }

    func testUnknownBoxInDirectoryFailsWithoutSigning() async {
        let mb = MockSecretMailboxClient() // empty directory
        var signed = false
        let vm = ReplaceServerViewModel(
            mailbox: mb, screens: enrolledBackupScreens(),
            serverFqdn: server, username: username, onRetired: {},
            signer: { _ in signed = true; return self.key() }
        )
        await vm.preflight()
        await vm.replace(disposition: .wipeAfterHandoff)
        if case .failed = vm.phase {} else { XCTFail("expected failed") }
        XCTAssertFalse(signed, "must resolve the STK before prompting the biometric")
        XCTAssertTrue(mb.decommissionDeposits.isEmpty)
    }
}
