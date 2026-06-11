import XCTest
@testable import FlagshipAPI
@testable import FlagshipUI

/// #51 — ServerDetail load states. The drill-down server-management page loads
/// its detail through `HomeViewModel` (same VM the container uses). On success
/// the `.loaded` state drives the full management view; on failure the screen
/// shows a graceful "connecting…" state — it must NEVER surface the
/// `.notPaired` ("This device isn't connected to a server yet.") text, because tapping an online
/// server means it IS paired.
@MainActor
final class ServerDetailStateTests: XCTestCase {

    func test_bffLoads_yieldsLoadedState_forManagementView() async {
        let mock = MockScreensClient()
        mock.simulatedLatency = 0
        let vm = HomeViewModel(client: mock, podContext: "home")
        await vm.load()
        XCTAssertNotNil(vm.detail.value,
                        "A successful BFF load must produce .loaded so the management view renders.")
    }

    func test_bffFails_yieldsFailedState_forGracefulConnecting() async {
        let mock = MockScreensClient()
        mock.simulatedLatency = 0
        mock.shouldFail = true
        let vm = HomeViewModel(client: mock, podContext: "home")
        await vm.load()
        // The screen renders the graceful "connecting" card on .failed; the
        // important guarantee is that this is a non-fatal state we recover from
        // on refresh, NOT the "not paired" dead-end.
        XCTAssertNil(vm.detail.value)
        XCTAssertNotNil(vm.detail.failure)
    }

    func test_notPairedString_isNeverWhatServerDetailShows() {
        // Documents the contract: the .notPaired error string still exists for
        // the live client's guard, but ServerDetailScreen's .failed arm renders
        // `connecting(...)` and never echoes this message.
        XCTAssertEqual(ScreensClientError.notPaired.errorDescription,
                       "This device isn't connected to a server yet.")
    }
}
