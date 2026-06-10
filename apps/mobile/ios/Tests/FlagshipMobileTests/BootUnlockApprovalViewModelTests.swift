import XCTest
import CryptoKit
@testable import FlagshipCore
@testable import FlagshipUI
@testable import FlagshipAPI

/// `BootUnlockApprovalViewModel` surfaces a box's parked unlock request on
/// the server page so the owner can approve WITHOUT push. These tests drive
/// the VM through an injected fake `ApprovalSource` (no network / biometric)
/// at a 1ms poll interval with an injected clock, covering the full state
/// machine: live-request → .waiting, wrong-domain / wrong-purpose → .idle,
/// expired → .stoppedWaiting, approve success/failure, transient throw.
@MainActor
final class BootUnlockApprovalViewModelTests: XCTestCase {

    private let domain = "home.demo1234.flagship.services"
    private let other = "other.demo1234.flagship.services"

    // A fixed clock so expiry math is deterministic.
    private let nowMs: Int64 = 1_700_000_000_000

    private func request(
        serverDomain: String,
        purpose: SecretPurpose = .unlockKey,
        postedAt: Int64,
        expiresAt: Int64
    ) -> SecretRequestCoordinator.VerifiedRequest {
        let pending = PendingSecretRequest(
            serverDomain: serverDomain,
            requestNonceHex: String(repeating: "0", count: 64),
            stkPub: String(repeating: "1", count: 64),
            purpose: purpose.rawValue,
            issuedAt: postedAt,
            requestSignature: String(repeating: "2", count: 128),
            deviceInfo: DeviceInfoHint(ip: "10.0.0.5", region: "EU", os: "Debian", hostname: "box"),
            postedAt: postedAt,
            expiresAt: expiresAt
        )
        return SecretRequestCoordinator.VerifiedRequest(
            pending: pending,
            directoryStkPubHex: String(repeating: "1", count: 64)
        )
    }

    /// Fake source: returns a scripted request list, records approve calls,
    /// and can be told to throw on fetch.
    private final class FakeSource: ApprovalSource {
        var requests: [SecretRequestCoordinator.VerifiedRequest] = []
        var fetchError: Error?
        var approveError: Error?
        private(set) var approveCalls: [(id: String, depositAutoLease: Bool)] = []
        let leaseId: String?
        init(leaseId: String? = "lease-1") { self.leaseId = leaseId }

        func verifiedRequests() async throws -> [SecretRequestCoordinator.VerifiedRequest] {
            if let fetchError { throw fetchError }
            return requests
        }
        @discardableResult
        func approve(_ request: SecretRequestCoordinator.VerifiedRequest, depositAutoLease: Bool) async throws -> String? {
            if let approveError { throw approveError }
            approveCalls.append((request.id, depositAutoLease))
            return leaseId
        }
    }

    private func makeVM(
        source: FakeSource,
        store: BootUnlockStore = BootUnlockStore(defaults: BootUnlockApprovalViewModelTests.freshDefaults())
    ) -> BootUnlockApprovalViewModel {
        BootUnlockApprovalViewModel(
            serverDomain: domain,
            makeCoordinator: { source },
            store: store,
            pollIntervalNanos: 1,
            now: { [nowMs] in nowMs }
        )
    }

    private nonisolated static func freshDefaults() -> UserDefaults {
        let d = UserDefaults(suiteName: "boot-unlock-approval-test-\(UUID().uuidString)")!
        return d
    }

    /// Spin the poll loop until `predicate` holds or a deadline elapses.
    private func wait(
        _ vm: BootUnlockApprovalViewModel,
        until predicate: @escaping (BootUnlockApprovalViewModel.State) -> Bool,
        _ message: String = ""
    ) async {
        vm.start()
        for _ in 0..<2000 {
            if predicate(vm.state) { return }
            try? await Task.sleep(nanoseconds: 1_000_000)
        }
        XCTFail("timed out waiting for state — got \(vm.state). \(message)")
    }

    // MARK: - Polling → state

    func test_liveUnlockRequest_forServer_becomesWaiting() async {
        let source = FakeSource()
        source.requests = [request(serverDomain: domain, postedAt: nowMs, expiresAt: nowMs + 60_000)]
        let vm = makeVM(source: source)
        await wait(vm, until: { if case .waiting = $0 { return true } else { return false } })
        vm.stop()
    }

    func test_requestForDifferentServer_staysIdle() async {
        let source = FakeSource()
        source.requests = [request(serverDomain: other, postedAt: nowMs, expiresAt: nowMs + 60_000)]
        let vm = makeVM(source: source)
        vm.start()
        try? await Task.sleep(nanoseconds: 20_000_000)
        XCTAssertEqual(vm.state, .idle)
        vm.stop()
    }

    func test_entitlementPurpose_isIgnored_staysIdle() async {
        let source = FakeSource()
        source.requests = [request(serverDomain: domain, purpose: .entitlement, postedAt: nowMs, expiresAt: nowMs + 60_000)]
        let vm = makeVM(source: source)
        vm.start()
        try? await Task.sleep(nanoseconds: 20_000_000)
        XCTAssertEqual(vm.state, .idle)
        vm.stop()
    }

    func test_expiredRequest_becomesStoppedWaiting() async {
        let source = FakeSource()
        source.requests = [request(serverDomain: domain, postedAt: nowMs - 120_000, expiresAt: nowMs - 60_000)]
        let vm = makeVM(source: source)
        await wait(vm, until: { $0 == .stoppedWaiting })
        vm.stop()
    }

    func test_freshestLiveRequest_wins() async {
        let source = FakeSource()
        source.requests = [
            request(serverDomain: domain, postedAt: nowMs - 30_000, expiresAt: nowMs + 60_000),
            request(serverDomain: domain, postedAt: nowMs, expiresAt: nowMs + 90_000),
        ]
        let vm = makeVM(source: source)
        await wait(vm, until: { if case .waiting = $0 { return true } else { return false } })
        guard case .waiting(let req) = vm.state else { return XCTFail() }
        XCTAssertEqual(req.pending.postedAt, nowMs)
        vm.stop()
    }

    func test_transientFetchThrow_keepsPriorState() async {
        let source = FakeSource()
        source.requests = [request(serverDomain: domain, postedAt: nowMs, expiresAt: nowMs + 60_000)]
        let vm = makeVM(source: source)
        await wait(vm, until: { if case .waiting = $0 { return true } else { return false } })
        // Now make the next fetch throw — the VM must NOT thrash to .failed.
        source.fetchError = ScreensClientError.http(status: 500, message: "blip")
        try? await Task.sleep(nanoseconds: 30_000_000)
        guard case .waiting = vm.state else {
            return XCTFail("transient throw flipped state to \(vm.state)")
        }
        vm.stop()
    }

    // MARK: - approve()

    func test_approve_success_setsApproved_andDepositsLeaseForAutoServer() async {
        let source = FakeSource()
        source.requests = [request(serverDomain: domain, postedAt: nowMs, expiresAt: nowMs + 60_000)]
        let store = BootUnlockStore(defaults: Self.freshDefaults())
        store.setMode(.auto, for: domain)
        let vm = makeVM(source: source, store: store)
        await wait(vm, until: { if case .waiting = $0 { return true } else { return false } })

        await vm.approve()

        XCTAssertEqual(vm.state, .approved)
        XCTAssertEqual(source.approveCalls.count, 1)
        XCTAssertTrue(source.approveCalls[0].depositAutoLease, "auto server must deposit a lease")
        vm.stop()
    }

    func test_approve_approveServer_doesNotDepositLease() async {
        let source = FakeSource()
        source.requests = [request(serverDomain: domain, postedAt: nowMs, expiresAt: nowMs + 60_000)]
        let store = BootUnlockStore(defaults: Self.freshDefaults())
        store.setMode(.approve, for: domain)
        let vm = makeVM(source: source, store: store)
        await wait(vm, until: { if case .waiting = $0 { return true } else { return false } })

        await vm.approve()

        XCTAssertEqual(vm.state, .approved)
        XCTAssertEqual(source.approveCalls.count, 1)
        XCTAssertFalse(source.approveCalls[0].depositAutoLease, "approve-mode server must not deposit a lease")
        vm.stop()
    }

    func test_approve_failure_setsFailed() async {
        let source = FakeSource()
        source.requests = [request(serverDomain: domain, postedAt: nowMs, expiresAt: nowMs + 60_000)]
        source.approveError = ScreensClientError.http(status: 403, message: "nope")
        let vm = makeVM(source: source)
        await wait(vm, until: { if case .waiting = $0 { return true } else { return false } })

        await vm.approve()

        guard case .failed = vm.state else { return XCTFail("expected .failed, got \(vm.state)") }
        vm.stop()
    }

    func test_approved_isTerminal_lateVanishDoesNotUndo() async {
        let source = FakeSource()
        source.requests = [request(serverDomain: domain, postedAt: nowMs, expiresAt: nowMs + 60_000)]
        let vm = makeVM(source: source)
        await wait(vm, until: { if case .waiting = $0 { return true } else { return false } })
        await vm.approve()
        XCTAssertEqual(vm.state, .approved)
        // The box answered, so the request leaves the mailbox.
        source.requests = []
        vm.start()
        try? await Task.sleep(nanoseconds: 20_000_000)
        XCTAssertEqual(vm.state, .approved, "approved must not be undone by a later empty poll")
        vm.stop()
    }
}
