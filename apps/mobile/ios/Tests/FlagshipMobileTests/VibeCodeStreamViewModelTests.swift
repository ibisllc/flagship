import XCTest
@testable import FlagshipAPI
@testable import FlagshipUI

/// The live vibe-code stream VM. The load-bearing assertion is the
/// `buildLogs` tail cap: the WebSocket emits a `.buildLog` frame per build
/// step for as long as a build runs, the logs card renders every retained
/// line as a live row, and a TabView keeps the VM alive while the user
/// works in another tab — so an uncapped append is unbounded memory growth
/// on a ~minutes timescale.
@MainActor
final class VibeCodeStreamViewModelTests: XCTestCase {

    private func makeVM() -> VibeCodeStreamViewModel {
        let c = MockScreensClient()
        c.simulatedLatency = 0
        return VibeCodeStreamViewModel(sessionId: "vc-test", client: c)
    }

    func test_buildLogs_underCap_keepsEveryLine() {
        let vm = makeVM()
        vm.apply(.repoCreate(repoFullName: "me/app"))
        vm.apply(.buildStart)
        for i in 0..<10 { vm.apply(.buildLog(line: "line \(i)")) }
        XCTAssertEqual(vm.buildLogs.count, 12)
        XCTAssertEqual(vm.buildLogs.first, "Created git repo.")
        XCTAssertEqual(vm.buildLogs.last, "line 9")
    }

    func test_buildLogs_cappedToSlidingTailWindow() {
        let vm = makeVM()
        vm.apply(.buildStart)
        let cap = VibeCodeStreamViewModel.buildLogCap
        let total = cap + 250
        for i in 0..<total { vm.apply(.buildLog(line: "line \(i)")) }
        XCTAssertEqual(vm.buildLogs.count, cap)
        // The window is the TAIL: the newest line is retained verbatim and
        // the oldest retained line is exactly `cap` back from the end.
        XCTAssertEqual(vm.buildLogs.last, "line \(total - 1)")
        XCTAssertEqual(vm.buildLogs.first, "line \(total - cap)")
    }

    func test_buildLogs_capHolds_acrossMixedFrames() {
        let vm = makeVM()
        let cap = VibeCodeStreamViewModel.buildLogCap
        for i in 0..<(cap * 2) {
            vm.apply(.buildLog(line: "line \(i)"))
            vm.apply(.token(text: "t"))
        }
        vm.apply(.deploy(serviceId: "svc", url: "https://x.example"))
        XCTAssertEqual(vm.buildLogs.count, cap)
        XCTAssertEqual(vm.deployedServiceId, "svc")
        // Tokens still accumulate into the transcript untouched by the cap.
        XCTAssertEqual(vm.transcript.count, cap * 2)
    }
}
