import XCTest

/// GYM iOS mock tier for the outbound proxy's Pro gate and failure UX (docs/outbound-proxy.md): the Pro row in the
/// create flow on Free, the server page's red line for each failure code and the fallback line, Home's badge from
/// `/pods`, the `.com` lane when the box can't be reached, and the lane's refusal to carry a password.
/// Seams: GymSweepSeams+Proxy.swift.
final class GymProxyTests: GymSweepCase {
    private func flip(_ toggle: XCUIElement) {
        toggle.coordinate(withNormalizedOffset: CGVector(dx: 0.93, dy: 0.5)).tap()
    }

    private func launchProxy(_ extra: [String]) -> XCUIApplication {
        launch(tab: "home", admin: true, ["-smoke-server-fresh"] + extra)
    }

    private func alertLine(_ app: XCUIApplication) -> XCUIElement { any(app, "sd-proxy-alert") }

    /// Home → the Home server's page. Home's list springs into place after launch, and a tap during that
    /// settle is dropped, so wait, then tap again if the page didn't open.
    private func openHome(_ app: XCUIApplication, file: StaticString = #filePath, line: UInt = #line) {
        let row = podRow(app, named: "Home")
        XCTAssertTrue(reveal(app, row), "The Home server row should be on Home.", file: file, line: line)
        let page = app.serverPageBackButton(named: "Home")
        for _ in 0..<4 {
            sleep(2)
            if row.exists && row.isHittable { row.tap() }
            if page.waitForExistence(timeout: 8) { return }
        }
        XCTFail("Tapping Home should open its server page.", file: file, line: line)
    }

    /// Add / Restore a server → Create a new server, with the button scrolled clear of the tab bar.
    private func openCreate(_ app: XCUIApplication, file: StaticString = #filePath, line: UInt = #line) {
        let add = app.buttons["home-add-server"]
        XCTAssertTrue(add.waitForExistence(timeout: 15), file: file, line: line)
        app.swipeUp()
        let create = app.buttons.matching(identifier: "home-add-new-server").firstMatch
        for _ in 0..<4 {
            sleep(2)
            if add.isHittable { add.tap() }
            if create.waitForExistence(timeout: 6) { create.tap(); return }
        }
        XCTFail("Add/Restore should offer Create a new server.", file: file, line: line)
    }

    // ─── The Pro gate ─────────────────────────────────────────────────────────

    func test_freeAccountSeesTheProRowInsteadOfTheFields() throws {
        let app = launchProxy(["-smoke-account-free"])
        openCreate(app)
        let name = app.textFields["cs-name-field"]
        XCTAssertTrue(name.waitForExistence(timeout: 15))
        app.typeServerName(name, "cellar")
        app.buttons["cs-next-button"].tap()
        let advanced = app.switches["cs-advanced-toggle"]
        XCTAssertTrue(reveal(app, advanced), "Step 1 offers Advanced mode.")
        flip(advanced)
        let pro = any(app, "proxy-pro")
        XCTAssertTrue(reveal(app, pro), "On Free the proxy is a Pro row with a link.")
        XCTAssertFalse(any(app, "proxy-host").exists, "No proxy fields on Free.")
        shot(app, "proxy-create-free")
    }

    // ─── The server page's lines ──────────────────────────────────────────────

    func test_failingLineSaysWhyForEachCode() throws {
        let reasons = [
            "unreachable": "Can't reach the proxy.",
            "auth": "The proxy refused the username or password.",
            "refused": "The proxy refused the connection.",
            "protocol": "The proxy gave an answer the server doesn't understand.",
            "something-new": "Can't reach the proxy.",
        ]
        for (code, reason) in reasons.sorted(by: { $0.key < $1.key }) {
            let app = launchProxy(["-smoke-proxy-failing", code])
            openHome(app)
            let line = alertLine(app)
            XCTAssertTrue(line.waitForExistence(timeout: 20), "A failing proxy shows the red line (\(code)).")
            XCTAssertEqual(line.label, "The outbound proxy isn't working: \(reason)", code)
            XCTAssertFalse(line.label.contains("box English"), "The box's English line is never shown.")
            XCTAssertFalse(any(app, "sd-proxy-alert-offline").exists, "The box answers, so it isn't offline.")
            if code == "auth" { shot(app, "proxy-failing-auth") }
        }
    }

    func test_fallbackLineIsAWarning() throws {
        let app = launchProxy(["-smoke-proxy-fallback"])
        openHome(app)
        let line = alertLine(app)
        XCTAssertTrue(line.waitForExistence(timeout: 20))
        XCTAssertEqual(line.label, "The outbound proxy isn't working, so this server is connecting directly: The proxy refused the connection.")
        shot(app, "proxy-fallback")
    }

    func test_homeBadgeFromPods() throws {
        let app = launchProxy(["-smoke-proxy-pods-alert"])
        let badge = any(app, "pod-card-proxy-alert")
        XCTAssertTrue(badge.waitForExistence(timeout: 20), "Home marks the server whose proxy fails.")
        XCTAssertEqual(badge.label, "Outbound proxy not working")
        shot(app, "proxy-home-badge")
    }

    // ─── The lane through .com ────────────────────────────────────────────────

    /// The box can't be reached and `/pods` says its proxy is why: the page says so from `/pods`, and Turn off
    /// goes through `.com`'s lane.
    func test_offlineServerTurnsTheProxyOffThroughTheLane() throws {
        let app = launchProxy(["-smoke-proxy-offline"])
        openHome(app)
        let line = alertLine(app)
        XCTAssertTrue(line.waitForExistence(timeout: 20), "The red line shows from /pods while the box is unreachable.")
        XCTAssertEqual(line.label, "The outbound proxy isn't working: The proxy refused the username or password.")
        XCTAssertTrue(any(app, "sd-proxy-alert-offline").exists, "It says the server stays offline until the proxy is fixed.")
        let off = app.buttons["sd-proxy-turn-off"]
        XCTAssertTrue(reveal(app, off), "Turn off is offered while the box is offline.")
        off.tap()
        expectProbe(app, "lane proxy none for home.")
        XCTAssertTrue(text(app, containing: "Sent. The server picks up the change").waitForExistence(timeout: 10))
        expectNoProbe(app, "box proxy")
        shot(app, "proxy-lane-sent")
    }

    /// The box answers its page but not the order (a timeout): the same signed order goes through the lane.
    func test_unreachableBoxTakesTheOrderThroughTheLane() throws {
        let app = launchProxy(["-smoke-proxy-failing", "unreachable", "-smoke-proxy-set-unreachable"])
        openHome(app)
        let off = app.buttons["sd-proxy-turn-off"]
        XCTAssertTrue(reveal(app, off))
        off.tap()
        expectProbe(app, "box proxy none")
        expectProbe(app, "lane proxy none for home.")
        XCTAssertTrue(text(app, containing: "Sent. The server picks up the change").waitForExistence(timeout: 10))
    }

    /// A new password can't go through the lane: it says why and sends nothing to `.com`.
    func test_laneRefusesANewPassword() throws {
        let app = launchProxy(["-smoke-proxy-failing", "auth", "-smoke-proxy-set-unreachable"])
        openHome(app)
        let change = app.buttons["sd-proxy-change"]
        XCTAssertTrue(reveal(app, change))
        change.tap()
        let user = app.textFields["proxy-username"]
        XCTAssertTrue(user.waitForExistence(timeout: 10))
        user.tap()
        user.typeText("maple")
        let pass = app.secureTextFields["proxy-password"]
        pass.tap()
        pass.typeText("new-secret")
        let save = app.buttons["proxy-save"]
        wait(save, "isEnabled == true")
        save.tap()
        expectProbe(app, "box proxy socks5 with credentials")
        let refusal = text(app, containing: "Flagship never carries proxy passwords.")
        XCTAssertTrue(refusal.waitForExistence(timeout: 10), "The lane refuses a new password.")
        expectNoProbe(app, "lane proxy")
        shot(app, "proxy-lane-password")
    }
}
