import XCTest
import FlagshipCore
@testable import FlagshipUI

/// The "add a server" provision-vs-pair chooser (parity with the webapp +
/// Android). The screen existed but was never wired; `HomeRoute.addServer` now
/// shows it and forks to `.provisionServer` (provision) vs. the pair-guidance
/// path. The XCUITest `test_createServerFormReachable` drives the live nav
/// (Home → chooser → Provision → form); these are the fast contract checks.
@MainActor
final class AddServerChooserTests: XCTestCase {
    /// The fork is a real two-destination split — the chooser route and the
    /// provision route are distinct, so the chooser owns the decision.
    func test_homeRoute_hasDistinctChooserAndProvisionCases() {
        XCTAssertNotEqual(HomeRoute.addServer, HomeRoute.provisionServer)
    }

    /// Each card invokes its own callback (the contract the parent wires to
    /// provision vs. the pair-guidance toast). The codebase tests SwiftUI
    /// callbacks by invocation rather than ViewInspector taps.
    func test_chooser_invokesProvisionAndPairCallbacksIndependently() {
        var provisioned = 0
        var paired = 0
        let screen = AddServerChooserScreen(
            mode: .inApp,
            onProvision: { provisioned += 1 },
            onPair: { paired += 1 }
        )
        screen.onProvision()
        XCTAssertEqual(provisioned, 1)
        XCTAssertEqual(paired, 0)
        screen.onPair()
        XCTAssertEqual(provisioned, 1)
        XCTAssertEqual(paired, 1)
    }
}
