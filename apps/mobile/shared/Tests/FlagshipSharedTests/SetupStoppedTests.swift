import XCTest
@testable import FlagshipAPI
@testable import FlagshipCore

final class SetupStoppedTests: XCTestCase {
    func test_failureDetailDropsTheShellLineNumber() {
        XCTAssertEqual(
            ProvisionProgress.failureDetail("Setup stopped while Expanding the disk to 68 GB (line 66)"),
            "Setup stopped while Expanding the disk to 68 GB"
        )
        XCTAssertEqual(
            ProvisionProgress.failureDetail("Setup stopped while Expanding the disk at line 66"),
            "Setup stopped while Expanding the disk"
        )
    }

    func test_theBoxsOwnWordsStay() {
        XCTAssertEqual(ProvisionProgress.failureDetail("cert-issuance timed out"), "cert-issuance timed out")
        XCTAssertEqual(ProvisionProgress.failureDetail("boom"), "boom")
        XCTAssertEqual(ProvisionProgress.failureDetail("rate limited by ACME"), "rate limited by ACME")
    }

    func test_anEmptyOrRawReportBecomesThePhaseTitle() {
        let title = ProvisionProgress.phaseTitles["error"]
        XCTAssertEqual(ProvisionProgress.failureDetail(nil), title)
        XCTAssertEqual(ProvisionProgress.failureDetail("  "), title)
        XCTAssertEqual(ProvisionProgress.failureDetail("error code: 1102"), title)
        XCTAssertEqual(ProvisionProgress.failureDetail("{\"x\":1}"), title)
    }

    func test_theChecklistAndTheTimelineCarryTheStrippedText() {
        let steps = ProvisionProgress.stepStates(phase: "error", lastError: "Disk full (line 12)", prevPhase: "installing")
        XCTAssertEqual(steps.first(where: { $0.state == .failed })?.detail, "Disk full")
        let status = ProvisionStatus(
            serial: "S", phase: .error, detail: "Disk full (line 12)", updatedAt: 1,
            history: [ProvisionStatusEntry(phase: .installing, detail: nil, ts: 1)]
        )
        let failed = ProvisionTimelineLadder.rows(for: status).first(where: { $0.state == .error })
        XCTAssertEqual(failed?.detail, "Disk full")
    }

    func test_contactUsMailNamesTheOrderAndTheStep() throws {
        let url = try XCTUnwrap(SupportContact.setupStoppedURL(serial: "ABCD-1234", step: "Disk full"))
        XCTAssertEqual(url.scheme, "mailto")
        let s = url.absoluteString
        XCTAssertTrue(s.hasPrefix("mailto:support@flagshipserver.com?subject="), s)
        let comps = try XCTUnwrap(URLComponents(string: s))
        let body = comps.queryItems?.first(where: { $0.name == "body" })?.value ?? ""
        XCTAssertTrue(body.contains("Order: ABCD-1234"), body)
        XCTAssertTrue(body.contains("Step: Disk full"), body)
    }

    func test_wellFormedServerNames() {
        XCTAssertTrue(Endpoints.isWellFormedServerFqdn("home.harry.flagship.services", apex: "flagship.services"))
        XCTAssertTrue(Endpoints.isWellFormedServerFqdn("Home.Harry.Flagship.Services", apex: "flagship.services"))
        for bad in ["server.flagship.services", "flagship.services", ".harry.flagship.services",
                    "home..flagship.services", "home.harry.example.com", ""] {
            XCTAssertFalse(Endpoints.isWellFormedServerFqdn(bad, apex: "flagship.services"), bad)
        }
    }
}
