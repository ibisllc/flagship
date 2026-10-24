import XCTest

/// GYM iOS, first contact (docs/first-contact.md), mock tier. `-smoke-approval-pending` has Home ask to
/// serve, signed by its own key; the `-smoke-fc-*` seams decide what this device holds
/// (GymSweepSeams+FirstContact.swift).
final class GymFirstContactTests: GymSweepCase {
    private func openApprovals(_ app: XCUIApplication) {
        let header = app.buttons["activity-section-approvals"]
        XCTAssertTrue(reveal(app, header), "The approvals section is listed.")
        if (header.value as? String) != "expanded" { header.tap() }
        wait(header, "value == 'expanded'")
    }

    private func box(_ app: XCUIApplication, _ id: String) -> XCUIElement {
        app.descendants(matching: .any).matching(identifier: id).firstMatch
    }

    /// The device that made the recipe: the proof checks out, the code computed on the phone sits in a
    /// small box right above Approve, and approving pins the key and hands the server its app-name grant.
    func test_firstBlessingShowsTheCodeAboveApproveAndPins() throws {
        let app = launch(tab: "activity", admin: true, ["-smoke-approval-pending", "-smoke-fc-recipe"])
        openApprovals(app)
        let code = box(app, "first-contact-code")
        XCTAssertTrue(code.waitForExistence(timeout: 20), "The code box shows for a server not pinned yet.")
        XCTAssertNotNil(code.label.range(of: #"^If your machine has a monitor, it is showing this code: \d{3} \d{3}$"#,
                                         options: .regularExpression), "Got: \(code.label)")
        let approve = button(app, "Yes, this is my server")
        XCTAssertTrue(approve.exists)
        XCTAssertLessThan(code.frame.maxY, approve.frame.minY + 1, "The code sits directly above Approve.")
        shot(app, "first-contact-code")
        approve.tap()
        waitGone(approve, timeout: 20)
        expectProbe(app, "app-name grant delivered", timeout: 20)
    }

    /// Studio read the same key on the server's console: "Confirmed by Studio" in place of the code.
    func test_studioConfirmationReplacesTheCode() throws {
        let app = launch(tab: "activity", admin: true, ["-smoke-approval-pending", "-smoke-fc-recipe", "-smoke-fc-studio"])
        openApprovals(app)
        let studio = box(app, "first-contact-studio")
        XCTAssertTrue(studio.waitForExistence(timeout: 20))
        XCTAssertTrue(studio.label.contains("Confirmed by Studio"), "Got: \(studio.label)")
        XCTAssertFalse(box(app, "first-contact-code").exists)
        shot(app, "first-contact-studio")
    }

    /// The proof fails: refused and said so, and there is no Approve.
    func test_aServerNotBuiltFromTheRecipeIsRefused() throws {
        let app = launch(tab: "activity", admin: true, ["-smoke-approval-pending", "-smoke-fc-bad-proof"])
        openApprovals(app)
        let refused = box(app, "first-contact-refused")
        XCTAssertTrue(refused.waitForExistence(timeout: 20))
        XCTAssertTrue(refused.label.contains("This server was not built from your recipe. Do not approve it."), "Got: \(refused.label)")
        XCTAssertFalse(button(app, "Yes, this is my server").exists, "No Approve for a refused server.")
        shot(app, "first-contact-not-from-recipe")
    }

    /// A pinned server asking under another key: refused and shown.
    func test_aChangedKeyIsRefused() throws {
        let app = launch(tab: "activity", admin: true, ["-smoke-approval-pending", "-smoke-fc-key-changed"])
        openApprovals(app)
        let refused = box(app, "first-contact-refused")
        XCTAssertTrue(refused.waitForExistence(timeout: 20))
        XCTAssertTrue(refused.label.contains("This server's key changed. If you did not rebuild it, do not approve anything for it."),
                      "Got: \(refused.label)")
        XCTAssertFalse(button(app, "Yes, this is my server").exists)
        shot(app, "first-contact-key-changed")
    }
}
