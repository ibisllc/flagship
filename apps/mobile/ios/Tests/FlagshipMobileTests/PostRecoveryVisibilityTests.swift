import XCTest
@testable import FlagshipAPI
@testable import FlagshipUI

final class PostRecoveryVisibilityTests: XCTestCase {
    func test_pendingUnobjectedReattach_isActive() {
        XCTAssertTrue(snapshot(lastSwapTo: nil, objectedAt: nil).hasActiveReattach)
    }

    func test_objectedReattach_isNotActive() {
        XCTAssertFalse(snapshot(lastSwapTo: nil, objectedAt: 300).hasActiveReattach)
    }

    func test_completedReattach_isNotActive() {
        XCTAssertFalse(snapshot(lastSwapTo: "new-key", objectedAt: nil).hasActiveReattach)
    }

    func test_priorCompletedSwap_doesNotHideNewPendingReattach() {
        XCTAssertTrue(snapshot(lastSwapTo: "older-key", objectedAt: nil).hasActiveReattach)
    }

    private func snapshot(lastSwapTo: String?, objectedAt: Int64?) -> PostRecoverySnapshot {
        PostRecoverySnapshot(
            currentIrkPubHex: "old-key",
            state: WatcherState(
                lastSeen: PendingRePair(
                    newIrkPub: "new-key",
                    oldIrkPub: "old-key",
                    initiatedAt: 100,
                    completesAt: 200,
                    objectedAt: objectedAt
                ),
                lastSwapTo: lastSwapTo,
                lastSwapAt: nil,
                lastPolledAt: 100,
                lastError: nil
            ),
            lastReissue: nil
        )
    }
}
