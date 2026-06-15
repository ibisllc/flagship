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

    // MARK: - Deploy operations (derived from pods)

    func test_pendingPod_becomesDeployOperation_withCanonicalLabelAndTarget() {
        let c = ActiveOperationsCenter()
        c.syncDeployOperations(pods: [pendingPod("p1", name: "Home")])
        let op = try? XCTUnwrap(c.primary)
        XCTAssertEqual(op?.kind, .deploy)
        XCTAssertEqual(op?.label, "deploying server Home")
        XCTAssertEqual(op?.target, .serverDetail(podId: "p1"))
        XCTAssertEqual(c.operations.count, 1)
        XCTAssertEqual(c.additionalCount, 0)
    }

    func test_nonPendingPods_produceNoDeployOperations() {
        let c = ActiveOperationsCenter()
        c.syncDeployOperations(pods: [onlinePod("p1", name: "Home"), onlinePod("p2", name: "Work")])
        XCTAssertTrue(c.operations.isEmpty)
        XCTAssertNil(c.primary)
    }

    func test_syncDeploy_isIdempotent_andDoesNotReorder() {
        let c = ActiveOperationsCenter()
        let pods = [pendingPod("p1", name: "Home"), pendingPod("p2", name: "Work")]
        c.syncDeployOperations(pods: pods)
        let first = c.operations
        // A steady re-sync with the same pods must not churn the list (same
        // ids AND same seq) so the sliver never flickers or reorders.
        c.syncDeployOperations(pods: pods)
        XCTAssertEqual(c.operations, first)
    }

    func test_podLeavingPending_dropsItsDeployOperation() {
        let c = ActiveOperationsCenter()
        c.syncDeployOperations(pods: [pendingPod("p1", name: "Home")])
        XCTAssertEqual(c.operations.count, 1)
        // The box came online → the deploy op disappears.
        c.syncDeployOperations(pods: [onlinePod("p1", name: "Home")])
        XCTAssertTrue(c.operations.isEmpty)
    }

    func test_deployRename_updatesLabel_butKeepsOrder() {
        let c = ActiveOperationsCenter()
        c.syncDeployOperations(pods: [pendingPod("p1", name: "Home"), pendingPod("p2", name: "Work")])
        let seqBefore = c.operations.first(where: { $0.id == "deploy:p2" })?.seq
        c.syncDeployOperations(pods: [pendingPod("p1", name: "Home"), pendingPod("p2", name: "Workstation")])
        let renamed = c.operations.first(where: { $0.id == "deploy:p2" })
        XCTAssertEqual(renamed?.label, "deploying server Workstation")
        XCTAssertEqual(renamed?.seq, seqBefore, "a rename must not jump the op's position")
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

    // MARK: - Ordering & mixing the two feeders

    func test_primaryIsMostRecentlyStarted() {
        let c = ActiveOperationsCenter()
        c.syncDeployOperations(pods: [pendingPod("p1", name: "Home")]) // seq 1
        c.upsertBuild(id: "s1", subject: "blog", onServer: "Home", target: .vibeCodeChat(sessionId: "s1")) // seq 2
        XCTAssertEqual(c.primary?.kind, .build, "the newest op is the one the sliver shows")
        XCTAssertEqual(c.additionalCount, 1)

        // When the build finishes the deploy is primary again.
        c.removeBuild(id: "s1")
        XCTAssertEqual(c.primary?.kind, .deploy)
        XCTAssertEqual(c.additionalCount, 0)
    }

    func test_deploySync_preservesBuildOperations() {
        let c = ActiveOperationsCenter()
        c.upsertBuild(id: "s1", subject: "blog", onServer: "Home", target: .vibeCodeChat(sessionId: "s1"))
        c.syncDeployOperations(pods: [pendingPod("p1", name: "Home")])
        XCTAssertEqual(c.operations.count, 2, "reconciling deploys must not wipe build ops")
        XCTAssertTrue(c.operations.contains { $0.kind == .build })
        XCTAssertTrue(c.operations.contains { $0.kind == .deploy })
    }

    func test_mixedOperations_countAndAdditional() {
        let c = ActiveOperationsCenter()
        c.syncDeployOperations(pods: [pendingPod("p1", name: "Home"), pendingPod("p2", name: "Work")])
        c.upsertBuild(id: "s1", subject: "blog", onServer: "Home", target: .vibeCodeChat(sessionId: "s1"))
        XCTAssertEqual(c.operations.count, 3)
        XCTAssertEqual(c.additionalCount, 2)
    }

    func test_deployAndBuildIds_neverCollide() {
        // A pod and a build session could share a raw id; the center
        // namespaces them so both ops coexist.
        let c = ActiveOperationsCenter()
        c.syncDeployOperations(pods: [pendingPod("x", name: "Home")])
        c.upsertBuild(id: "x", subject: "blog", onServer: "Home", target: .vibeCodeChat(sessionId: "x"))
        XCTAssertEqual(c.operations.count, 2)
    }
}
