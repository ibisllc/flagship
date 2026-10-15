import XCTest
@testable import FlagshipAPI
@testable import FlagshipUI

/// The install Live Activity's lifecycle: one per install, started by the
/// first checkpoint from any surface, never stepped back, ended by live or
/// error (Android parity: ProvisionProgressCenter / ProvisionNoticeModel).
@MainActor
final class InstallProgressBridgeTests: XCTestCase {

    private final class Recorder {
        var events: [String] = []
    }

    private func bridge(_ r: Recorder) -> InstallProgressBridge {
        let b = InstallProgressBridge()
        b.onStart = { key, name in r.events.append("start \(key) \(name ?? "-")") }
        b.onStep = { key, phase in r.events.append("step \(key) \(phase.rawValue)") }
        b.onComplete = { key, fqdn in r.events.append("live \(key) \(fqdn)") }
        b.onFailed = { key, reason in r.events.append("error \(key) \(reason)") }
        return b
    }

    func test_firstCheckpointStartsTheActivity_laterOnesOnlyAdvance() {
        let r = Recorder()
        let b = bridge(r)
        XCTAssertTrue(b.report(key: "AC-1", podName: "Home", phase: .booting))
        XCTAssertTrue(b.report(key: "AC-1", phase: .installing))
        XCTAssertTrue(b.report(key: "AC-1", phase: .live, serverDomain: "home.harry.flagship.services"))
        XCTAssertEqual(r.events, [
            "start AC-1 Home",
            "step AC-1 booting",
            "step AC-1 installing",
            "live AC-1 home.harry.flagship.services",
        ])
    }

    func test_lateAndRepeatedCheckpointsNeverStepBack() {
        let r = Recorder()
        let b = bridge(r)
        b.report(key: "AC-1", phase: .registering)
        XCTAssertFalse(b.report(key: "AC-1", phase: .registering), "a poll repeats the same phase")
        XCTAssertFalse(b.report(key: "AC-1", phase: .installing), "a late push must not step back")
        XCTAssertFalse(b.report(key: "AC-1", phase: .unknown))
        b.report(key: "AC-1", phase: .live)
        XCTAssertFalse(b.report(key: "AC-1", phase: .live))
        XCTAssertFalse(b.report(key: "AC-1", phase: .error), "nothing follows live")
        XCTAssertFalse(b.report(key: "AC-1", phase: .booting))
        XCTAssertEqual(r.events, ["start AC-1 -", "step AC-1 registering", "live AC-1 "])
    }

    func test_errorEndsItAndOnlyAFreshAttemptStartsAgain() {
        let r = Recorder()
        let b = bridge(r)
        b.report(key: "AC-1", podName: "Home", phase: .sealing)
        b.report(key: "AC-1", phase: .error, detail: "cert-issuance timed out")
        XCTAssertFalse(b.report(key: "AC-1", phase: .sealing), "a stale rung after the failure")
        XCTAssertTrue(b.report(key: "AC-1", phase: .booting), "the retry starts over")
        XCTAssertEqual(r.events, [
            "start AC-1 Home",
            "step AC-1 sealing",
            "error AC-1 cert-issuance timed out",
            "start AC-1 Home",
            "step AC-1 booting",
        ])
    }

    func test_anErrorWithoutDetailSaysSomethingPlain() {
        let r = Recorder()
        let b = bridge(r)
        b.report(key: "AC-1", phase: .error, detail: "")
        XCTAssertEqual(r.events, ["start AC-1 -", "error AC-1 \(InstallProgressBridge.defaultFailure)"])
    }

    func test_eachInstallHasItsOwnActivity() {
        let r = Recorder()
        let b = bridge(r)
        b.report(key: "AC-1", podName: "Home", phase: .installing)
        b.report(key: "AC-2", podName: "Office", phase: .booting)
        b.report(key: "AC-1", phase: .registering)
        XCTAssertEqual(r.events, [
            "start AC-1 Home", "step AC-1 installing",
            "start AC-2 Office", "step AC-2 booting",
            "step AC-1 registering",
        ])
    }

    func test_aPushNamesTheServerFromWhatThePollSawOrThePendingPod() {
        let r = Recorder()
        let b = bridge(r)
        b.nameForKey = { $0 == "AC-9" ? "Garage" : nil }
        b.report(key: "AC-9", phase: .registering)
        b.report(key: "AC-3", podName: "Home", phase: .booting)
        b.report(key: "AC-3", phase: .error)
        b.report(key: "AC-3", phase: .booting)
        XCTAssertEqual(r.events.filter { $0.hasPrefix("start") }, [
            "start AC-9 Garage", "start AC-3 Home", "start AC-3 Home",
        ])
    }

    func test_aPollStatusReportsItsPhaseDetailAndDomain() {
        let r = Recorder()
        let b = bridge(r)
        let status = ProvisionStatus(
            serial: "AC-1",
            serverDomain: "home.harry.flagship.services",
            phase: .live,
            detail: nil,
            updatedAt: 0,
            history: []
        )
        b.report(key: "AC-1", podName: "Home", status: status)
        XCTAssertEqual(r.events, ["start AC-1 Home", "live AC-1 home.harry.flagship.services"])
    }

    func test_emptyKeyIsIgnored() {
        let r = Recorder()
        XCTAssertFalse(bridge(r).report(key: "", phase: .booting))
        XCTAssertTrue(r.events.isEmpty)
    }
}
