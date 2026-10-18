import XCTest

/// GYM (mock tier): the bugs the Windows test agent found on the Android phone,
/// checked on iOS too: a retried pending order, Cancel order that blames the
/// connection, a stopped install with no way forward, Home's header names after
/// a relaunch, Add/Restore under a moving layout, and Add a device.
final class GymDeviceBugsTests: GymSweepCase {

    // MARK: Cancel order

    /// Cancel order fails once on the delivered page: the real reason shows
    /// under the button (not "check your connection"), the order stays, the
    /// button reads "Try cancelling again", and it then works.
    func test_cancelOrderFailsThenWorksOnTheDeliveredPage() throws {
        let app = launch(tab: "home", admin: true, ["-smoke-server-fresh", "-smoke-release-fails-once"])
        let add = app.buttons["home-add-server"]
        XCTAssertTrue(add.waitForExistence(timeout: 15))
        add.tap()
        app.chooseAddNewServer()
        let name = app.textFields["cs-name-field"]
        XCTAssertTrue(name.waitForExistence(timeout: 15))
        replaceText(name, with: "cellar")
        app.buttons["cs-next-button"].tap()
        app.buttons["cs-next-button"].tap()
        app.chooseBackupPolicy()
        app.buttons["cs-continue-button"].tap()
        app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Copy recipe to clipboard")).firstMatch.tap()
        let cancel = app.buttons["cs-cancel-order-button"]
        XCTAssertTrue(cancel.waitForExistence(timeout: 20), "The recipe is out: the delivered page.")
        XCTAssertEqual(cancel.label, "Cancel order")
        cancel.tap()
        let why = any(app, "cs-cancel-error")
        XCTAssertTrue(why.waitForExistence(timeout: 15), "A failed cancel says why.")
        XCTAssertTrue(why.label.hasPrefix("Couldn't cancel this order."), why.label)
        XCTAssertTrue(why.label.contains("temporarily unavailable"), why.label)
        XCTAssertFalse(why.label.lowercased().contains("check your connection"), "A healthy connection is not blamed: \(why.label)")
        XCTAssertFalse(why.label.contains("1102"), "No Cloudflare code on screen: \(why.label)")
        XCTAssertEqual(cancel.label, "Try cancelling again")
        shot(app, "cancel-order-failed")
        cancel.tap()
        expectProbe(app, "signed release-server-name by admin-root")
        XCTAssertTrue(app.staticTexts["Your servers"].waitForExistence(timeout: 15), "The retry cancels and returns to Home.")
    }

    // MARK: A stopped install

    /// The install stopped: no "(line 66)" on screen, a "Setup stopped" card
    /// offers to cancel and start again or to contact us; a failing cancel says
    /// why and offers "Try cancelling again", which works.
    func test_stoppedInstallOffersCancelAndContactUs() throws {
        let app = launch(tab: "home", admin: true, ["-smoke-pending-pod", "-smoke-install-stopped", "-smoke-release-fails-once"])
        let row = podRow(app, named: "Shed")
        XCTAssertTrue(reveal(app, row))
        row.tap()
        XCTAssertTrue(app.navigationBars["Pending"].waitForExistence(timeout: 10))
        let card = any(app, "setup-stopped")
        XCTAssertTrue(card.waitForExistence(timeout: 20), "A stopped install gets a Setup stopped card.")
        XCTAssertTrue(app.staticTexts["Setup stopped"].exists)
        XCTAssertFalse(text(app, containing: "(line 66)").exists, "The shell line number is not for people.")
        XCTAssertFalse(text(app, containing: "line 66").exists)
        XCTAssertTrue(text(app, containing: "Setup stopped while Expanding the disk to 68 GB").exists, "The step stays.")
        let contact = any(app, "setup-stopped-contact")
        XCTAssertTrue(reveal(app, contact), "Contact us is offered.")
        let startAgain = app.buttons["setup-stopped-start-again"]
        XCTAssertTrue(reveal(app, startAgain))
        XCTAssertEqual(startAgain.label, "Cancel order and start again")
        shot(app, "setup-stopped")
        startAgain.tap()
        let why = any(app, "setup-stopped-cancel-error")
        XCTAssertTrue(why.waitForExistence(timeout: 15))
        XCTAssertTrue(why.label.hasPrefix("Couldn't cancel this order."), why.label)
        XCTAssertEqual(startAgain.label, "Try cancelling again")
        startAgain.tap()
        expectProbe(app, "signed release-server-name by admin-root")
        XCTAssertTrue(app.buttons["home-add-server"].waitForExistence(timeout: 15), "Cancelling returns to Home.")
        waitGone(podRow(app, named: "Shed"))
    }
}
