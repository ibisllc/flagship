import XCTest
import CryptoKit
@testable import FlagshipCore
@testable import FlagshipUI
@testable import FlagshipAPI

/// `BootUnlockApprovalViewModel` is DIRECTORY-DRIVEN: the pod's cheap
/// `awaitingUnlock` flag (no biometric) arms the Approve/Deny prompt, and Face
/// ID fires only when the owner taps Approve — a single one-ceremony
/// `approvePendingUnlock`. These tests drive the VM through a fake
/// `ApprovalSource` (no network / biometric), covering the surfacing logic,
/// approve success/failure + auto-lease deposit, Deny latching, and retry.
@MainActor
final class BootUnlockApprovalViewModelTests: XCTestCase {

    private let domain = "home.demo1234.flagship.services"

    /// Fake source: records the one-ceremony approve calls and can be told to
    /// throw. The list-only protocol methods are unused by this card.
    private final class FakeSource: ApprovalSource {
        var approveError: Error?
        var leaseId: String? = "lease-1"
        private(set) var approveCalls: [(serverDomain: String, depositAutoLease: Bool)] = []

        func verifiedRequests() async throws -> [SecretRequestCoordinator.VerifiedRequest] { [] }
        @discardableResult
        func approve(_ request: SecretRequestCoordinator.VerifiedRequest, depositAutoLease: Bool) async throws -> String? { nil }
        @discardableResult
        func approvePendingUnlock(serverDomain: String, depositAutoLease: Bool) async throws -> String? {
            if let approveError { throw approveError }
            approveCalls.append((serverDomain, depositAutoLease))
            return leaseId
        }
    }

    private nonisolated static func freshDefaults() -> UserDefaults {
        UserDefaults(suiteName: "boot-unlock-approval-test-\(UUID().uuidString)")!
    }

    private func makeVM(
        source: FakeSource,
        store: BootUnlockStore = BootUnlockStore(defaults: BootUnlockApprovalViewModelTests.freshDefaults())
    ) -> BootUnlockApprovalViewModel {
        BootUnlockApprovalViewModel(serverDomain: domain, makeCoordinator: { source }, store: store)
    }

    /// Regression: a box already waiting when the card is constructed must show
    /// the request prompt on the FIRST render — the seed, not a deferred
    /// `.onAppear` flip (a zero-size EmptyView's onAppear can miss in a
    /// ScrollView, which left the card permanently blank). The live office.harry2
    /// bug: directory awaitingUnlock=true, yet no Approve card surfaced.
    func test_initialAwaiting_seedsRequestPending_onFirstRender() {
        let vm = BootUnlockApprovalViewModel(
            serverDomain: domain, makeCoordinator: { nil }, initialAwaiting: true
        )
        XCTAssertEqual(vm.state, .requestPending)
    }

    func test_initialAwaiting_false_staysIdle() {
        let vm = BootUnlockApprovalViewModel(
            serverDomain: domain, makeCoordinator: { nil }, initialAwaiting: false
        )
        XCTAssertEqual(vm.state, .idle)
    }

    // MARK: - Directory-driven surfacing (NO biometric)

    func test_awaitingTrue_armsRequestPending() {
        let vm = makeVM(source: FakeSource())
        vm.setAwaitingUnlock(true)
        XCTAssertEqual(vm.state, .requestPending)
    }

    func test_awaitingFalse_isIdle() {
        let vm = makeVM(source: FakeSource())
        vm.setAwaitingUnlock(true)
        vm.setAwaitingUnlock(false)
        XCTAssertEqual(vm.state, .idle)
    }

    // MARK: - approve() — one ceremony

    func test_approve_autoServer_depositsLease_andApproves() async {
        let source = FakeSource()
        let store = BootUnlockStore(defaults: Self.freshDefaults())
        store.setMode(.auto, for: domain)
        let vm = makeVM(source: source, store: store)
        vm.setAwaitingUnlock(true)

        await vm.approve()

        XCTAssertEqual(vm.state, .approved)
        XCTAssertEqual(source.approveCalls.count, 1)
        XCTAssertEqual(source.approveCalls[0].serverDomain, domain)
        XCTAssertTrue(source.approveCalls[0].depositAutoLease, "auto server must deposit a lease")
    }

    func test_approve_approveModeServer_noLease() async {
        let source = FakeSource()
        let store = BootUnlockStore(defaults: Self.freshDefaults())
        store.setMode(.approve, for: domain)
        let vm = makeVM(source: source, store: store)
        vm.setAwaitingUnlock(true)

        await vm.approve()

        XCTAssertEqual(vm.state, .approved)
        XCTAssertEqual(source.approveCalls.count, 1)
        XCTAssertFalse(source.approveCalls[0].depositAutoLease, "approve-mode server must not deposit a lease")
    }

    func test_approve_failure_setsFailed() async {
        let source = FakeSource()
        source.approveError = ScreensClientError.http(status: 403, message: "nope")
        let vm = makeVM(source: source)
        vm.setAwaitingUnlock(true)

        await vm.approve()

        guard case .failed = vm.state else { return XCTFail("expected .failed, got \(vm.state)") }
    }

    func test_approved_terminal_lateAwaitingFalseDoesNotUndo() async {
        let source = FakeSource()
        let vm = makeVM(source: source)
        vm.setAwaitingUnlock(true)
        await vm.approve()
        XCTAssertEqual(vm.state, .approved)
        // The box answered; the directory flag clears — must not undo success.
        vm.setAwaitingUnlock(false)
        XCTAssertEqual(vm.state, .approved)
    }

    // MARK: - Deny + retry

    func test_deny_latches_staysIdleWhileStillAwaiting() {
        let vm = makeVM(source: FakeSource())
        vm.setAwaitingUnlock(true)
        vm.deny()
        XCTAssertEqual(vm.state, .idle)
        // Directory still says awaiting, but the user denied this session.
        vm.setAwaitingUnlock(true)
        XCTAssertEqual(vm.state, .idle)
    }

    func test_retry_afterFailure_rearmsPending() async {
        let source = FakeSource()
        source.approveError = ScreensClientError.http(status: 500, message: "blip")
        let vm = makeVM(source: source)
        vm.setAwaitingUnlock(true)
        await vm.approve()
        guard case .failed = vm.state else { return XCTFail("expected .failed") }
        vm.retry()
        XCTAssertEqual(vm.state, .requestPending)
    }
}
