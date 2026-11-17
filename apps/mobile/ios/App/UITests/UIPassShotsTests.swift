import XCTest

/// 0.4 UI pass (journal item E): the screens changed this round, one PNG each, for the before/after review. Opt-in
/// (skipped unless `UIPASS_DIR` is set), so the gym suites never run it. Appearance is set on the simulator before
/// the run (`simctl ui … appearance`); `UIPASS_LANG` (de, fr) launches the app in that language.
///
///   TEST_RUNNER_UIPASS_DIR=/abs/out TEST_RUNNER_UIPASS_TAG=phone-light [TEST_RUNNER_UIPASS_LANG=de] \
///   xcodebuild test-without-building … -only-testing:FlagshipAppUITests/UIPassShotsTests
final class UIPassShotsTests: GymSweepCase {
    private var outDir: URL?
    private var tag = ""
    private var lang: String?

    override func setUpWithError() throws {
        try super.setUpWithError()
        continueAfterFailure = true
        let env = ProcessInfo.processInfo.environment
        guard let dir = env["UIPASS_DIR"], !dir.isEmpty else { throw XCTSkip("Set TEST_RUNNER_UIPASS_DIR to capture.") }
        outDir = URL(fileURLWithPath: dir, isDirectory: true)
        try? FileManager.default.createDirectory(at: outDir!, withIntermediateDirectories: true)
        tag = env["UIPASS_TAG"] ?? "shot"
        lang = env["UIPASS_LANG"].flatMap { $0.isEmpty ? nil : $0 }
        if let lang { tag += "-\(lang)" }
        if UIDevice.current.userInterfaceIdiom == .pad { XCUIDevice.shared.orientation = .landscapeLeft }
    }

    private func open(_ tab: String, admin: Bool = true, _ extra: [String] = []) -> XCUIApplication {
        var args = extra
        if let lang { args += ["-AppleLanguages", "(\(lang))", "-AppleLocale", lang == "de" ? "de_DE" : "fr_FR"] }
        return launch(tab: tab, admin: admin, args)
    }

    private func snap(_ name: String, settle: UInt32 = 1) {
        sleep(settle)
        let image = XCUIScreen.main.screenshot()
        try? image.pngRepresentation.write(to: outDir!.appendingPathComponent("\(name)__\(tag).png"))
    }

    private func tapIf(_ app: XCUIApplication, _ el: XCUIElement, scroll: Bool = true) -> Bool {
        if scroll { _ = reveal(app, el, tries: 14) } else { _ = el.waitForExistence(timeout: 8) }
        guard el.exists else { return false }
        bringToMiddle(app, el)
        el.tap()
        return true
    }

    private func segment(_ app: XCUIApplication, _ id: String, _ index: Int) {
        let seg = app.segmentedControls[id]
        if seg.waitForExistence(timeout: 8) { seg.buttons.element(boundBy: index).tap(); return }
        let any = app.descendants(matching: .any)[id]
        if any.exists { any.buttons.element(boundBy: index).tap() }
    }

    // MARK: calls

    func test_calls() throws {
        for kind in ["ringing", "connecting", "connected", "camera", "ended", "outgoing"] {
            let app = open("messages", ["-smoke-call-stage", kind])
            _ = app.buttons.firstMatch.waitForExistence(timeout: 20)
            snap("call-\(kind)", settle: 2)
        }
        let app = open("messages", ["-smoke-voici-page", "-smoke-voici-reply", "-smoke-voici-call-history"])
        let calls = any(app, "social-call-button")
        if calls.waitForExistence(timeout: 20) {
            calls.tap()
            _ = any(app, "voici-calls-row").waitForExistence(timeout: 15)
            snap("calls-list")
        }
    }

    // MARK: social

    func test_social() throws {
        var app = open("messages", ["-smoke-messages"])
        _ = any(app, "social-header").waitForExistence(timeout: 20)
        wait(any(app, "messages-page-status"), "label != ''", timeout: 20)
        snap("social-profile", settle: 2)
        app.swipeUp(); app.swipeUp()
        snap("social-profile-scrolled")
        app.swipeDown(); app.swipeDown(); app.swipeDown()
        if tapIf(app, any(app, "page-options"), scroll: false) {
            snap("page-editor-options")
            app.swipeUp()
            snap("page-editor-options-lower")
            _ = tapIf(app, any(app, "page-options-done"), scroll: false)
        }
        if tapIf(app, any(app, "page-edit-links"), scroll: false) {
            snap("page-edit-links")
            _ = tapIf(app, any(app, "page-links-done"), scroll: false)
        }
        if tapIf(app, any(app, "page-new-post-open")) {
            snap("page-new-post")
            app.buttons["Cancel"].firstMatch.tap()
        }
        app.swipeDown(); app.swipeDown()
        if tapIf(app, any(app, "page-edit-name"), scroll: false) {
            let name = app.textFields["page-display-name"].firstMatch
            if name.waitForExistence(timeout: 5) { replaceText(name, with: "Bright Maple") }
            _ = tapIf(app, any(app, "page-edit-done"), scroll: false)
            if any(app, "page-publish-bar").waitForExistence(timeout: 10) { snap("page-publish-bar") }
        }
        if tapIf(app, any(app, "social-tab-inbox"), scroll: false) {
            snap("social-inbox", settle: 2)
            if tapIf(app, any(app, "social-tab-requests"), scroll: false) {
                snap("social-requests", settle: 2)
                let row = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'messages-row-'")).firstMatch
                if row.waitForExistence(timeout: 10) {
                    row.tap()
                    _ = any(app, "thread-compose").waitForExistence(timeout: 10)
                    snap("social-thread")
                }
            }
        }

        app = open("messages", ["-smoke-messages", "-smoke-messages-quiet"])
        _ = any(app, "social-header").waitForExistence(timeout: 20)
        if tapIf(app, any(app, "social-tab-inbox"), scroll: false) { snap("social-inbox-quiet", settle: 2) }

        app = open("messages", ["-smoke-messages-empty"])
        _ = any(app, "social-header").waitForExistence(timeout: 20)
        snap("social-new-page", settle: 2)
        if tapIf(app, any(app, "social-tab-inbox"), scroll: false) { snap("social-inbox-empty", settle: 2) }
        if tapIf(app, any(app, "social-tab-requests"), scroll: false) { snap("social-requests-empty", settle: 2) }

        app = open("home", ["-smoke-messages-empty"])
        let welcome = app.buttons["Set up your page"].firstMatch
        if welcome.waitForExistence(timeout: 20) {
            snap("home-page-welcome")
            welcome.tap()
            sleep(2)
            let sw = any(app, "page-public-switch")
            if sw.waitForExistence(timeout: 10) {
                sw.coordinate(withNormalizedOffset: CGVector(dx: 0.93, dy: 0.5)).tap()
                let agree = any(app, "rules-agree")
                if agree.waitForExistence(timeout: 5) { snap("social-rules"); agree.tap() }
                if app.alerts.firstMatch.waitForExistence(timeout: 5) { snap("social-first-publish-warning") }
            }
        }
    }

    // MARK: activity

    func test_activity() throws {
        let app = open("activity", ["-smoke-activity", "-smoke-messages", "-smoke-voici-page", "-smoke-voici-reply", "-smoke-voici-call-history"])
        _ = app.navigationBars.firstMatch.waitForExistence(timeout: 20)
        snap("activity-all", settle: 3)
        app.swipeUp()
        snap("activity-all-2")
        app.swipeDown(); app.swipeDown()
        segment(app, "activity-filter", 2)
        snap("activity-social", settle: 2)
        segment(app, "activity-filter", 1)
        snap("activity-servers", settle: 2)
    }

    // MARK: plan

    func test_plan() throws {
        let app = open("settings")
        _ = app.navigationBars.firstMatch.waitForExistence(timeout: 20)
        let entry = app.buttons["settings-open-plan"]
        guard tapIf(app, entry) else { return }
        _ = any(app, "plan-current").waitForExistence(timeout: 15)
        snap("plan", settle: 2)
        app.swipeUp()
        snap("plan-2")
        app.swipeUp()
        snap("plan-3")
        let add = app.buttons["plan-add-test"]
        if tapIf(app, add) {
            sleep(3)
            let pro = app.buttons["plan-choose-pro"]
            if tapIf(app, pro) {
                sleep(3)
                for _ in 0..<8 { app.swipeDown() }
                snap("plan-pro", settle: 2)
            }
        }
    }

    // MARK: outbound proxy

    private func openHomeServer(_ app: XCUIApplication) -> Bool {
        let row = podRow(app, named: "Home")
        guard reveal(app, row) else { return false }
        let page = app.serverPageBackButton(named: "Home")
        for _ in 0..<4 {
            sleep(2)
            if row.exists && row.isHittable { row.tap() }
            if page.waitForExistence(timeout: 8) { return true }
        }
        return false
    }

    func test_proxy() throws {
        var app = open("home", ["-smoke-server-fresh", "-smoke-proxy-fallback"])
        if openHomeServer(app) {
            let line = app.staticTexts.matching(identifier: "sd-proxy-alert").firstMatch
            if line.waitForExistence(timeout: 20) { bringToMiddle(app, line); snap("proxy-fallback") }
            let summary = any(app, "sd-proxy-summary")
            if reveal(app, summary, tries: 16) { bringToMiddle(app, summary); snap("proxy-section") }
            if tapIf(app, app.buttons["sd-proxy-change"]) { sleep(2); snap("proxy-editor"); app.swipeUp(); snap("proxy-editor-2") }
        }
        app = open("home", ["-smoke-server-fresh", "-smoke-proxy-failing", "auth"])
        if openHomeServer(app) {
            let line = app.staticTexts.matching(identifier: "sd-proxy-alert").firstMatch
            if line.waitForExistence(timeout: 20) { snap("proxy-failing") }
        }
        app = open("home", ["-smoke-server-fresh", "-smoke-proxy-offline"])
        if openHomeServer(app) { sleep(3); snap("proxy-offline") }
        app = open("home", ["-smoke-server-fresh", "-smoke-proxy-pods-alert"])
        if any(app, "pod-card-proxy-alert").waitForExistence(timeout: 20) { snap("home-proxy-badge") }
        app = open("home", ["-smoke-server-fresh", "-smoke-account-free"])
        let add = app.buttons["home-add-server"]
        if add.waitForExistence(timeout: 15) {
            sleep(2); add.tap()
            let create = app.buttons.matching(identifier: "home-add-new-server").firstMatch
            if create.waitForExistence(timeout: 6) {
                create.tap()
                let name = app.textFields["cs-name-field"]
                if name.waitForExistence(timeout: 15) {
                    app.typeServerName(name, "cellar")
                    app.buttons["cs-next-button"].tap()
                    let adv = app.switches["cs-advanced-toggle"]
                    if reveal(app, adv) {
                        adv.coordinate(withNormalizedOffset: CGVector(dx: 0.93, dy: 0.5)).tap()
                        let pro = any(app, "proxy-pro")
                        if reveal(app, pro) { bringToMiddle(app, pro); snap("proxy-free-pro-row") }
                    }
                }
            }
        }
    }

    // MARK: direct access

    func test_directAccess() throws {
        var app = open("home", ["-smoke-admin-root"])
        openServerPage(app, named: "Home")
        let on = app.buttons["sd-direct-access-on"]
        if reveal(app, on, tries: 18) {
            bringToMiddle(app, on)
            snap("direct-access-off")
            on.tap()
            let field = app.descendants(matching: .any)["sd-direct-access-addresses-field"]
            if reveal(app, field) {
                field.tap(); field.typeText("81.2.69.142")
                dismissKeyboard(app)
                let warning = app.staticTexts["sd-direct-access-warning"]
                if warning.exists { _ = revealUp(app, warning); bringToMiddle(app, warning) }
                snap("direct-access-form")
                let submit = app.buttons["sd-direct-access-submit"]
                if tapIf(app, submit) {
                    _ = app.buttons["sd-direct-access-off"].waitForExistence(timeout: 15)
                    let nameOn = app.buttons["sd-direct-name-on-bright-maple--plants"]
                    if reveal(app, nameOn, tries: 12) {
                        bringToMiddle(app, nameOn)
                        snap("direct-access-on")
                        nameOn.tap()
                        let probe = app.buttons["sd-direct-name-probe-btn-bright-maple--plants"]
                        if tapIf(app, probe) {
                            _ = app.staticTexts["sd-direct-name-probe-bright-maple--plants"].waitForExistence(timeout: 15)
                            snap("direct-access-names")
                        }
                    }
                    for _ in 0..<16 { app.swipeDown() }
                    let plants = app.buttons["server-app-bright-maple--plants"]
                    if tapIf(app, plants) {
                        let choice = app.descendants(matching: .any)["app-direct-link-choice"]
                        if reveal(app, choice, tries: 16) { bringToMiddle(app, choice); snap("app-direct-link-choice") }
                    }
                }
            }
        }
        app = open("home", admin: false)
        openServerPage(app, named: "Home")
        let note = app.staticTexts["sd-direct-access-admin-only"]
        if reveal(app, note, tries: 18) { bringToMiddle(app, note); snap("direct-access-readonly") }
    }

    // MARK: settings

    func test_settings() throws {
        let app = open("settings")
        _ = app.navigationBars.firstMatch.waitForExistence(timeout: 20)
        snap("settings", settle: 2)
        app.swipeUp()
        snap("settings-2")
        app.swipeUp()
        snap("settings-3")
        app.swipeUp()
        snap("settings-4")
    }
}
