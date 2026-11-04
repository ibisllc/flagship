import XCTest

/// Store screenshots (docs/store-assets/capture-plan.md): the real app over the made-up world in
/// store/demo-world.json (`-smoke-store-world`), one language per run, light and dark by the slide's place
/// in the strip, written as `<id>.png` (01-06; the watch's 07/07b come from capture-ios.sh). Opt-in (skipped
/// unless `STORE_OUT` is set); run it through
/// scripts/store-assets/capture-ios.sh, which passes:
///
///   TEST_RUNNER_STORE_LANG=ja TEST_RUNNER_STORE_OUT=/abs/store/captures/ios/ja/iphone-6.9 \
///   TEST_RUNNER_STORE_WORLD=/abs/store/demo-world.json xcodebuild test ... \
///     -only-testing:FlagshipAppUITests/StoreCaptureTests
///
/// Every step finds its element by identifier or by a demo-world name, never by English text, so the same
/// walk works in every language.
final class StoreCaptureTests: XCTestCase {
    private var outDir: URL!
    private var lang = "en"
    private var world = ""
    private var isPad: Bool { UIDevice.current.userInterfaceIdiom == .pad }

    override func setUpWithError() throws {
        continueAfterFailure = false
        let env = ProcessInfo.processInfo.environment
        guard let dir = env["STORE_OUT"], !dir.isEmpty, let worldPath = env["STORE_WORLD"] else {
            throw XCTSkip("Set TEST_RUNNER_STORE_OUT and TEST_RUNNER_STORE_WORLD to capture store screenshots.")
        }
        outDir = URL(fileURLWithPath: dir, isDirectory: true)
        try FileManager.default.createDirectory(at: outDir, withIntermediateDirectories: true)
        world = try String(contentsOfFile: worldPath, encoding: .utf8)
        lang = env["STORE_LANG"] ?? "en"
        if isPad { XCUIDevice.shared.orientation = .landscapeLeft }
    }

    private var locale: String {
        switch lang {
        case "en": return "en_US"
        case "ja": return "ja_JP"
        case "zh-Hans": return "zh_CN"
        case "pt-BR": return "pt_BR"
        default: return "\(lang)_\(lang.uppercased())"
        }
    }

    private func launch(_ tab: String, dark: Bool, _ extra: [String] = []) -> XCUIApplication {
        XCUIDevice.shared.appearance = dark ? .dark : .light
        let app = XCUIApplication()
        app.launchArguments = ["-AppleLanguages", "(\(lang))", "-AppleLocale", locale,
                               "-smoke-mode", "-smoke-tab", tab, "-smoke-admin-root", "-smoke-recovery-enrolled",
                               "-smoke-username", "river-otter", "-smoke-store-world",
                               "-smoke-theme", dark ? "dark" : "light"] + extra
        app.launchEnvironment["FLAGSHIP_STORE_WORLD"] = world
        app.launch()
        return app
    }

    private func shot(_ app: XCUIApplication, _ id: String) throws {
        sleep(2)
        let image = XCUIScreen.main.screenshot()
        let a = XCTAttachment(screenshot: image)
        a.name = "\(lang)-\(id)"
        a.lifetime = .keepAlways
        add(a)
        // A landscape screenshot is portrait pixels with an orientation tag: draw it upright.
        let ui = image.image
        let format = UIGraphicsImageRendererFormat()
        format.scale = ui.scale
        format.opaque = true
        let png = UIGraphicsImageRenderer(size: ui.size, format: format).pngData { _ in ui.draw(at: .zero) }
        try png.write(to: outDir.appendingPathComponent("\(id).png"))
        app.terminate()
    }

    private func any(_ app: XCUIApplication, _ id: String) -> XCUIElement {
        app.descendants(matching: .any).matching(identifier: id).firstMatch
    }

    private func serverRow(_ app: XCUIApplication, _ fqdn: String) -> XCUIElement {
        app.buttons.matching(NSPredicate(format: "label CONTAINS %@", fqdn)).firstMatch
    }

    /// Drags (without fling) until `element`'s top sits at `y` (a fraction of the window's height).
    private func bring(_ app: XCUIApplication, _ element: XCUIElement, toY y: CGFloat) {
        let window = app.windows.firstMatch.frame
        for _ in 0..<6 {
            if !element.exists { app.swipeUp(velocity: .slow); continue }
            let delta = element.frame.minY - window.height * y
            if abs(delta) < 24 { return }
            let step = max(-window.height * 0.5, min(window.height * 0.5, delta))
            let from = app.windows.firstMatch.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.7))
            let to = from.withOffset(CGVector(dx: 0, dy: -step))
            from.press(forDuration: 0.1, thenDragTo: to, withVelocity: .slow, thenHoldForDuration: 0.6)
        }
    }

    /// Drags the page up just enough that `element`'s bottom (plus its card's padding) sits above `bar`.
    private func lift(_ app: XCUIApplication, _ element: XCUIElement, clearOf bar: XCUIElement) {
        guard element.exists else { return }
        let limit = bar.exists ? bar.frame.minY : app.windows.firstMatch.frame.height * 0.9
        let need = element.frame.maxY + 28 - limit
        guard need > 4 else { return }
        let from = app.windows.firstMatch.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.6))
        from.press(forDuration: 0.1, thenDragTo: from.withOffset(CGVector(dx: 0, dy: -need)), withVelocity: .slow,
                   thenHoldForDuration: 0.6)
    }

    func test_storeCaptures() throws {
        // 01 Home: both servers online, home the leader.
        var app = launch("home", dark: false)
        XCTAssertTrue(serverRow(app, "cabin.river-otter").waitForExistence(timeout: 20))
        try shot(app, "01")

        // 02 The start-up request cabin sent, in Activity's Server approvals.
        app = launch("activity", dark: true, ["-smoke-store-waiting"])
        let approvals = app.buttons["activity-section-approvals"]
        XCTAssertTrue(approvals.waitForExistence(timeout: 20))
        sleep(2)
        approvals.tap()
        XCTAssertTrue(any(app, "approvals-panel").waitForExistence(timeout: 15))
        try shot(app, "02")

        // 03 Every app on both servers.
        app = launch("apps", dark: false)
        XCTAssertTrue(any(app, "app-row-status-river-otter--budget").waitForExistence(timeout: 20))
        XCTAssertTrue(any(app, "app-row-status-river-otter--chess-club").waitForExistence(timeout: 20))
        try shot(app, "03")

        // 04 Chess Club's Access control: Members only, its three members and their ranks.
        app = launch("apps", dark: true)
        let chess = any(app, "app-row-status-river-otter--chess-club")
        XCTAssertTrue(chess.waitForExistence(timeout: 20))
        chess.tap()
        let access = app.buttons["service-detail-open-access"]
        for _ in 0..<8 where !(access.exists && access.isHittable) { app.swipeUp(velocity: .slow) }
        XCTAssertTrue(access.waitForExistence(timeout: 10))
        access.tap()
        let members = any(app, "service-access-members-title")
        XCTAssertTrue(members.waitForExistence(timeout: 15))
        XCTAssertTrue(any(app, "service-access-role-inv-lea").waitForExistence(timeout: 15))
        // iPhone: the top of the page (the app's header card below the bar), scrolled only as far as Lea's row needs
        // to clear the tab bar in a language whose rows wrap.
        if isPad { bring(app, any(app, "service-access-restrict-toggle"), toY: 0.16) }
        else { lift(app, any(app, "service-access-revoke-inv-lea"), clearOf: app.tabBars.firstMatch) }
        try shot(app, "04")

        // 05 home's server page at Backups.
        app = launch("home", dark: false)
        let home = serverRow(app, "home.river-otter")
        XCTAssertTrue(home.waitForExistence(timeout: 20))
        home.tap()
        let backups = any(app, "sd-backups-section")
        for _ in 0..<12 where !(backups.exists && backups.isHittable) { app.swipeUp(velocity: .slow) }
        XCTAssertTrue(any(app, "sd-backups-policy").waitForExistence(timeout: 15))
        // The card's top edge meets the navigation bar's bottom: what scrolls under the bar is the section's
        // gap and label, not the Diagnostics card's text overlapping the title.
        bring(app, any(app, "sd-backups-policy"), toY: isPad ? 0.10 : 0.15)
        try shot(app, "05")

        // 06 Messages: the conversation someone started from voi.ci/river-otter, under the owner's nickname for them.
        app = launch("messages", dark: true)
        let row = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'messages-row-'")).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 20))
        row.tap()
        XCTAssertTrue(any(app, "thread-compose").waitForExistence(timeout: 15))
        XCTAssertTrue(any(app, "thread-receipt").waitForExistence(timeout: 15))
        XCTAssertEqual(app.descendants(matching: .any).matching(identifier: "bubble-visitor").count, 3)
        try shot(app, "06")
    }
}
