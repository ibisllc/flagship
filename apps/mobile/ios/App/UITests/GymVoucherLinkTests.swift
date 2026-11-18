import XCTest

/// GYM iOS (mock tier): "Load into Flagship" (docs/anonymous-vouchers.md "Voucher links"). The app opens a link with
/// three vouchers signed by the mock `.com` (`-smoke-voucher-link`): Add puts $3 in the balance; the same link again
/// adds nothing and says so; a truncated copy says the link is damaged. The screen never names the web shop.
final class GymVoucherLinkTests: GymSweepCase {

    private func label(_ app: XCUIApplication, _ id: String, timeout: TimeInterval = 20) -> String {
        let el = app.descendants(matching: .any)[id]
        guard el.waitForExistence(timeout: timeout) else { return "" }
        return el.label
    }

    func test_voucherLinkAddsOnceThenSaysAlreadyThenDamaged() throws {
        let app = launch(tab: "settings", ["-smoke-voucher-link"])
        let title = label(app, "voucher-link-title", timeout: 40)
        XCTAssertTrue(title.contains("Add 3 vouchers"), "The link asks before adding. Got: \(title)")
        XCTAssertTrue(title.contains("$3"), "Got: \(title)")
        for gone in ["Card", "Stripe", "flagshipserver.com", "Buy on the web"] {
            XCTAssertFalse(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", gone)).firstMatch.exists,
                           "The voucher screen never points to the web shop: \(gone)")
        }
        shot(app, "voucher-link-confirm")
        app.buttons["voucher-link-add"].tap()
        let added = label(app, "voucher-link-added")
        XCTAssertTrue(added.contains("$3"), "Added to the balance. Got: \(added)")
        shot(app, "voucher-link-added")
        app.buttons["voucher-link-done"].tap()

        // The same link again: nothing to add.
        let again = label(app, "voucher-link-refused")
        XCTAssertEqual(again, "These vouchers are already in this wallet. Nothing was added.")
        shot(app, "voucher-link-already")
        app.buttons["voucher-link-done"].tap()

        // A truncated copy.
        let damaged = label(app, "voucher-link-refused")
        XCTAssertEqual(damaged, "This voucher link is incomplete or damaged. Open the whole link again, or use the voucher file.")
        shot(app, "voucher-link-damaged")
        app.buttons["voucher-link-done"].tap()

        // The balance moved by $3 (Settings → Plan).
        let entry = app.buttons["settings-open-plan"]
        if !entry.exists { _ = reveal(app, entry, tries: 10) }
        XCTAssertTrue(entry.waitForExistence(timeout: 10), "Settings should offer the plan screen.")
        entry.tap()
        let balance = app.descendants(matching: .any)["plan-balance"]
        XCTAssertTrue(balance.waitForExistence(timeout: 20))
        expectation(for: NSPredicate(format: "label CONTAINS '$3'"), evaluatedWith: balance)
        waitForExpectations(timeout: 30)
    }
}
