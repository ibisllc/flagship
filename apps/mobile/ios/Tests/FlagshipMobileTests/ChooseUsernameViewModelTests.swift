import XCTest
@testable import FlagshipAPI
@testable import FlagshipUI

@MainActor
final class ChooseUsernameViewModelTests: XCTestCase {

    private func makeServer() -> MockFlagshipServerClient {
        let s = MockFlagshipServerClient()
        s.simulatedLatency = 0
        return s
    }

    private func makeViewModel(_ server: MockFlagshipServerClient) -> ChooseUsernameViewModel {
        // Debounce 0 keeps tests deterministic — we test the
        // debounce-cancel path separately.
        return ChooseUsernameViewModel(server: server, debounceMillis: 0)
    }

    func test_emptyInput_isEmptyStatus() async {
        let vm = makeViewModel(makeServer())
        await vm.evaluate("")
        XCTAssertEqual(vm.status, .empty)
    }

    func test_invalidInput_yieldsInvalidStatus() async {
        let vm = makeViewModel(makeServer())
        await vm.evaluate("Bad Spaces!")
        if case .invalid = vm.status { /* ok */ } else {
            XCTFail("expected invalid status, got \(vm.status)")
        }
    }

    func test_validInputAvailable_yieldsAvailable() async {
        let vm = makeViewModel(makeServer())
        await vm.evaluate("harry42")
        XCTAssertEqual(vm.status, .available)
    }

    func test_workerSaysClaimed_yieldsTaken() async {
        let server = makeServer()
        try? await server.claimUsername(.init(
            request: .init(username: "harry", irkPub: "deadbeef", issuedAt: 1),
            signature: "sig"
        ))
        let vm = makeViewModel(server)
        await vm.evaluate("harry")
        XCTAssertEqual(vm.status, .taken)
    }

    func test_workerSaysReserved_yieldsInvalid() async {
        let vm = makeViewModel(makeServer())
        await vm.evaluate("root")
        if case .invalid(let reason) = vm.status {
            // Surface Worker's reason verbatim so wording updates
            // server-side without an app release.
            XCTAssertTrue(reason.contains("reserved"), "expected reserved-reason, got: \(reason)")
        } else {
            XCTFail("expected invalid, got \(vm.status)")
        }
    }

    func test_testAccountHit_yieldsTestAccountStatus() async {
        let server = makeServer()
        server.testAccounts = [
            "play-q2": TestAccountMeta(display: "Play Reviewer", ttlHours: 12),
        ]
        let vm = makeViewModel(server)
        await vm.evaluate("play-q2")
        XCTAssertEqual(vm.status.testAccountMeta?.display, "Play Reviewer")
        XCTAssertTrue(vm.status.allowsContinue)
    }

    func test_caseInsensitive_lowercasesBeforeWorker() async {
        let server = makeServer()
        server.testAccounts = [
            "play-q2": TestAccountMeta(display: "Play Reviewer", ttlHours: 12),
        ]
        let vm = makeViewModel(server)
        await vm.evaluate("Play-Q2")
        XCTAssertNotNil(vm.status.testAccountMeta)
    }

    func test_networkFailure_fallsBackToOptimisticAvailable() async {
        let server = makeServer()
        server.shouldFail = true
        let vm = makeViewModel(server)
        await vm.evaluate("harry")
        XCTAssertEqual(vm.status, .networkFallbackAvailable)
        XCTAssertTrue(vm.status.allowsContinue)
    }

    func test_hyphenatedUsername_rejected() async {
        // Usernames are hyphen-free now (so serviceId `<creator>-<slug>`
        // parses unambiguously). A hyphenated handle is invalid.
        let vm = makeViewModel(makeServer())
        await vm.evaluate("play-q2")
        if case .invalid = vm.status {} else {
            XCTFail("expected invalid status, got \(vm.status)")
        }
    }

    func test_workerInvalidReason_surfaced_asIs() async {
        // Surface the reason string Worker returns rather than
        // overwriting with a local copy — gives ops freedom to
        // tweak the wording without an app update.
        let vm = makeViewModel(makeServer())
        await vm.evaluate("-leading-hyphen")
        if case .invalid(let reason) = vm.status {
            XCTAssertTrue(reason.lowercased().contains("hyphen"), "expected a no-hyphens reason, got: \(reason)")
        } else {
            XCTFail("expected invalid status, got \(vm.status)")
        }
    }

    func test_statusAllowsContinue_onlyOnTerminalGreen() {
        XCTAssertFalse(ChooseUsernameViewModel.Status.empty.allowsContinue)
        XCTAssertFalse(ChooseUsernameViewModel.Status.invalid("x").allowsContinue)
        XCTAssertFalse(ChooseUsernameViewModel.Status.checking.allowsContinue)
        XCTAssertFalse(ChooseUsernameViewModel.Status.taken.allowsContinue)
        XCTAssertTrue(ChooseUsernameViewModel.Status.available.allowsContinue)
        XCTAssertTrue(ChooseUsernameViewModel.Status.networkFallbackAvailable.allowsContinue)
        XCTAssertTrue(ChooseUsernameViewModel.Status.testAccount(.init(display: "X", ttlHours: 6)).allowsContinue)
    }
}
