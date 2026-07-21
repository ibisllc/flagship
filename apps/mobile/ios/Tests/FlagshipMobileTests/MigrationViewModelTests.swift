import XCTest
import CryptoKit
@testable import FlagshipCore
@testable import FlagshipUI
@testable import FlagshipAPI

/// "Migrate to new hardware" orchestrator (docs/server-migration.md): the
/// initiate ceremony (STK from the directory, backup gate, admin-signed order
/// + SWK hold), the timeline poll, the one-tap hand-off (confirm-ready +
/// freeze under one ceremony, freeze-only retry from `ready`), and abort.
@MainActor
final class MigrationViewModelTests: XCTestCase {
    private let server = "home.alice.flagship.services"
    private let username = "alice"
    private let stkHex = String(repeating: "ab", count: 32)

    private func irk() -> Curve25519.Signing.PrivateKey {
        try! Curve25519.Signing.PrivateKey(rawRepresentation: Data(repeating: 9, count: 32))
    }
    private func adminRoot() -> Curve25519.Signing.PrivateKey {
        try! Curve25519.Signing.PrivateKey(rawRepresentation: Data(repeating: 5, count: 32))
    }

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

    private func freshHoldStore() -> MigrationHoldStore {
        let suite = "flagship.migrationHold.tests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defaults.removePersistentDomain(forName: suite)
        return MigrationHoldStore(defaults: defaults)
    }

    private func session(
        phase: String,
        newServerDomain: String? = nil,
        takenOverAt: Int64? = nil,
        abortedAt: Int64? = nil,
        oldClosedOutAt: Int64? = nil,
        done: Bool = false
    ) -> MigrationSession {
        MigrationSession(
            serverDomain: server, phase: phase,
            disposition: "wipe-after-handoff", oldStkPubHex: stkHex,
            newServerDomain: newServerDomain,
            initiatedAt: 1, takenOverAt: takenOverAt, abortedAt: abortedAt,
            oldClosedOutAt: oldClosedOutAt, done: done
        )
    }

    private func makeVM(
        migration: MockServerMigrationClient,
        mailbox: MockSecretMailboxClient? = nil,
        screens: MockScreensClient? = nil,
        holdStore: MigrationHoldStore? = nil,
        orderKey: Curve25519.Signing.PrivateKey? = nil,
        onSign: (@MainActor () -> Void)? = nil
    ) -> MigrationViewModel {
        let irk = irk()
        return MigrationViewModel(
            migration: migration,
            mailbox: mailbox ?? mailboxWithDirectory(),
            screens: screens ?? enrolledBackupScreens(),
            serverFqdn: server,
            username: username,
            holdStore: holdStore ?? freshHoldStore(),
            signer: { _ in onSign?(); return (irk, orderKey) },
            now: { 1700 },
            randomNonce: { Data(repeating: 7, count: 32) }
        )
    }

    // MARK: - Load

    func testLoadWithNoSessionResolvesStkAndBackupAndOffersInitiate() async {
        let vm = makeVM(migration: MockServerMigrationClient())
        await vm.load()
        XCTAssertEqual(vm.mode, .initiate)
        XCTAssertEqual(vm.oldStkPubHex, stkHex)
        XCTAssertFalse(vm.backupMissing)
        XCTAssertEqual(vm.disposition, .wipeAfterHandoff, "wipe-after-handoff is the default")
        XCTAssertFalse(vm.startBlocked)
    }

    func testLoadWithLiveSessionShowsProgress() async {
        let migration = MockServerMigrationClient()
        migration.session = session(phase: "provisioned", newServerDomain: "attic.alice.flagship.services")
        let vm = makeVM(migration: migration)
        await vm.load()
        XCTAssertEqual(vm.mode, .progress)
        XCTAssertEqual(vm.steps.count, 8)
        XCTAssertTrue(vm.canAbort)
    }

    func testLoadWithUnknownBoxFails() async {
        let vm = makeVM(migration: MockServerMigrationClient(), mailbox: MockSecretMailboxClient())
        await vm.load()
        if case .failed = vm.mode {} else { XCTFail("expected failed, got \(vm.mode)") }
    }

    func testUnreadableBackupSignalGatesConservatively() async {
        // Default mock screens: participating:false ⇒ backup missing ⇒ the
        // default wipe-after-handoff disposition is blocked; keep is not.
        let vm = makeVM(migration: MockServerMigrationClient(), screens: MockScreensClient())
        await vm.load()
        XCTAssertEqual(vm.mode, .initiate)
        XCTAssertTrue(vm.backupMissing)
        XCTAssertTrue(vm.startBlocked)
        vm.disposition = .keep
        XCTAssertFalse(vm.startBlocked, "keep leaves the old disk as the fallback copy")
    }

    // MARK: - Initiate

    func testStartDepositsAdminSignedOrderAndSetsHold() async {
        let migration = MockServerMigrationClient()
        let holds = freshHoldStore()
        let admin = adminRoot()
        let vm = makeVM(migration: migration, holdStore: holds, orderKey: admin)
        await vm.load()
        await vm.start()

        XCTAssertEqual(migration.starts.count, 1)
        let body = migration.starts[0].body
        XCTAssertEqual(body.order.serverDomain, server)
        XCTAssertEqual(body.order.oldStkPubHex, stkHex, "oldStk = the pod's current directory identity")
        XCTAssertEqual(body.order.diskDisposition, "wipe-after-handoff")
        XCTAssertEqual(body.order.nonce.count, 64)
        XCTAssertEqual(body.order.issuedAt, 1700)

        // Admin-root signature over the exact canonical bytes `.com` re-derives.
        let order = ServerMigrationOrder(
            serverDomain: body.order.serverDomain,
            oldStkPubHex: body.order.oldStkPubHex,
            diskDisposition: body.order.diskDisposition,
            nonce: body.order.nonce,
            issuedAt: body.order.issuedAt
        )
        XCTAssertTrue(order.verify(Data(HexUtil.decode(body.signature)!), with: admin.publicKey))

        // The SWK hold makes the next added pod's deposit migration-aware.
        XCTAssertTrue(holds.hasHold(for: server))
        XCTAssertEqual(vm.mode, .progress)
    }

    func testStartBlockedByBackupGateDoesNotSignOrDeposit() async {
        let migration = MockServerMigrationClient()
        var signed = false
        let vm = makeVM(migration: migration, screens: MockScreensClient(), onSign: { signed = true })
        await vm.load()
        await vm.start()
        XCTAssertTrue(migration.starts.isEmpty, "gate blocks the deposit")
        XCTAssertFalse(signed, "gate blocks BEFORE the biometric")
        XCTAssertNotNil(vm.errorMessage)
        XCTAssertEqual(vm.mode, .initiate)
    }

    func testStartFailureSurfacesWithoutHold() async {
        let migration = MockServerMigrationClient()
        migration.nextStartError = ScreensClientError.http(status: 409, message: "a migration is already in progress for this server")
        let holds = freshHoldStore()
        let vm = makeVM(migration: migration, holdStore: holds)
        await vm.load()
        await vm.start()
        XCTAssertNotNil(vm.errorMessage)
        XCTAssertFalse(holds.hasHold(for: server), "no hold when the deposit was refused")
        XCTAssertEqual(vm.mode, .initiate)
    }

    // MARK: - Hand off (confirm-ready + freeze, ONE ceremony)

    func testHandOffFromPreSeededSignsConfirmThenFreezeUnderOneCeremony() async {
        let migration = MockServerMigrationClient()
        migration.session = session(phase: "pre-seeded", newServerDomain: "attic.alice.flagship.services")
        let admin = adminRoot()
        var ceremonies = 0
        let vm = makeVM(migration: migration, orderKey: admin, onSign: { ceremonies += 1 })
        await vm.load()
        await vm.handOff()

        XCTAssertEqual(ceremonies, 1, "two signatures, ONE biometric ceremony")
        XCTAssertEqual(migration.confirms.count, 1)
        XCTAssertEqual(migration.freezes.count, 1)

        let confirm = migration.confirms[0].body
        XCTAssertEqual(confirm.control.action, "confirm-ready")
        let control = ServerMigrationControl(
            serverDomain: confirm.control.serverDomain,
            action: confirm.control.action,
            nonce: confirm.control.nonce,
            issuedAt: confirm.control.issuedAt
        )
        XCTAssertTrue(control.verify(Data(HexUtil.decode(confirm.signature)!), with: admin.publicKey))

        // The freeze IS the existing decommission deposit, session-constrained:
        // targets the session's old STK, finalBackup forced, disposition matches.
        let freeze = migration.freezes[0].body
        XCTAssertEqual(freeze.order.podCanonical, server)
        XCTAssertEqual(freeze.order.retiredStkPubHex, stkHex)
        XCTAssertTrue(freeze.order.finalBackup)
        XCTAssertEqual(freeze.order.diskDisposition, "wipe-after-handoff")
        let decommission = ServerDecommissionOrder(
            podCanonical: freeze.order.podCanonical,
            retiredStkPubHex: freeze.order.retiredStkPubHex,
            finalBackup: freeze.order.finalBackup,
            diskDisposition: freeze.order.diskDisposition,
            backupEpoch: freeze.order.backupEpoch,
            nonce: freeze.order.nonce,
            issuedAt: freeze.order.issuedAt
        )
        XCTAssertTrue(decommission.verify(Data(HexUtil.decode(freeze.signature)!), with: admin.publicKey))
    }

    func testHandOffFromReadyIsFreezeOnlyRetry() async {
        let migration = MockServerMigrationClient()
        migration.session = session(phase: "ready", newServerDomain: "attic.alice.flagship.services")
        let vm = makeVM(migration: migration)
        await vm.load()
        await vm.handOff()
        XCTAssertTrue(migration.confirms.isEmpty, "ready ⇒ confirm already landed; retry the freeze alone")
        XCTAssertEqual(migration.freezes.count, 1)
    }

    func testHandOffFreezeFailureSurfacesAfterConfirmLanded() async {
        let migration = MockServerMigrationClient()
        migration.session = session(phase: "pre-seeded", newServerDomain: "attic.alice.flagship.services")
        migration.nextFreezeError = ScreensClientError.http(status: 409, message: "freeze requires a ready migration")
        let vm = makeVM(migration: migration)
        await vm.load()
        await vm.handOff()
        XCTAssertEqual(migration.confirms.count, 1)
        XCTAssertTrue(migration.freezes.isEmpty)
        XCTAssertNotNil(vm.errorMessage, "the next poll shows `ready` and the button retries the freeze alone")
    }

    // MARK: - Abort

    func testAbortDepositsControlAndClearsHold() async {
        let migration = MockServerMigrationClient()
        migration.session = session(phase: "provisioned", newServerDomain: "attic.alice.flagship.services")
        let holds = freshHoldStore()
        holds.setHold(for: server)
        let vm = makeVM(migration: migration, holdStore: holds)
        await vm.load()
        XCTAssertTrue(vm.canAbort)
        await vm.abort()
        XCTAssertEqual(migration.aborts.count, 1)
        XCTAssertEqual(migration.aborts[0].body.control.action, "abort")
        XCTAssertFalse(holds.hasHold(for: server))
    }

    func testNoAbortAfterTakeOver() async {
        let migration = MockServerMigrationClient()
        migration.session = session(phase: "taken-over", newServerDomain: "attic.alice.flagship.services", takenOverAt: 9)
        let vm = makeVM(migration: migration)
        await vm.load()
        XCTAssertFalse(vm.canAbort, "take-over is the point of no return")
    }

    // MARK: - Terminal states clear the hold

    func testRefreshOnTerminalSessionClearsHold() async {
        let migration = MockServerMigrationClient()
        migration.session = session(phase: "provisioned", newServerDomain: "attic.alice.flagship.services")
        let holds = freshHoldStore()
        holds.setHold(for: server)
        let vm = makeVM(migration: migration, holdStore: holds)
        await vm.load()
        XCTAssertTrue(holds.hasHold(for: server))

        migration.session = session(
            phase: "taken-over", newServerDomain: "attic.alice.flagship.services",
            takenOverAt: 9, oldClosedOutAt: 10, done: true
        )
        await vm.refresh()
        XCTAssertFalse(holds.hasHold(for: server))
        XCTAssertTrue(vm.isTerminal)
        XCTAssertFalse(vm.canAbort)
    }
}
