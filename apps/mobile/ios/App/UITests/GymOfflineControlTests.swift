import XCTest

/// GYM iOS mock tier: Offline control (docs/data-sovereignty.md). With `-smoke-rescue <scenario>`
/// the screen runs its real view model against an in-process box (GymRescue, Debug builds only): the
/// server is found by its opaque Bonjour id, checked by its pinned key, and every action is an
/// owner-signed order the box checks. Scenarios: found, not found, wrong key, expired certificate,
/// an interrupted download that resumes, each offline control, a stranger refused, and the
/// account-gone screen's "Save my servers' data".
final class GymOfflineControlTests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    private func gymShot(_ app: XCUIApplication, _ point: String) {
        let a = XCTAttachment(screenshot: app.screenshot())
        a.name = "gym-screenshot:\(point)"
        a.lifetime = .keepAlways
        add(a)
    }

    private func launch(_ scenario: String, tab: String = "settings", _ extra: [String] = []) -> XCUIApplication {
        let app = XCUIApplication()
        app.terminate()
        app.launchArguments = ["-smoke-mode", "-smoke-tab", tab, "-smoke-rescue", scenario] + extra
        app.launch()
        return app
    }

    private func any(_ app: XCUIApplication, _ id: String) -> XCUIElement {
        app.descendants(matching: .any).matching(identifier: id).firstMatch
    }

    private func prefixed(_ app: XCUIApplication, _ prefix: String) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@", prefix)).firstMatch
    }

    private func text(_ el: XCUIElement) -> String { el.label.isEmpty ? ((el.value as? String) ?? "") : el.label }

    /// Scroll until `el` can be tapped.
    private func reveal(_ app: XCUIApplication, _ el: XCUIElement, max: Int = 12) {
        var n = 0
        while !(el.exists && el.isHittable) && n < max {
            app.swipeUp()
            n += 1
        }
    }

    private func openFromSettings(_ app: XCUIApplication) {
        let row = any(app, "settings-open-offline-control")
        XCTAssertTrue(row.waitForExistence(timeout: 30), "Settings always lists Offline control.")
        reveal(app, row)
        row.tap()
        XCTAssertTrue(any(app, "offline-control").waitForExistence(timeout: 10), "Offline control opens.")
    }

    private func connectHome(_ app: XCUIApplication) {
        let found = prefixed(app, "offline-found-")
        XCTAssertTrue(found.waitForExistence(timeout: 15), "The server is found on this Wi-Fi by its opaque id.")
        let connect = prefixed(app, "offline-connect-")
        connect.tap()
    }

    // 1. found: connect, see the status and apps, stop/start/restart an app, restart the server
    func test_foundServerConnectsAndEachControlIsSigned() throws {
        let app = launch("found")
        openFromSettings(app)
        connectHome(app)
        XCTAssertTrue(any(app, "offline-connected-title").waitForExistence(timeout: 15), "Connected, by key.")
        XCTAssertTrue(any(app, "offline-status").exists, "The status card shows.")
        gymShot(app, "offline-connected")
        let stop = prefixed(app, "offline-app-stop-")
        XCTAssertTrue(stop.waitForExistence(timeout: 5))
        let id = String(stop.identifier.dropFirst("offline-app-stop-".count))
        stop.tap()
        app.alerts.buttons["Stop"].tap()
        let state = any(app, "offline-app-state-\(id)")
        XCTAssertTrue(state.waitForExistence(timeout: 10))
        let stopped = NSPredicate(format: "label == 'Stopped'")
        expectation(for: stopped, evaluatedWith: state)
        waitForExpectations(timeout: 10)
        any(app, "offline-app-start-\(id)").tap()
        expectation(for: NSPredicate(format: "label == 'Running'"), evaluatedWith: state)
        waitForExpectations(timeout: 10)
        any(app, "offline-app-restart-\(id)").tap()
        app.alerts.buttons["Restart"].tap()
        let notice = any(app, "offline-notice")
        XCTAssertTrue(notice.waitForExistence(timeout: 10))
        XCTAssertTrue(text(notice).hasSuffix("was restarted."), text(notice))
        let restart = any(app, "offline-server-restart")
        reveal(app, restart)
        restart.tap()
        app.alerts.buttons["Restart"].tap()
        let after = any(app, "offline-notice")
        XCTAssertTrue(after.waitForExistence(timeout: 10))
        XCTAssertTrue(text(after).hasPrefix("The server is restarting."), text(after))
        gymShot(app, "offline-server-restarting")
    }

    // 2. not found: say so, then the typed address works
    func test_notFoundSaysSoAndATypedAddressConnects() throws {
        let app = launch("not-found")
        openFromSettings(app)
        prefixed(app, "offline-connect-").tap()
        let err = any(app, "offline-error")
        XCTAssertTrue(err.waitForExistence(timeout: 10))
        XCTAssertTrue(text(err).contains("wasn't found on this Wi-Fi"), text(err))
        gymShot(app, "offline-not-found")
        let name = any(app, "offline-manual-name")
        reveal(app, name)
        name.tap()
        let domain = text(prefixed(app, "offline-domain-"))
        XCTAssertTrue(domain.hasSuffix(".flagship.services"), domain)
        name.typeText(domain)
        let addr = any(app, "offline-manual-address")
        addr.tap()
        addr.typeText("192.168.1.20")
        let go = any(app, "offline-manual-connect")
        reveal(app, go)
        go.tap()
        XCTAssertTrue(any(app, "offline-connected-title").waitForExistence(timeout: 15), "The typed address connects.")
    }

    // 3. wrong key: a machine that can't prove the server's key gets nothing
    func test_aMachineWithAnotherKeyIsNotYourServer() throws {
        let app = launch("wrong-key")
        openFromSettings(app)
        connectHome(app)
        let err = any(app, "offline-error")
        XCTAssertTrue(err.waitForExistence(timeout: 15))
        XCTAssertTrue(text(err).hasPrefix("This isn't your server"), text(err))
        XCTAssertFalse(any(app, "offline-connected-title").exists)
        gymShot(app, "offline-wrong-key")
    }

    // 4. expired certificate: still works, checked by key, and says so
    func test_anExpiredCertificateStillWorksByKey() throws {
        let app = launch("expired-cert")
        openFromSettings(app)
        connectHome(app)
        XCTAssertTrue(any(app, "offline-connected-title").waitForExistence(timeout: 15))
        let note = any(app, "offline-cert-note")
        XCTAssertTrue(note.exists, "The note about the certificate shows.")
        XCTAssertTrue(text(note).contains("checked the server by its own key"), text(note))
        gymShot(app, "offline-expired-cert")
    }

    // 5. rescue my data: the download breaks halfway, Resume finishes it
    func test_anInterruptedDownloadResumes() throws {
        let app = launch("interrupt")
        openFromSettings(app)
        connectHome(app)
        XCTAssertTrue(any(app, "offline-connected-title").waitForExistence(timeout: 15))
        let rescue = any(app, "offline-rescue")
        reveal(app, rescue)
        rescue.tap()
        let saved = app.switches["offline-backup-passcode-saved"]
        reveal(app, saved)
        let start = any(app, "offline-backup-start")
        XCTAssertFalse(start.isEnabled, "The passcode must be saved first.")
        saved.tap()
        reveal(app, start)
        start.tap()
        let broke = any(app, "offline-backup-interrupted")
        XCTAssertTrue(broke.waitForExistence(timeout: 30), "The download stops halfway.")
        gymShot(app, "offline-download-interrupted")
        any(app, "offline-backup-resume").tap()
        XCTAssertTrue(any(app, "offline-backup-saved").waitForExistence(timeout: 30), "Resume finishes it.")
        XCTAssertTrue(any(app, "offline-backup-share").exists)
        gymShot(app, "offline-backup-saved")
    }

    // 6. a stranger's key: the server refuses, in its own words
    func test_theServerRefusesAStrangerInItsOwnWords() throws {
        let app = launch("stranger")
        openFromSettings(app)
        connectHome(app)
        let err = any(app, "offline-error")
        XCTAssertTrue(err.waitForExistence(timeout: 15))
        XCTAssertTrue(text(err).hasPrefix("The rescue session was refused: not signed by this server's owner key"), text(err))
        gymShot(app, "offline-stranger")
    }

    // 7. account removed: "Save my servers' data" comes first and opens Offline control
    func test_theAccountGoneScreenOffersToSaveTheServersData() throws {
        let app = launch("found", tab: "home", ["-smoke-admin-root", "-gym-account-gone", "6"])
        let save = app.buttons["account-gone-save"]
        XCTAssertTrue(save.waitForExistence(timeout: 40), "The removed-account screen offers to save the servers' data.")
        XCTAssertLessThan(save.frame.minY, app.buttons["account-gone-create"].frame.minY, "It comes first.")
        gymShot(app, "account-gone-save")
        save.tap()
        XCTAssertTrue(any(app, "offline-control").waitForExistence(timeout: 10))
        connectHome(app)
        XCTAssertTrue(any(app, "offline-connected-title").waitForExistence(timeout: 15), "Rescue works with the account gone.")
    }
}
