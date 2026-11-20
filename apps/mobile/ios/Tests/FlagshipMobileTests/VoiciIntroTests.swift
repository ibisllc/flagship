import XCTest
@testable import FlagshipCore
@testable import FlagshipUI

/// The new account's one-time "Turn on safe messages, calls and posts" offer (owner, 2026-11-20; VoiciIntro): armed only
/// by the create flow, shown once per account on this device, and the promo line only when `.com` sends one.
@MainActor
final class VoiciIntroTests: XCTestCase {
    private func defaults() throws -> UserDefaults {
        let d = try XCTUnwrap(UserDefaults(suiteName: "VoiciIntroTests"))
        d.removePersistentDomain(forName: "VoiciIntroTests")
        return d
    }

    func test_armedOnceThenTakenOnce() throws {
        let d = try defaults()
        let app = AppState()
        XCTAssertFalse(VoiciIntro.take(username: "bright-maple", defaults: d), "Nothing armed: joining, signing in or a restore never show it.")
        VoiciIntro.arm(app, username: "Bright-Maple", defaults: d)
        XCTAssertEqual(app.pendingVoiciIntro, "Bright-Maple")
        XCTAssertTrue(VoiciIntro.isPending(username: "bright-maple", defaults: d))
        XCTAssertTrue(VoiciIntro.take(username: "bright-maple", defaults: d))
        XCTAssertFalse(VoiciIntro.take(username: "bright-maple", defaults: d), "Shown once per account on this device.")
        app.pendingVoiciIntro = nil
        VoiciIntro.arm(app, username: "bright-maple", defaults: d)
        XCTAssertNil(app.pendingVoiciIntro, "An account that saw it is never armed again.")
        XCTAssertFalse(VoiciIntro.isPending(username: "other-name", defaults: d))
    }

    func test_promoTextOnlyWhenComSendsOne() {
        XCTAssertEqual(VoiciIntro.promoText(Data(#"{"promo":{"text":" A free month. ","until":null}}"#.utf8)), "A free month.")
        XCTAssertNil(VoiciIntro.promoText(Data(#"{"promo":null}"#.utf8)))
        XCTAssertNil(VoiciIntro.promoText(Data(#"{"promo":{"text":""}}"#.utf8)))
        XCTAssertNil(VoiciIntro.promoText(Data("nope".utf8)))
    }
}
