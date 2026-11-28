import XCTest

/// Store screenshots (docs/store-assets/capture-plan.md): the real app over the made-up world in
/// store/demo-world.json (`-smoke-store-world`), one language per run, light and dark by the slide's place
/// in the strip, written as `<id>.png` (01-06 and 08: call, Home, Social's calls, apps, access, backups, build chat; the watch's 07/07b come from capture-ios.sh). Opt-in (skipped
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
    /// `TEST_RUNNER_STORE_ONLY=03,08`: only these slides (a retake after a change to one screen).
    private var only: Set<String>?
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
        only = env["STORE_ONLY"].flatMap { $0.isEmpty ? nil : Set($0.split(separator: ",").map(String.init)) }
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
        try write(XCUIScreen.main.screenshot(), id)
        app.terminate()
    }

    private func write(_ image: XCUIScreenshot, _ id: String) throws {
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

    /// The caller's name: the owner's nickname for Sam in the capture's language (the world's `messages.nickname`).
    private var nickname: String {
        let json = (try? JSONSerialization.jsonObject(with: Data(world.utf8))) as? [String: Any]
        let names = (json?["messages"] as? [String: Any])?["nickname"] as? [String: String] ?? [:]
        return names[lang] ?? names["en"] ?? ""
    }

    /// The tablet slides with a sparse page (Social, Access control) draw two sizes larger, so the page fills the
    /// wide screen like the other slides (store review: "a narrow centred column, small text"; then "use the full width").
    private var tabletType: [String] { isPad ? ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryXXXL"] : [] }

    private func want(_ id: String) -> Bool { only?.contains(id) ?? true }

    func test_storeCaptures() throws {
        if want("01") {
            // 01 An incoming voi.ci call from Sam, ringing: the app's own ringing stage (CallKit's can't be captured). The
            // stage is always dark, so the device is too: a light device draws a dark status bar on it.
            let app = launch("home", dark: true, ["-smoke-call-stage", "ringing"])
            XCTAssertTrue(app.staticTexts[nickname].waitForExistence(timeout: 20))
            try shot(app, "01")
        }
        if want("02") {
            // 02 Home: both servers online, home the leader, no marketplace card (0.4).
            let app = launch("home", dark: true)
            XCTAssertTrue(serverRow(app, "cabin.river-otter").waitForExistence(timeout: 20))
            XCTAssertFalse(any(app, "quick-action-install-service").exists)
            try shot(app, "02")
        }
        if want("03") {
            // 03 Social: the Inbox with every conversation and the call button with its missed calls (kept as
            // x03-inbox.png), then the call button's Calls page: missed, video and audio calls, named by the owner's
            // nicknames (03.png).
            let app = launch("messages", dark: false, tabletType)
            let inbox = app.buttons["social-tab-inbox"]
            XCTAssertTrue(inbox.waitForExistence(timeout: 20))
            inbox.tap()
            let row = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'messages-row-'")).firstMatch
            XCTAssertTrue(row.waitForExistence(timeout: 20))
            let callButton = any(app, "social-call-button")
            XCTAssertTrue(callButton.waitForExistence(timeout: 10))
            sleep(2)
            try write(XCUIScreen.main.screenshot(), "x03-inbox")
            callButton.tap()
            XCTAssertTrue(any(app, "voici-calls-list").waitForExistence(timeout: 15))
            try shot(app, "03")
        }
        if want("04") {
            // 04 Every app on both servers, each with its own voi.ci link.
            let app = launch("apps", dark: true)
            XCTAssertTrue(any(app, "app-row-status-river-otter--budget").waitForExistence(timeout: 20))
            XCTAssertTrue(any(app, "app-row-status-river-otter--chess-club").waitForExistence(timeout: 20))
            try shot(app, "04")
        }
        if want("05") {
            // 05 Chess Club's Access control: Members only, its three members and their ranks.
            let app = launch("apps", dark: false, tabletType)
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
            // to clear the tab bar in a language whose rows wrap. iPad: the page's top.
            if !isPad { lift(app, any(app, "service-access-revoke-inv-lea"), clearOf: app.tabBars.firstMatch) }
            try shot(app, "05")
        }
        if want("06") {
            // 06 home's server page at Backups, each backup's "Restore into this server" in view.
            let app = launch("home", dark: true)
            let home = serverRow(app, "home.river-otter")
            XCTAssertTrue(home.waitForExistence(timeout: 20))
            home.tap()
            let backups = any(app, "sd-backups-section")
            for _ in 0..<12 where !(backups.exists && backups.isHittable) { app.swipeUp(velocity: .slow) }
            XCTAssertTrue(any(app, "sd-backups-policy").waitForExistence(timeout: 15))
            // The card's top edge meets the navigation bar's bottom: what scrolls under the bar is the section's
            // gap and label, not the Diagnostics card's text overlapping the title.
            bring(app, any(app, "sd-backups-policy"), toY: isPad ? 0.10 : 0.15)
            let restore = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'sd-backup-restore-'")).firstMatch
            XCTAssertTrue(restore.waitForExistence(timeout: 10))
            try shot(app, "06")
        }
        if want("08") {
            // 08 The build chat: the owner described an app, the AI built it on home; ready to deploy.
            let app = launch("apps", dark: true, ["-smoke-store-chat", storeChatId])
            XCTAssertTrue(any(app, "vibecode-reply-field").waitForExistence(timeout: 30))
            try shot(app, "08")
        }
    }

    /// The world's build chat (`build.sessionId`).
    private var storeChatId: String {
        let json = (try? JSONSerialization.jsonObject(with: Data(world.utf8))) as? [String: Any]
        return (json?["build"] as? [String: Any])?["sessionId"] as? String ?? "store-chat"
    }
}

/// App Store in-app purchase review screenshots (docs/runbooks/0.4-browser-tasks.md B3): Settings → Plan with the
/// three voucher packs on sale, one image per product with its row outlined, light mode, written as
/// `vouchers-<units>.png` (1320×2868 on an iPhone 6.9" simulator, opaque). Opt-in: skipped unless `IAP_OUT` is set
/// (`TEST_RUNNER_IAP_OUT=/abs/dir xcodebuild test ... -only-testing:FlagshipAppUITests/IapReviewCaptureTests`).
/// `-smoke-iap-review` turns off the gym's test credit, so only what a buyer sees is on screen.
final class IapReviewCaptureTests: XCTestCase {
    func test_planPacks() throws {
        continueAfterFailure = false
        guard let dir = ProcessInfo.processInfo.environment["IAP_OUT"], !dir.isEmpty else {
            throw XCTSkip("Set TEST_RUNNER_IAP_OUT to capture the in-app purchase review screenshots.")
        }
        let out = URL(fileURLWithPath: dir, isDirectory: true)
        try FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
        XCUIDevice.shared.appearance = .light
        let app = XCUIApplication()
        app.launchArguments = ["-AppleLanguages", "(en)", "-AppleLocale", "en_US", "-smoke-mode", "-smoke-tab", "settings",
                               "-smoke-admin-root", "-smoke-recovery-enrolled", "-smoke-username", "bright-maple",
                               "-smoke-theme", "light", "-smoke-iap-review"]
        app.launch()
        XCTAssertTrue(app.navigationBars["Settings"].waitForExistence(timeout: 30))
        let entry = app.buttons["settings-open-plan"]
        for _ in 0..<10 where !(entry.exists && entry.isHittable) { app.swipeUp(velocity: .slow) }
        XCTAssertTrue(entry.waitForExistence(timeout: 10), "Settings should offer the plan screen.")
        entry.tap()
        XCTAssertTrue(app.navigationBars["Plan"].waitForExistence(timeout: 15))
        let packs = [10, 30, 120].map { app.buttons["plan-pack-\($0)"] }
        XCTAssertTrue(app.descendants(matching: .any)["plan-balance"].waitForExistence(timeout: 20), "Plan should load.")
        let last = packs[2]
        let tabBar = app.tabBars.firstMatch
        for _ in 0..<16 {
            let bottom = tabBar.exists ? tabBar.frame.minY : app.windows.firstMatch.frame.maxY
            if last.exists && last.isHittable && last.frame.maxY < bottom - 120 { break }
            app.swipeUp(velocity: .slow)
        }
        if !packs.allSatisfy({ $0.exists }) {
            let a = XCTAttachment(string: app.debugDescription)
            a.name = "Plan without packs"
            a.lifetime = .keepAlways
            add(a)
        }
        XCTAssertTrue(packs.allSatisfy { $0.exists }, "The App Store packs are on sale.")
        XCTAssertFalse(app.buttons["plan-add-test"].exists, "No gym test credit in a review screenshot.")
        sleep(2)
        let shot = XCUIScreen.main.screenshot().image
        for (units, pack) in zip([10, 30, 120], packs) {
            XCTAssertTrue(pack.label.contains("$\(units)"), "Got: \(pack.label)")
            let format = UIGraphicsImageRendererFormat()
            format.scale = shot.scale
            format.opaque = true
            let r = pack.frame.insetBy(dx: 6, dy: 2)
            let png = UIGraphicsImageRenderer(size: shot.size, format: format).pngData { _ in
                shot.draw(at: .zero)
                let path = UIBezierPath(roundedRect: r, cornerRadius: 12)
                path.lineWidth = 4
                UIColor.systemRed.setStroke()
                path.stroke()
            }
            try png.write(to: out.appendingPathComponent("vouchers-\(units).png"))
        }
        let plain = UIGraphicsImageRenderer(size: shot.size, format: { let f = UIGraphicsImageRendererFormat(); f.scale = shot.scale; f.opaque = true; return f }())
            .pngData { _ in shot.draw(at: .zero) }
        try plain.write(to: out.appendingPathComponent("plan-packs.png"))
    }
}
