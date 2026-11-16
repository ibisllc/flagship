import XCTest
@testable import Flagship

/// The phone's bare name must stay held while a voi.ci call rings or runs, foreground or not: CallKit answers with the
/// app in the background, and the caller's media reaches the phone only through that name (docs/voici-calls.md §4).
final class PhoneRouteLifecycleTests: XCTestCase {
    func testForegroundOnlyWithoutCalls() {
        var l = PhoneRouteLifecycle()
        XCTAssertTrue(l.enterForeground())
        XCTAssertFalse(l.enterBackground())
    }

    func testCallAnsweredInTheBackgroundHoldsTheRoute() {
        var l = PhoneRouteLifecycle()
        XCTAssertTrue(l.callStarted(), "a call that rings with the app in the background opens the tunnel")
        XCTAssertTrue(l.enterBackground(), "a background notice during the call keeps it open")
        XCTAssertFalse(l.callEnded(), "the call ended in the background: close")
    }

    func testLeavingTheForegroundDuringACallKeepsTheRoute() {
        var l = PhoneRouteLifecycle()
        _ = l.enterForeground()
        _ = l.callStarted()
        XCTAssertTrue(l.enterBackground())
        XCTAssertFalse(l.callEnded())
    }

    func testCallEndingInTheForegroundKeepsTheRoute() {
        var l = PhoneRouteLifecycle()
        _ = l.callStarted()
        _ = l.enterForeground()
        XCTAssertTrue(l.callEnded())
        XCTAssertTrue(l.callEnded(), "an extra end never goes below zero")
        XCTAssertFalse(l.enterBackground())
    }
}
