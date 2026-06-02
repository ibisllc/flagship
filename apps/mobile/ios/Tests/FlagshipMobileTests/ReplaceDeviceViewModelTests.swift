import XCTest
@testable import FlagshipAPI
@testable import FlagshipUI
@testable import FlagshipCore
@testable import Flagship

/// B7 — drives the ReplaceDeviceViewModel through happy + sad paths
/// against the MockFlagshipServerClient. The Keystore primitives
/// it calls under the hood ARE the real keychain on iOS — these
/// tests run on simulator/host where keychain writes succeed.
@MainActor
final class ReplaceDeviceViewModelTests: XCTestCase {

    override func tearDown() async throws {
        // Don't leave keychain bits behind between tests — the IRK
        // version + pending slots are persisted, so subsequent test
        // cases would inherit stale state.
        Keystore.wipe()
        try? Keystore.setPendingIrkRotationVersion(nil)
        try await super.tearDown()
    }

    private func makeUMK() async throws {
        // Materialize a UMK in the keychain so deriveIRK works.
        try await Keystore.generateUMK(reason: "test")
    }

    func test_initiate_happyPath_persistsPendingVersion() async throws {
        try await makeUMK()
        // Baseline: v1 active, no pending.
        XCTAssertEqual(Keystore.currentIrkVersion(), 1)
        XCTAssertNil(Keystore.pendingIrkRotationVersion())

        let server = MockFlagshipServerClient()
        server.simulatedLatency = 0
        server.rePairBehavior = .ok
        let vm = ReplaceDeviceViewModel(server: server, username: { "alice" })

        await vm.initiate(currentEtag: "W/\"abc123\"")

        if case .pending = vm.phase {} else {
            XCTFail("expected .pending, got \(vm.phase)")
        }
        XCTAssertEqual(Keystore.pendingIrkRotationVersion(), 2)
        // Current version NOT yet bumped — that only happens at
        // complete time.
        XCTAssertEqual(Keystore.currentIrkVersion(), 1)

        // The recorded request carries OLD + NEW pub keys + the
        // user-supplied If-Match header.
        let last = try XCTUnwrap(server.lastRePairInitiate)
        XCTAssertEqual(last.username, "alice")
        XCTAssertEqual(last.ifMatch, "W/\"abc123\"")
        XCTAssertEqual(last.body.request.username, "alice")
        XCTAssertFalse(last.body.request.newIrkPub.isEmpty)
        XCTAssertNotEqual(last.body.request.newIrkPub, last.body.request.oldIrkPub)
    }

    func test_initiate_412_surfacedAsFailure_andPendingStaysClear() async throws {
        try await makeUMK()
        let server = MockFlagshipServerClient()
        server.simulatedLatency = 0
        server.rePairBehavior = .staleEtag(currentEtag: "W/\"fresh-etag\"")
        let vm = ReplaceDeviceViewModel(server: server, username: { "alice" })

        await vm.initiate(currentEtag: "W/\"stale\"")

        if case .failed = vm.phase {} else {
            XCTFail("expected .failed, got \(vm.phase)")
        }
        XCTAssertNil(Keystore.pendingIrkRotationVersion())
    }

    func test_initiate_409_alreadyPending_surfacesFriendlyMessage() async throws {
        try await makeUMK()
        let server = MockFlagshipServerClient()
        server.simulatedLatency = 0
        server.rePairBehavior = .alreadyPending
        let vm = ReplaceDeviceViewModel(server: server, username: { "alice" })

        await vm.initiate(currentEtag: nil)

        if case .failed(let msg) = vm.phase {
            XCTAssertTrue(msg.contains("already pending"))
        } else {
            XCTFail("expected .failed, got \(vm.phase)")
        }
    }

    func test_initiate_withoutUsername_failsImmediately() async {
        let server = MockFlagshipServerClient()
        let vm = ReplaceDeviceViewModel(server: server, username: { nil })

        await vm.initiate(currentEtag: nil)

        if case .failed = vm.phase {} else {
            XCTFail("expected .failed, got \(vm.phase)")
        }
    }

    func test_complete_bumpsCurrentVersionAndClearsPending() async throws {
        try await makeUMK()
        try Keystore.setPendingIrkRotationVersion(2)
        let server = MockFlagshipServerClient()
        server.simulatedLatency = 0
        let vm = ReplaceDeviceViewModel(server: server, username: { "alice" })

        await vm.complete()

        if case .completed = vm.phase {} else {
            XCTFail("expected .completed, got \(vm.phase)")
        }
        XCTAssertEqual(Keystore.currentIrkVersion(), 2)
        XCTAssertNil(Keystore.pendingIrkRotationVersion())
    }

    func test_complete_withoutPending_fails() async {
        let server = MockFlagshipServerClient()
        let vm = ReplaceDeviceViewModel(server: server, username: { "alice" })
        await vm.complete()
        if case .failed = vm.phase {} else {
            XCTFail("expected .failed, got \(vm.phase)")
        }
    }

    // MARK: - B7 finalize-screen support (resume / graceElapsed / pending)

    func test_hasPendingRotation_tracksKeystoreSlot() throws {
        let server = MockFlagshipServerClient()
        let vm = ReplaceDeviceViewModel(server: server, username: { "alice" })
        XCTAssertFalse(vm.hasPendingRotation)
        try Keystore.setPendingIrkRotationVersion(2)
        XCTAssertTrue(vm.hasPendingRotation)
        try Keystore.setPendingIrkRotationVersion(nil)
        XCTAssertFalse(vm.hasPendingRotation)
    }

    func test_resume_fromIdle_entersPendingWithDeadline() {
        let server = MockFlagshipServerClient()
        let vm = ReplaceDeviceViewModel(server: server, username: { "alice" })
        vm.resume(completesAt: 1_700_000_000_000)
        if case .pending(let at) = vm.phase {
            XCTAssertEqual(at, 1_700_000_000_000)
        } else {
            XCTFail("expected .pending, got \(vm.phase)")
        }
    }

    func test_resume_fromFailed_reentersPending() async {
        let server = MockFlagshipServerClient()
        let vm = ReplaceDeviceViewModel(server: server, username: { "alice" })
        // Drive into .failed deterministically: complete() with no pending
        // rotation fails before touching the network.
        await vm.complete()
        guard case .failed = vm.phase else {
            return XCTFail("expected .failed precondition, got \(vm.phase)")
        }
        vm.resume(completesAt: 42)
        if case .pending(let at) = vm.phase {
            XCTAssertEqual(at, 42)
        } else {
            XCTFail("expected .pending after resume, got \(vm.phase)")
        }
    }

    func test_resume_doesNotClobberCompleted() async throws {
        try await makeUMK()
        try Keystore.setPendingIrkRotationVersion(2)
        let server = MockFlagshipServerClient()
        server.simulatedLatency = 0
        let vm = ReplaceDeviceViewModel(server: server, username: { "alice" })
        await vm.complete()
        guard case .completed = vm.phase else {
            return XCTFail("expected .completed precondition, got \(vm.phase)")
        }
        // resume MUST be a no-op once completed — never reopen the grace.
        vm.resume(completesAt: 999)
        if case .completed = vm.phase {} else {
            XCTFail("resume clobbered terminal .completed → \(vm.phase)")
        }
    }

    func test_graceElapsed_trueWhenDeadlinePast() {
        let now = Date(timeIntervalSince1970: 2_000)
        XCTAssertTrue(ReplaceDeviceViewModel.graceElapsed(completesAt: 1_999_000, now: now))
        XCTAssertTrue(ReplaceDeviceViewModel.graceElapsed(completesAt: 2_000_000, now: now)) // exactly now
    }

    func test_graceElapsed_falseWhenDeadlineFuture() {
        let now = Date(timeIntervalSince1970: 2_000)
        XCTAssertFalse(ReplaceDeviceViewModel.graceElapsed(completesAt: 2_001_000, now: now))
    }

    func test_initiate_thenResumePreservesDeadline() async throws {
        try await makeUMK()
        let server = MockFlagshipServerClient()
        server.simulatedLatency = 0
        server.rePairBehavior = .ok
        let vm = ReplaceDeviceViewModel(server: server, username: { "alice" })
        await vm.initiate(currentEtag: nil)
        guard case .pending(let original) = vm.phase else {
            return XCTFail("expected .pending after initiate, got \(vm.phase)")
        }
        // A re-entry with the same deadline keeps the VM in .pending.
        vm.resume(completesAt: original)
        if case .pending(let at) = vm.phase {
            XCTAssertEqual(at, original)
        } else {
            XCTFail("expected .pending after resume, got \(vm.phase)")
        }
    }
}

/// B7 — Keystore IRK-version primitive tests (separate from the VM
/// so a future Keystore refactor doesn't require touching the VM
/// suite).
final class KeystoreIrkVersionTests: XCTestCase {

    override func tearDown() {
        Keystore.wipe()
        try? Keystore.setPendingIrkRotationVersion(nil)
        super.tearDown()
    }

    func test_defaultVersionIsOne() {
        XCTAssertEqual(Keystore.currentIrkVersion(), 1)
    }

    func test_setAndReadBackVersion() throws {
        try Keystore.setCurrentIrkVersion(2)
        XCTAssertEqual(Keystore.currentIrkVersion(), 2)
        try Keystore.setCurrentIrkVersion(7)
        XCTAssertEqual(Keystore.currentIrkVersion(), 7)
    }

    func test_pendingSlotRoundTrip() throws {
        XCTAssertNil(Keystore.pendingIrkRotationVersion())
        try Keystore.setPendingIrkRotationVersion(3)
        XCTAssertEqual(Keystore.pendingIrkRotationVersion(), 3)
        try Keystore.setPendingIrkRotationVersion(nil)
        XCTAssertNil(Keystore.pendingIrkRotationVersion())
    }

    func test_wipeClearsVersionSlots() throws {
        try Keystore.setCurrentIrkVersion(5)
        try Keystore.setPendingIrkRotationVersion(6)
        Keystore.wipe()
        XCTAssertEqual(Keystore.currentIrkVersion(), 1) // back to default
        XCTAssertNil(Keystore.pendingIrkRotationVersion())
    }

    func test_deriveIrkAtDifferentVersionsProducesDifferentKeys() async throws {
        try await Keystore.generateUMK(reason: "test")
        let v1 = try await Keystore.deriveIRK(reason: "test", version: 1)
        let v2 = try await Keystore.deriveIRK(reason: "test", version: 2)
        XCTAssertNotEqual(v1.rawRepresentation, v2.rawRepresentation)
    }
}
