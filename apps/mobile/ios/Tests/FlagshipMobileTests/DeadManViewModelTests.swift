import XCTest
import CryptoKit
@testable import FlagshipCore
@testable import FlagshipUI
@testable import FlagshipAPI

@MainActor
final class DeadManViewModelTests: XCTestCase {
    private let server = "home.alice.flagship.services"

    private func key() -> Curve25519.Signing.PrivateKey {
        try! Curve25519.Signing.PrivateKey(rawRepresentation: Data(repeating: 5, count: 32))
    }

    /// Fresh UserDefaults suite per test so persistence doesn't bleed.
    private func freshStore() -> DeadManStore {
        let suite = UserDefaults(suiteName: "deadman-test-\(UUID().uuidString)")!
        return DeadManStore(defaults: suite)
    }

    func testEnablePolicySignsAndPosts() async {
        let mock = MockLockPowerClient()
        let store = freshStore()
        let k = key()
        var scheduled: [(String, String, Int64)] = []
        let vm = DeadManViewModel(
            client: mock, serverDomain: server, serverName: "Home",
            store: store, signer: { _ in k }, now: { 1000 },
            scheduleReminders: { d, n, e in scheduled.append((d, n, e)) },
            cancelReminders: { _ in }
        )
        await vm.applyPolicy(enabled: true, window: .h8, lockoutMode: .restart)

        XCTAssertEqual(vm.phase, .idle)
        XCTAssertTrue(vm.enabled)
        XCTAssertEqual(mock.sent.count, 1)
        let sent = mock.sent[0]
        XCTAssertEqual(sent.path, "/api/deadman/policy")
        XCTAssertEqual(sent.request["enabled"], "true")
        XCTAssertEqual(sent.request["lockoutMode"], "restart")
        // Signature verifies against canonical policy bytes.
        let policy = DeadManPolicy(
            serverId: server, enabled: true,
            windowMs: DeadManStore.WindowPreset.h8.ms,
            graceMs: DeadManStore.defaultGraceMs,
            lockoutMode: .restart, issuedAt: 1000
        )
        let sig = Data(HexUtil.decode(sent.signatureHex)!)
        XCTAssertTrue(k.publicKey.isValidSignature(sig, for: policy.canonicalBytes()))
        // Persisted.
        XCTAssertTrue(store.isEnabled(for: server))
        // Enabling does NOT auto-affirm (no reminders scheduled yet).
        XCTAssertTrue(scheduled.isEmpty)
    }

    func testDisableClearsLeaseAndCancelsReminders() async {
        let mock = MockLockPowerClient()
        let store = freshStore()
        store.save(serverDomain: server, enabled: true, windowMs: 1000, graceMs: 0, lockoutMode: "off")
        store.setLeaseExpiry(99999, for: server)
        var cancelled: [String] = []
        let vm = DeadManViewModel(
            client: mock, serverDomain: server, serverName: "Home",
            store: store, signer: { _ in self.key() }, now: { 1000 },
            scheduleReminders: { _, _, _ in }, cancelReminders: { cancelled.append($0) }
        )
        await vm.applyPolicy(enabled: false, window: .h24, lockoutMode: .off)
        XCTAssertFalse(vm.enabled)
        XCTAssertNil(store.leaseExpiry(for: server))
        XCTAssertEqual(cancelled, [server])
    }

    func testAffirmPostsAndSchedulesRemindersFromLeaseExpiry() async {
        let mock = MockLockPowerClient()
        mock.affirmLeaseExpiry = 5000
        let store = freshStore()
        let k = key()
        var scheduled: [(String, String, Int64)] = []
        let vm = DeadManViewModel(
            client: mock, serverDomain: server, serverName: "Home",
            store: store, signer: { _ in k }, now: { 1000 },
            scheduleReminders: { d, n, e in scheduled.append((d, n, e)) },
            cancelReminders: { _ in }
        )
        await vm.affirm()

        XCTAssertEqual(vm.phase, .idle)
        XCTAssertEqual(vm.leaseExpiry, 5000)
        XCTAssertEqual(store.leaseExpiry(for: server), 5000)
        XCTAssertEqual(scheduled.count, 1)
        XCTAssertEqual(scheduled[0].2, 5000)
        let sent = mock.sent[0]
        XCTAssertEqual(sent.path, "/api/deadman/affirm")
        // Signature verifies against the affirmation's canonical bytes (nonce
        // reconstructed from the posted hex).
        let nonce = Data(HexUtil.decode(sent.request["nonce"]!)!)
        let affirm = DeadManAffirmation(serverId: server, nonce: nonce, issuedAt: 1000)
        let sig = Data(HexUtil.decode(sent.signatureHex)!)
        XCTAssertTrue(k.publicKey.isValidSignature(sig, for: affirm.canonicalBytes()))
    }

    func testAffirmNeverAutomaticMockHasNoSentUntilCalled() async {
        let mock = MockLockPowerClient()
        mock.affirmLeaseExpiry = 5000
        _ = DeadManViewModel(client: mock, serverDomain: server, serverName: "Home", store: freshStore())
        // Constructing the VM must not affirm.
        XCTAssertTrue(mock.sent.isEmpty)
    }

    func testLeaseRemainingComputed() {
        let store = freshStore()
        store.setLeaseExpiry(3000, for: server)
        let vm = DeadManViewModel(client: MockLockPowerClient(), serverDomain: server, serverName: "Home", store: store, now: { 1000 })
        XCTAssertEqual(vm.leaseRemainingMs(), 2000)
    }

    func testAffirmFailureSurfaces() async {
        let mock = MockLockPowerClient()
        mock.nextError = ScreensClientError.http(status: 403, message: "rejected")
        let vm = DeadManViewModel(client: mock, serverDomain: server, serverName: "Home", store: freshStore(), signer: { _ in self.key() })
        await vm.affirm()
        if case .failed = vm.phase {} else { XCTFail("expected failed") }
    }
}
