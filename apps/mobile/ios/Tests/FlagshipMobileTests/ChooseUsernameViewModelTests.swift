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

    // Demo / test-account entry moved OUT of the create path and into
    // the username-first Join flow (LoginViewModel → /api/account/
    // resolve) per the login redesign. Create is create-only now; the
    // demo branch is exercised in LoginViewModelTests.

    func test_networkFailure_fallsBackToOptimisticAvailable() async {
        let server = makeServer()
        server.shouldFail = true
        let vm = makeViewModel(server)
        await vm.evaluate("harry")
        XCTAssertEqual(vm.status, .networkFallbackAvailable)
        XCTAssertTrue(vm.status.allowsContinue)
    }

    func test_interiorDashAccepted_doubleDashRejected() async {
        // Interior single dashes are now valid; `--` is the reserved
        // `<slug>--<creator>` delimiter and stays invalid
        // (docs/service-addressing-double-dash.md).
        let vm = makeViewModel(makeServer())
        await vm.evaluate("play-q2")
        XCTAssertEqual(vm.status, .available)
        await vm.evaluate("play--q2")
        if case .invalid = vm.status {} else {
            XCTFail("expected invalid status for `--`, got \(vm.status)")
        }
    }

    func test_tooShortUsername_rejected() async {
        // Usernames are 3–30 chars now. "ab" is too short.
        let vm = makeViewModel(makeServer())
        await vm.evaluate("ab")
        if case .invalid = vm.status {} else {
            XCTFail("expected invalid status, got \(vm.status)")
        }
    }

    func test_tooLongUsername_rejected() async {
        let vm = makeViewModel(makeServer())
        await vm.evaluate(String(repeating: "a", count: 31))
        if case .invalid = vm.status {} else {
            XCTFail("expected invalid status, got \(vm.status)")
        }
    }

    func test_workerInvalidReason_surfaced_asIs() async {
        // Surface the reason string Worker returns rather than
        // overwriting with a local copy — gives ops freedom to
        // tweak the wording without an app update.
        let vm = makeViewModel(makeServer())
        await vm.evaluate("-leadingdash")
        if case .invalid(let reason) = vm.status {
            XCTAssertTrue(reason.lowercased().contains("dash"), "expected a dash-rule reason, got: \(reason)")
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
    }
}
