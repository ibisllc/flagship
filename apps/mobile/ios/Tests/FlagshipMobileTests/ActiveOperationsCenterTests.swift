import XCTest
@testable import FlagshipCore

/// The global operations sliver is a thin render of `ActiveOperationsCenter`,
/// so the logic that matters — what shows, in what order, and where a tap
/// goes — is all here: label shapes, churn-free deploy reconciliation, the
/// build lifecycle, and primary/ordering across mixed operations.
@MainActor
final class ActiveOperationsCenterTests: XCTestCase {

    private func pendingPod(_ id: String, name: String) -> PodInfo {
        PodInfo(podId: id, name: name, fqdn: "\(name.lowercased()).u", status: .pending, pendingAuthCodeSerial: "serial-\(id)")
    }
    private func onlinePod(_ id: String, name: String) -> PodInfo {
        PodInfo(podId: id, name: name, fqdn: "\(name.lowercased()).u", status: .online)
    }

    // MARK: - Empty

    func test_empty_hasNoPrimary() {
        let c = ActiveOperationsCenter()
        XCTAssertNil(c.primary)
        XCTAssertEqual(c.additionalCount, 0)
        XCTAssertTrue(c.operations.isEmpty)
    }

    // MARK: - Deploy operations (Bug-3: SUPPRESSED for pending pods)

    func test_pendingPod_doesNotShowDeployOperation() {
        // Bug 3: a freshly-created server is `.pending` while it is merely
        // AWAITING A BURN — there is no reliable on-model signal distinguishing
        // that from "actually installing", so we never emit a spinning
        // "deploying server <name>" op for a pending pod.
        let c = ActiveOperationsCenter()
        c.syncDeployOperations(pods: [pendingPod("p1", name: "Home")])
        XCTAssertTrue(c.operations.isEmpty)
        XCTAssertNil(c.primary)
        XCTAssertEqual(c.additionalCount, 0)
    }

    func test_nonPendingPods_produceNoDeployOperations() {
        let c = ActiveOperationsCenter()
        c.syncDeployOperations(pods: [onlinePod("p1", name: "Home"), onlinePod("p2", name: "Work")])
        XCTAssertTrue(c.operations.isEmpty)
        XCTAssertNil(c.primary)
    }

    func test_manyPendingPods_stillEmitNoDeployOps() {
        let c = ActiveOperationsCenter()
        c.syncDeployOperations(pods: [pendingPod("p1", name: "Home"), pendingPod("p2", name: "Work")])
        XCTAssertTrue(c.operations.isEmpty)
        // Idempotent: a steady re-sync stays empty.
        c.syncDeployOperations(pods: [pendingPod("p1", name: "Home"), pendingPod("p2", name: "Work")])
        XCTAssertTrue(c.operations.isEmpty)
    }

    // MARK: - Build operations (imperative)

    func test_buildOperation_labelWithAndWithoutServer() {
        let c = ActiveOperationsCenter()
        c.upsertBuild(id: "s1", subject: "blog", onServer: "Home", target: .vibeCodeChat(sessionId: "s1"))
        XCTAssertEqual(c.primary?.label, "building blog on Home")
        XCTAssertEqual(c.primary?.target, .vibeCodeChat(sessionId: "s1"))

        c.upsertBuild(id: "s1", subject: "blog", onServer: nil, target: .vibeCodeChat(sessionId: "s1"))
        XCTAssertEqual(c.primary?.label, "building blog")
        XCTAssertEqual(c.operations.count, 1, "re-upserting the same id must not duplicate")
    }

    func test_buildUpsertTwice_keepsOrder() {
        let c = ActiveOperationsCenter()
        c.upsertBuild(id: "s1", subject: "blog", onServer: "Home", target: .vibeCodeChat(sessionId: "s1"))
        let seqBefore = c.operations.first?.seq
        c.upsertBuild(id: "s1", subject: "blog renamed", onServer: "Home", target: .vibeCodeChat(sessionId: "s1"))
        XCTAssertEqual(c.operations.count, 1)
        XCTAssertEqual(c.operations.first?.seq, seqBefore)
        XCTAssertEqual(c.operations.first?.subject, "blog renamed")
    }

    func test_removeBuild_clearsIt() {
        let c = ActiveOperationsCenter()
        c.upsertBuild(id: "s1", subject: "blog", onServer: "Home", target: .vibeCodeChat(sessionId: "s1"))
        c.removeBuild(id: "s1")
        XCTAssertTrue(c.operations.isEmpty)
        XCTAssertNil(c.primary)
    }

    // MARK: - Mixing: builds survive deploy reconciliation, pending stays hidden

    func test_buildIsPrimary_andDeploySyncNeverAddsPending() {
        let c = ActiveOperationsCenter()
        c.upsertBuild(id: "s1", subject: "blog", onServer: "Home", target: .vibeCodeChat(sessionId: "s1"))
        XCTAssertEqual(c.primary?.kind, .build, "build ops still drive the sliver")
        XCTAssertEqual(c.additionalCount, 0)
    }

    func test_deploySync_preservesBuildOperations_andAddsNothingForPending() {
        let c = ActiveOperationsCenter()
        c.upsertBuild(id: "s1", subject: "blog", onServer: "Home", target: .vibeCodeChat(sessionId: "s1"))
        c.syncDeployOperations(pods: [pendingPod("p1", name: "Home")])
        XCTAssertEqual(c.operations.count, 1, "reconciling deploys must not wipe build ops nor add pending ops")
        XCTAssertTrue(c.operations.allSatisfy { $0.kind == .build })
    }

    func test_mixedOperations_onlyBuildsCount() {
        let c = ActiveOperationsCenter()
        c.syncDeployOperations(pods: [pendingPod("p1", name: "Home"), pendingPod("p2", name: "Work")])
        c.upsertBuild(id: "s1", subject: "blog", onServer: "Home", target: .vibeCodeChat(sessionId: "s1"))
        XCTAssertEqual(c.operations.count, 1)
        XCTAssertEqual(c.additionalCount, 0)
    }
}
