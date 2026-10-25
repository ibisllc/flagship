import XCTest

/// GYM iOS mock tier for release 0.3's client screens: recovery checked by the passkey (SEC-REPAIR-001)
/// and its once-only update, wipe & restart's new passkey, browser access requests (SEC-BROWSER-002) and
/// an imported app's upstream sync (N12). Seams: GymSweepSeams+Release03.swift.
final class GymRelease03Tests: GymSweepCase {
    private let otherDevice = String(repeating: "ab", count: 16)

    private func box(_ app: XCUIApplication, _ id: String) -> XCUIElement {
        app.descendants(matching: .any).matching(identifier: id).firstMatch
    }

    private func launchOnboarding(_ extra: [String]) -> XCUIApplication {
        let app = XCUIApplication()
        app.terminate()
        app.launchArguments = ["-smoke-onboarding"] + extra
        app.launch()
        XCTAssertTrue(app.buttons["Create your account"].waitForExistence(timeout: 20))
        return app
    }

    private func restore(_ app: XCUIApplication, as name: String, passphrase: String) {
        app.buttons["welcome-connect"].tap()
        let name0 = app.textFields.matching(identifier: "connect-name-field").firstMatch
        XCTAssertTrue(name0.waitForExistence(timeout: 10))
        name0.tap()
        name0.typeText(name)
        let cont = app.buttons["connect-name-continue"]
        wait(cont, "isEnabled == true")
        cont.tap()
        let pass = app.secureTextFields["login-recovery-passphrase"]
        XCTAssertTrue(pass.waitForExistence(timeout: 15))
        pass.tap()
        pass.typeText(passphrase)
        let go = app.buttons["login-takeover-continue"]
        wait(go, "isEnabled == true")
        go.tap()
    }

    // MARK: - Recovery passkey

    /// A record holding its passkey's key: restoring signs `.com`'s challenge in the same passkey sheet
    /// that unwraps, and the fetch carries that signature.
    func test_restoreSignsComsChallenge() throws {
        let app = launchOnboarding(["-smoke-recovery-passkey"])
        restore(app, as: "sole-maple", passphrase: "maple syrup forest")
        // Onboarding has no probe: the restore getting past the fetch (the key it held moved, so it goes on
        // to the re-pair hold) is what shows the mock `.com` accepted the passkey's signature.
        let moved = any(app, "login-grace-countdown")
        let err = app.staticTexts["login-takeover-error"]
        let deadline = Date().addingTimeInterval(40)
        while Date() < deadline && !moved.exists && !err.exists { _ = moved.waitForExistence(timeout: 1) }
        if err.exists {
            XCTAssertFalse(err.label.localizedCaseInsensitiveContains("passkey"), "The passkey check passed: \(err.label)")
            XCTAssertFalse(err.label.contains("passphrase didn't match"), "The passphrase gate passed: \(err.label)")
        } else {
            XCTAssertTrue(moved.exists, "The restore went past the passkey-checked fetch.")
        }
        shot(app, "recovery-passkey-checked")
    }

    /// `.com` refuses the passkey's signature: the restore says so in its own words.
    func test_restoreRefusedPasskeySaysWhy() throws {
        let app = launchOnboarding(["-smoke-recovery-passkey", "-smoke-recovery-passkey-refused"])
        restore(app, as: "sole-maple", passphrase: "maple syrup forest")
        let err = app.staticTexts["login-takeover-error"]
        XCTAssertTrue(err.waitForExistence(timeout: 40))
        XCTAssertEqual(err.label, "That passkey isn't the one your account recovery uses.")
        shot(app, "recovery-passkey-refused")
    }

    /// Setting up recovery sends the passkey's attestation; the passphrase hint is the shared one.
    func test_setupSendsThePasskeyAndShowsTheHint() throws {
        let app = launch(tab: "settings")
        XCTAssertTrue(app.navigationBars["Settings"].waitForExistence(timeout: 20))
        let row = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Cloud recovery")).firstMatch
        XCTAssertTrue(reveal(app, row))
        bringToMiddle(app, row)
        row.tap()
        let hint = app.staticTexts["recovery-enroll-hint"]
        XCTAssertTrue(hint.waitForExistence(timeout: 10))
        XCTAssertEqual(hint.label, "Longer is stronger and there is no upper limit: a whole sentence you will remember works well")
        shot(app, "recovery-passkey-setup")
        let p1 = app.secureTextFields["recovery-enroll-passphrase"]
        p1.tap()
        p1.typeText("maple syrup forest")
        let p2 = app.secureTextFields["recovery-enroll-passphrase-2"]
        p2.tap()
        p2.typeText("maple syrup forest")
        app.buttons["recovery-enroll-go"].tap()
        expectProbe(app, "recovery passkey enrolled", timeout: 30)
    }

    /// A record from before the check: Home asks once. Not now leaves a quiet Settings row, which updates
    /// it with one passkey sheet; the row is then gone.
    func test_updatePromptOnceThenSettingsRow() throws {
        let app = launch(tab: "home", ["-smoke-recovery-legacy"])
        let title = app.staticTexts["recovery-update-title"]
        XCTAssertTrue(title.waitForExistence(timeout: 25), "Home asks to update a record from before.")
        XCTAssertEqual(title.label, "Update your account recovery")
        XCTAssertEqual(app.staticTexts["recovery-update-body"].label,
                       "Account recovery can now also check your passkey, so your passphrase alone can't download your recovery copy. Enter your recovery passphrase, then confirm with your passkey once.")
        shot(app, "recovery-update-prompt")
        app.buttons["recovery-update-not-now"].tap()
        waitGone(title)

        app.tabBars.buttons["Settings"].tap()
        let row = app.buttons["settings-update-recovery"]
        XCTAssertTrue(reveal(app, row, tries: 12), "Settings keeps a quiet Update account recovery row.")
        bringToMiddle(app, row)
        row.tap()
        let p1 = app.secureTextFields["recovery-update-passphrase"]
        XCTAssertTrue(p1.waitForExistence(timeout: 10))
        p1.tap()
        p1.typeText("maple syrup forest")
        let p2 = app.secureTextFields["recovery-update-passphrase-2"]
        p2.tap()
        p2.typeText("maple syrup forest")
        app.buttons["recovery-update-confirm"].tap()
        expectProbe(app, "recovery passkey enrolled", timeout: 30)
        waitGone(app.buttons["recovery-update-confirm"], timeout: 20)
        XCTAssertFalse(app.buttons["settings-update-recovery"].exists, "Updated: the row is gone.")
    }

    /// Asked before on this device: Home doesn't ask again.
    func test_updatePromptIsNotRepeated() throws {
        let app = launch(tab: "home", ["-smoke-recovery-legacy", "-smoke-recovery-asked"])
        XCTAssertTrue(app.buttons["home-add-server"].waitForExistence(timeout: 20))
        XCTAssertFalse(app.staticTexts["recovery-update-title"].waitForExistence(timeout: 5))
        shot(app, "recovery-update-not-repeated")
    }

    // MARK: - Wipe & restart

    /// Wipe & restart carries the new passkey's attestation beside the old key's signature.
    func test_wipeRestartAttestsTheNewPasskey() throws {
        let app = launch(tab: "settings", ["-smoke-trusted-devices"])
        XCTAssertTrue(app.navigationBars["Settings"].waitForExistence(timeout: 20))
        let menu = box(app, "trusted-device-menu-\(otherDevice)")
        XCTAssertTrue(reveal(app, menu, tries: 12))
        bringToMiddle(app, menu)
        menu.tap()
        button(app, "Wipe & restart…").tap()
        let go = button(app, "Wipe and start over")
        XCTAssertTrue(go.waitForExistence(timeout: 5))
        go.tap()
        expectProbe(app, "wipe-restart new passkey attested", timeout: 30)
        shot(app, "wipe-restart-passkey")
    }

    // MARK: - Browser grants

    /// Two requests wait: the one-visit ask names the app, the exact sites (a wildcard says it reaches
    /// every address under it), what it can do and the app's own words; Allow once signs it. The session
    /// ask on a local device is denied with no signature.
    func test_browserGrantAllowOnceThenDeny() throws {
        let app = launch(tab: "home", ["-smoke-browser-grant"])
        let title = app.staticTexts["browser-grant-title"]
        XCTAssertTrue(title.waitForExistence(timeout: 25), "A waiting browser request opens the sheet.")
        XCTAssertEqual(title.label, "plants wants to use this server's browser.")
        XCTAssertTrue(app.staticTexts["*.example.org"].exists)
        XCTAssertTrue(app.staticTexts["and every address under it"].exists)
        XCTAssertTrue(app.staticTexts["news.example.com"].exists)
        XCTAssertTrue(app.staticTexts["For one visit"].exists)
        XCTAssertTrue(box(app, "browser-grant-explanation").label.contains("Read today's prices"))
        XCTAssertTrue(app.buttons["browser-grant-allow"].label == "Allow once")
        shot(app, "browser-grant-once")
        app.buttons["browser-grant-allow"].tap()
        let done = app.staticTexts["browser-grant-done"]
        XCTAssertTrue(done.waitForExistence(timeout: 15))
        XCTAssertEqual(done.label, "Allowed. plants can use the browser for one visit.")
        expectProbe(app, "signed browser-grant by admin-root")
        expectProbe(app, "browser grant allow bright-maple--plants once")
        app.buttons["browser-grant-close"].tap()

        XCTAssertTrue(title.waitForExistence(timeout: 15), "The next request is asked.")
        XCTAssertEqual(title.label, "wiki wants to use this server's browser.")
        XCTAssertEqual(box(app, "browser-grant-lan").label, "These devices on your network: 192.168.1.20")
        XCTAssertEqual(app.buttons["browser-grant-allow"].label, "Allow for this session")
        app.buttons["browser-grant-deny"].tap()
        XCTAssertTrue(done.waitForExistence(timeout: 15))
        XCTAssertEqual(done.label, "Denied. wiki can't use the browser for this.")
        expectProbe(app, "browser grant deny bright-maple--wiki session")
    }

    /// The app's page: the sites approved at install, and its waiting request answered there.
    func test_browserAccessOnTheAppPage() throws {
        let app = launch(tab: "apps", ["-smoke-browser-grant-app"])
        // The request also waits in the inbox: put it off there and answer it on the app page.
        let notNow = app.buttons["browser-grant-not-now"]
        XCTAssertTrue(notNow.waitForExistence(timeout: 25), "The inbox asks too.")
        notNow.tap()
        waitGone(notNow)
        openApp(app, named: "Plants")
        let manifest = box(app, "app-browser-manifest")
        XCTAssertTrue(reveal(app, manifest, tries: 16), "The app page lists what was approved at install.")
        XCTAssertTrue(manifest.label.contains("Approved when you installed it"))
        XCTAssertTrue(manifest.label.contains("shop.example.com"))
        let allow = app.buttons["app-browser-allow"]
        XCTAssertTrue(reveal(app, allow, tries: 6))
        XCTAssertEqual(allow.label, "Always allow")
        shot(app, "browser-access-app-page")
        bringToMiddle(app, allow)
        allow.tap()
        let note = app.staticTexts["app-browser-note"]
        XCTAssertTrue(note.waitForExistence(timeout: 15))
        expectProbe(app, "browser grant allow bright-maple--plants service")
    }

    /// A session ask offers Allow once beside Allow for this session; Allow once signs the shorter grant.
    func test_browserGrantNarrowedToOnce() throws {
        let app = launch(tab: "home", ["-smoke-browser-grant-narrow"])
        let title = app.staticTexts["browser-grant-title"]
        XCTAssertTrue(title.waitForExistence(timeout: 25))
        XCTAssertEqual(title.label, "wiki wants to use this server's browser.")
        let once = app.buttons["browser-grant-allow-once"]
        XCTAssertTrue(once.exists)
        XCTAssertEqual(once.label, "Allow once")
        XCTAssertEqual(app.buttons["browser-grant-allow"].label, "Allow for this session")
        XCTAssertFalse(app.buttons["browser-grant-allow-service"].exists, "Never wider than the ask.")
        shot(app, "browser-grant-narrow")
        once.tap()
        let done = app.staticTexts["browser-grant-done"]
        XCTAssertTrue(done.waitForExistence(timeout: 15))
        XCTAssertEqual(done.label, "Allowed. wiki can use the browser for one visit.", "Says what was granted, not the ask.")
        expectProbe(app, "browser grant allow bright-maple--wiki once")
    }

    /// The app page lists what the owner allowed beyond the manifest; Withdraw signs the revoke and the
    /// grant is gone.
    func test_browserGrantWithdrawOnTheAppPage() throws {
        let app = launch(tab: "apps", ["-smoke-browser-grant-granted"])
        openApp(app, named: "Plants")
        let heading = app.staticTexts["app-browser-granted-title"]
        XCTAssertTrue(reveal(app, heading, tries: 16), "The app page lists the grants the owner gave.")
        XCTAssertEqual(heading.label, "Allowed by you")
        XCTAssertTrue(app.staticTexts["prices.example.net"].exists)
        let withdraw = app.buttons["app-browser-withdraw"]
        XCTAssertTrue(reveal(app, withdraw, tries: 6))
        XCTAssertEqual(withdraw.label, "Withdraw")
        shot(app, "browser-grant-granted")
        bringToMiddle(app, withdraw)
        withdraw.tap()
        let note = app.staticTexts["app-browser-note"]
        XCTAssertTrue(note.waitForExistence(timeout: 15))
        XCTAssertEqual(note.label, "Browser access withdrawn")
        expectProbe(app, "browser grant withdrawn bright-maple--plants")
        waitGone(app.buttons["app-browser-withdraw"])
        XCTAssertFalse(app.staticTexts["prices.example.net"].exists)
    }

    // MARK: - Upstream sync

    /// An imported app checks its repo at a chosen ref: the proposal names the version, the counts, the
    /// conflict kept as the owner's, and the new permission apart; Review and deploy opens the build.
    func test_syncProposalThenReview() throws {
        let app = launch(tab: "apps", ["-smoke-upstream-sync"])
        openApp(app, named: "Plants")
        let row = app.buttons["service-detail-sync"]
        XCTAssertTrue(reveal(app, row, tries: 12))
        XCTAssertEqual(row.label, "Check for updates from github.com/ana/plants")
        bringToMiddle(app, row)
        row.tap()
        let ref = app.textFields["sync-ref"]
        XCTAssertTrue(ref.waitForExistence(timeout: 10))
        ref.tap()
        ref.typeText("v2")
        app.buttons["sync-check"].tap()
        let version = app.staticTexts["sync-version"]
        XCTAssertTrue(version.waitForExistence(timeout: 20))
        XCTAssertEqual(version.label, "Version abcdef012345")
        expectProbe(app, "sync proposal bright-maple--plants at v2")
        XCTAssertTrue(box(app, "sync-permissions").exists, "New permissions are shown apart from the code.")
        XCTAssertTrue(app.staticTexts["New permissions"].exists)
        XCTAssertTrue(app.staticTexts["Internet access"].exists)
        XCTAssertTrue(text(app, containing: "api.weather.example").exists)
        XCTAssertEqual(app.staticTexts["sync-from-upstream"].label, "3 files updated from upstream")
        XCTAssertEqual(app.staticTexts["sync-yours-kept"].label, "2 of your changes kept")
        XCTAssertEqual(app.staticTexts["sync-conflicts"].label, "1 conflicts: your version was kept")
        shot(app, "sync-proposal")
        let review = app.buttons["sync-review"]
        XCTAssertTrue(reveal(app, review))
        review.tap()
        XCTAssertTrue(app.buttons["build-git-deploy"].waitForExistence(timeout: 20),
                      "Review opens the existing git build screen for the merge, with Deploy.")
        expectNoProbe(app, "discarded build gym-sync-build")
    }

    /// Already current: it says so, and the box opened no build, so closing discards nothing.
    func test_syncUpToDateOpensNoBuild() throws {
        let app = launch(tab: "apps", ["-smoke-upstream-sync-current"])
        openApp(app, named: "Plants")
        let row = app.buttons["service-detail-sync"]
        XCTAssertTrue(reveal(app, row, tries: 12))
        bringToMiddle(app, row)
        row.tap()
        let check = app.buttons["sync-check"]
        XCTAssertTrue(check.waitForExistence(timeout: 10))
        check.tap()
        let same = box(app, "sync-up-to-date")
        XCTAssertTrue(same.waitForExistence(timeout: 20))
        XCTAssertTrue(same.label.contains("You already run the latest version from github.com/ana/plants."))
        shot(app, "sync-up-to-date")
        app.buttons["sync-close"].tap()
        waitGone(same)
        expectNoProbe(app, "discarded build")
    }

    // MARK: - Update results (docs/support/update-rollback.md §5)

    /// A failed update the floor kept in recovery reads as stuck, not "went back on its own"; the
    /// Share update results switch is off and sends the owner's choice to the box.
    func test_updateKeptInRecoveryAndShareSwitch() throws {
        let app = launch(tab: "home", ["-smoke-update-kept-in-recovery"])
        openServerPage(app, named: "Home")
        let last = app.staticTexts["sd-update-last-outcome"]
        XCTAssertTrue(reveal(app, last, tries: 14), "The card says how the last update went.")
        XCTAssertTrue(last.label.contains("recovery mode"), "Got: \(last.label)")
        XCTAssertFalse(last.label.contains("on its own"), "Got: \(last.label)")
        let toggle = app.switches["sd-update-reports"]
        XCTAssertTrue(reveal(app, toggle, tries: 6), "The update card offers Share update results.")
        XCTAssertEqual(toggle.value as? String, "0")
        XCTAssertTrue(text(app, containing: "Never your server's name, your account or anything about your apps.").exists)
        shot(app, "update-results")
        toggle.switches.firstMatch.tap()
        expectProbe(app, "update reports on")
        wait(toggle, "value == '1'")
        toggle.switches.firstMatch.tap()
        expectProbe(app, "update reports off")
    }

    /// A refusal is one whole sentence; a box that refuses the session shows no switch.
    func test_updateRefusalSentenceAndNoSwitchWhenRefused() throws {
        let app = launch(tab: "home", ["-smoke-update-refused-stale"])
        openServerPage(app, named: "Home")
        let last = app.staticTexts["sd-update-last-outcome"]
        XCTAssertTrue(reveal(app, last, tries: 14))
        XCTAssertEqual(last.label, "The server refused the last update: the request was too old. Send it again.")
        XCTAssertFalse(app.switches["sd-update-reports"].exists)
        shot(app, "update-refusal")
    }

    // MARK: - Local AI (AI02, docs/architecture-v2/local-ai.md)

    private func openLocalAi(_ app: XCUIApplication) {
        openServerPage(app, named: "Home")
        let open = app.buttons["local-ai-open"]
        XCTAssertTrue(reveal(app, open, tries: 18), "The server page has a Local AI section.")
        bringToMiddle(app, open)
        open.tap()
        XCTAssertTrue(app.navigationBars["Local AI"].waitForExistence(timeout: 15), "Local AI opens.")
    }

    /// The models list says where it runs and what it costs, each model's size, license, memory and
    /// speed; Download sends the request and the row ends Downloaded.
    func test_localAiModelsAndDownload() throws {
        let app = launch(tab: "home", ["-smoke-local-ai"])
        openLocalAi(app)
        XCTAssertTrue(text(app, containing: "Runs only on this server. Nothing is sent anywhere.").waitForExistence(timeout: 10))
        XCTAssertTrue(text(app, containing: "Free: runs on this server").exists)
        XCTAssertTrue(text(app, containing: "of disk free").exists, "Disk and the models' allowance are shown.")
        let download = app.buttons["local-ai-download-stories-15m"]
        XCTAssertTrue(reveal(app, download, tries: 16), "A model that isn't downloaded offers Download.")
        XCTAssertTrue(text(app, containing: "License: mit").exists)
        XCTAssertTrue(text(app, containing: "tokens a second on the CPU (estimate)").exists)
        shot(app, "local-ai-models")
        bringToMiddle(app, download)
        download.tap()
        expectProbe(app, "local-ai download stories-15m")
        let state = any(app, "local-ai-state-stories-15m")
        wait(state, "label == 'Downloaded'", timeout: 30)
    }

    /// The queue: which app holds the GPU, an accurate place in line, a job's checkpoints.
    func test_localAiQueueGpuHolderAndCheckpoints() throws {
        let app = launch(tab: "home", ["-smoke-local-ai"])
        openLocalAi(app)
        let holder = any(app, "local-ai-gpu-holder-0")
        XCTAssertTrue(holder.waitForExistence(timeout: 15))
        XCTAssertEqual(holder.label, "Held by Plants")
        let queue = any(app, "local-ai-job-queue-2222222222222222")
        XCTAssertTrue(reveal(app, queue, tries: 18), "The waiting job shows its place in line.")
        XCTAssertEqual(queue.label, "Number 2 in line")
        shot(app, "local-ai-queue")
        let open = app.buttons["local-ai-job-open-1111111111111111"]
        XCTAssertTrue(reveal(app, open, tries: 6))
        open.tap()
        XCTAssertTrue(any(app, "local-ai-checkpoint-1").waitForExistence(timeout: 15), "The job's checkpoint is listed.")
        shot(app, "local-ai-checkpoints")
    }

    /// Fine-tuning is a signed order naming the app (its sample data) and the base model; allowing an
    /// app is a signed grant with the default quotas.
    func test_localAiFineTuneAndAppGrantAreSigned() throws {
        let app = launch(tab: "home", ["-smoke-local-ai"])
        openLocalAi(app)
        let tune = app.buttons["local-ai-finetune"]
        XCTAssertTrue(reveal(app, tune, tries: 18))
        bringToMiddle(app, tune)
        tune.tap()
        let start = app.buttons["local-ai-train-start"]
        XCTAssertTrue(start.waitForExistence(timeout: 10))
        shot(app, "local-ai-finetune")
        XCTAssertTrue(start.isEnabled, "An app with sample data and a downloaded base model can be fine-tuned.")
        start.tap()
        let err = app.staticTexts["local-ai-train-error"]
        if err.waitForExistence(timeout: 4) { XCTFail("The fine-tune was refused: \(err.label)") }
        expectProbe(app, "signed local-ai-train by admin-root")
        expectProbe(app, "local-ai train bright-maple--wiki stories-260k")
        let allow = app.buttons["local-ai-app-allow-bright-maple--wiki"]
        XCTAssertTrue(reveal(app, allow, tries: 18), "Wiki asks to use the model.")
        bringToMiddle(app, allow)
        allow.tap()
        expectProbe(app, "signed local-ai-app-grant by admin-root")
        expectProbe(app, "local-ai grant bright-maple--wiki 500")
        XCTAssertTrue(app.buttons["local-ai-app-withdraw-bright-maple--wiki"].waitForExistence(timeout: 15))
    }

    /// With no model downloaded the box's own sentence shows, and nothing starts elsewhere.
    func test_localAiStartRefusedSaysWhy() throws {
        let app = launch(tab: "home", ["-smoke-local-ai-unavailable"])
        openLocalAi(app)
        let start = app.buttons["local-ai-start"]
        XCTAssertTrue(reveal(app, start, tries: 10))
        XCTAssertFalse(start.isEnabled, "Start needs a downloaded model.")
        shot(app, "local-ai-empty")
    }

    // MARK: - GPUs (packages/server-daemon/src/gpu/http.ts)

    private func openAccelerators(_ app: XCUIApplication) -> XCUIElement {
        openServerPage(app, named: "Home")
        let card = any(app, "accelerators-card")
        XCTAssertTrue(reveal(app, card, tries: 20), "The server page has a GPUs card.")
        let holder = any(app, "accelerator-holder-0")
        XCTAssertTrue(reveal(app, holder, tries: 6))
        bringToMiddle(app, holder)
        return holder
    }

    /// Each GPU with its model, memory and state; the app that holds it; the apps waiting.
    func test_acceleratorsShowWhoHoldsEachGpu() throws {
        let app = launch(tab: "home", ["-smoke-accelerators", "-smoke-accelerators-paused"])
        let holder = openAccelerators(app)
        XCTAssertEqual(any(app, "accelerator-name-0").label, "GPU 0: NVIDIA GeForce RTX 4090")
        XCTAssertEqual(holder.label, "Used by Plants")
        XCTAssertTrue(any(app, "accelerator-state-0").label.hasSuffix("In use"), any(app, "accelerator-state-0").label)
        XCTAssertTrue(any(app, "accelerator-state-1").label.hasSuffix("Free"))
        XCTAssertTrue(any(app, "accelerator-state-2").label.hasSuffix("Set aside after a fault"))
        XCTAssertTrue(app.buttons["accelerator-stop-app-bright-maple--plants-k1"].exists, "The holder can be stopped.")
        XCTAssertFalse(any(app, "accelerator-holder-1").exists, "A free GPU has no holder.")
        let queue = any(app, "accelerator-queue-bright-maple--wiki")
        XCTAssertTrue(reveal(app, queue, tries: 6))
        XCTAssertEqual(queue.label, "Wiki is waiting")
        XCTAssertTrue(any(app, "accelerators-paused").exists, "Paused admission says so.")
        shot(app, "accelerators-card")
    }

    /// Stop asks first; Cancel sends nothing; Stop frees the GPU and the app waiting gets it.
    func test_acceleratorStopAsksThenFreesTheGpu() throws {
        let app = launch(tab: "home", ["-smoke-accelerators"])
        _ = openAccelerators(app)
        let stop = app.buttons["accelerator-stop-app-bright-maple--plants-k1"]
        XCTAssertEqual(stop.label, "Stop")
        stop.tap()
        XCTAssertTrue(app.staticTexts["Stop Plants using the GPU?"].waitForExistence(timeout: 10), "Stop asks first.")
        cancelDialog(app)
        XCTAssertFalse(probe(app).contains("accelerator stop"), "Cancel sends nothing.")
        stop.tap()
        let confirm = app.buttons.matching(NSPredicate(
            format: "identifier == 'accelerator-stop-confirm' OR (label == 'Stop' AND NOT (identifier BEGINSWITH 'accelerator-stop-app'))")).firstMatch
        XCTAssertTrue(confirm.waitForExistence(timeout: 10))
        confirm.tap()
        expectProbe(app, "accelerator stop app-bright-maple--plants-k1")
        let notice = any(app, "accelerators-notice")
        XCTAssertTrue(notice.waitForExistence(timeout: 15))
        XCTAssertEqual(notice.label, "Plants no longer has the GPU.")
        wait(any(app, "accelerator-holder-0"), "label == 'Starting for Wiki'", timeout: 15)
        waitGone(any(app, "accelerator-queue-bright-maple--wiki"))
        shot(app, "accelerators-stopped")
    }

    /// A box with no GPU (or no GPU service) shows no card.
    func test_noGpuShowsNoCard() throws {
        let app = launch(tab: "home", ["-smoke-accelerators-none"])
        openServerPage(app, named: "Home")
        XCTAssertTrue(reveal(app, app.buttons["local-ai-open"], tries: 20), "The page has loaded to Local AI.")
        for _ in 0..<4 { app.swipeUp() }
        XCTAssertFalse(any(app, "accelerators-card").exists, "No GPU: no card.")
        shot(app, "accelerators-none")
    }

    // MARK: - GPU approvals (flagship/gpu-approval/v1)

    private func tapRevealed(_ app: XCUIApplication, _ el: XCUIElement) {
        XCTAssertTrue(reveal(app, el, tries: 20), "\(el) is on the page.")
        bringToMiddle(app, el)
        el.tap()
    }

    /// Render asks with its exact terms; Approve signs the approval with the admin root and Render moves to
    /// the approved list; Decline on Train hides it and sends nothing; Stream's sharing request is approved
    /// with a trust domain and consent; Withdraw on Photos signs flagship/gpu-approval-withdraw/v1.
    func test_gpuApprovalApproveDeclineWithdraw() throws {
        let app = launch(tab: "home", ["-smoke-accelerators", "-smoke-gpu-approvals"])
        openServerPage(app, named: "Home")
        let ask = any(app, "gpu-approval-ask-bright-maple--render")
        XCTAssertTrue(reveal(app, ask, tries: 20), "Render's request is on the GPUs card.")
        XCTAssertEqual(ask.label, "Render asks to use the GPU: 1 × NVIDIA GPU, computing, a GPU of its own, in the app sandbox, kept apart from other apps")
        XCTAssertEqual(any(app, "gpu-approval-ask-bright-maple--train").label,
                       "Train asks to use the GPU: 4 × AMD GPU, computing, graphics, a GPU of its own, in its own virtual machine, kept apart from other apps")
        shot(app, "gpu-approval-pending")
        tapRevealed(app, app.buttons["gpu-approval-approve-bright-maple--render"])
        expectProbe(app, "signed gpu-approval by admin-root")
        expectProbe(app, "gpu approval bright-maple--render")
        wait(any(app, "accelerators-notice"), "label == 'Render can use the GPU.'", timeout: 15)
        XCTAssertTrue(any(app, "gpu-approval-allowed-bright-maple--render").waitForExistence(timeout: 10), "Render is approved now.")
        waitGone(any(app, "gpu-approval-ask-bright-maple--render"))

        // Decline sends nothing (the box keeps no refusal: an app not approved gets no GPU) and hides the ask.
        tapRevealed(app, app.buttons["gpu-approval-decline-bright-maple--train"])
        wait(any(app, "accelerators-notice"), "label == \"Train won't get a GPU.\"", timeout: 15)
        waitGone(any(app, "gpu-approval-ask-bright-maple--train"))
        XCTAssertFalse(probe(app).contains("gpu approval withdrawn bright-maple--train"), "Decline signs nothing.")

        // Sharing a GPU: the owner's approval names the trust domain and consent the box requires.
        tapRevealed(app, app.buttons["gpu-approval-approve-bright-maple--stream"])
        expectProbe(app, "gpu approval bright-maple--stream")
        wait(any(app, "accelerators-notice"), "label == 'Stream can use the GPU.'", timeout: 15)

        let photos = any(app, "gpu-approval-allowed-bright-maple--photos")
        XCTAssertTrue(photos.label.hasPrefix("Photos may use the GPU: 1 × NVIDIA GPU, computing, video encoding, a GPU shared with trusted apps"), photos.label)
        tapRevealed(app, app.buttons["gpu-approval-withdraw-bright-maple--photos"])
        expectProbe(app, "gpu approval withdrawn bright-maple--photos")
        wait(any(app, "accelerators-notice"), "label == 'Photos can no longer use the GPU.'", timeout: 15)
        waitGone(any(app, "gpu-approval-allowed-bright-maple--photos"))
        shot(app, "gpu-approval-answered")
    }

    /// A device without the admin root sees the requests and approvals with the admin-only line, and no buttons.
    func test_gpuApprovalReadOnlyOnANonAdminDevice() throws {
        let app = launch(tab: "home", admin: false, ["-smoke-accelerators", "-smoke-gpu-approvals"])
        openServerPage(app, named: "Home")
        XCTAssertTrue(reveal(app, any(app, "gpu-approval-ask-bright-maple--render"), tries: 20))
        XCTAssertTrue(reveal(app, any(app, "gpu-approval-admin-only"), tries: 6))
        XCTAssertFalse(app.buttons["gpu-approval-approve-bright-maple--render"].exists)
        XCTAssertFalse(app.buttons["gpu-approval-withdraw-bright-maple--photos"].exists)
        shot(app, "gpu-approval-read-only")
    }

    // MARK: - Container stack (flagship/arch-v2-switch/v1)

    /// The classic box: Move to the new stack signs once with the admin root and dry-runs the order (the
    /// box's plan shows); Move now sends the same order; the card follows the move to its trial.
    func test_stackMoveDryRunThenMove() throws {
        let app = launch(tab: "home", ["-smoke-stack"])
        openServerPage(app, named: "Home")
        let current = any(app, "stack-current")
        XCTAssertTrue(reveal(app, current, tries: 20), "The server page has the Container stack card.")
        XCTAssertEqual(current.label, "This server runs the classic stack (Docker).")
        tapRevealed(app, app.buttons["stack-move"])
        expectProbe(app, "signed arch-v2-switch by admin-root")
        expectProbe(app, "stack dry-run arch-v2")
        XCTAssertTrue(any(app, "stack-step-0").waitForExistence(timeout: 10), "The dry run's plan is shown.")
        XCTAssertTrue(any(app, "stack-room").label.hasPrefix("Needs about"))
        shot(app, "stack-plan")
        tapRevealed(app, app.buttons["stack-move-now"])
        expectProbe(app, "stack switch arch-v2")
        wait(any(app, "stack-notice"), "label == 'The server is restarting for the move. This card shows how it goes.'", timeout: 15)
        let record = any(app, "stack-record")
        wait(record, "label BEGINSWITH 'On trial until'", timeout: 30)
        XCTAssertEqual(any(app, "stack-current").label, "This server runs the new stack (Podman and the Rust services).")
        shot(app, "stack-trial")
    }

    /// Without room for the move the dry run says so in the box's words and Move now stays off.
    func test_stackMoveBlockedSaysWhy() throws {
        let app = launch(tab: "home", ["-smoke-stack-blocked"])
        openServerPage(app, named: "Home")
        tapRevealed(app, app.buttons["stack-move"])
        let blocker = any(app, "stack-blocker-0")
        XCTAssertTrue(blocker.waitForExistence(timeout: 15))
        XCTAssertEqual(blocker.label, "Moving the apps needs about 6.0 GB free on this server; it has 3.0 GB.")
        XCTAssertFalse(app.buttons["stack-move-now"].isEnabled)
        XCTAssertFalse(probe(app).contains("stack switch arch-v2"))
        shot(app, "stack-blocked")
    }

    /// A device without the admin root has no Container stack card.
    func test_stackCardIsAdminOnly() throws {
        let app = launch(tab: "home", admin: false, ["-smoke-stack"])
        openServerPage(app, named: "Home")
        XCTAssertTrue(reveal(app, app.buttons["local-ai-open"], tries: 20))
        for _ in 0..<4 { app.swipeUp() }
        XCTAssertFalse(any(app, "stack-card").exists)
        shot(app, "stack-admin-only")
    }

    // MARK: - Browser access, the last card going

    /// An app with no browser sites of its own and one request: Allow takes the request card away, the
    /// grant reloads under Allowed by you and the note stays; Withdraw takes the last grant away and
    /// the note still says so.
    func test_browserAccessLastRequestThenLastGrant() throws {
        let app = launch(tab: "apps", ["-smoke-browser-grant-alone"])
        let notNow = app.buttons["browser-grant-not-now"]
        XCTAssertTrue(notNow.waitForExistence(timeout: 25), "The inbox asks too.")
        notNow.tap()
        waitGone(notNow)
        openApp(app, named: "Plants")
        let allow = app.buttons["app-browser-allow"]
        XCTAssertTrue(reveal(app, allow, tries: 16), "The request waits on the app page.")
        XCTAssertFalse(any(app, "app-browser-manifest").exists, "This app names no sites of its own.")
        XCTAssertEqual(allow.label, "Allow once")
        bringToMiddle(app, allow)
        allow.tap()
        expectProbe(app, "browser grant allow bright-maple--plants once")
        let note = app.staticTexts["app-browser-note"]
        XCTAssertTrue(note.waitForExistence(timeout: 15), "The answer is confirmed after its card goes.")
        waitGone(app.buttons["app-browser-allow"])
        let heading = app.staticTexts["app-browser-granted-title"]
        XCTAssertTrue(reveal(app, heading, tries: 6), "The grants reload: the new one is under Allowed by you.")
        XCTAssertTrue(app.staticTexts["news.example.com"].exists)
        shot(app, "browser-access-last-request")
        let withdraw = app.buttons["app-browser-withdraw"]
        XCTAssertTrue(reveal(app, withdraw, tries: 6))
        bringToMiddle(app, withdraw)
        withdraw.tap()
        expectProbe(app, "browser grant withdrawn bright-maple--plants")
        waitGone(app.buttons["app-browser-withdraw"])
        wait(note, "label == 'Browser access withdrawn'", timeout: 15)
        XCTAssertFalse(app.staticTexts["news.example.com"].exists, "The grant is gone.")
        shot(app, "browser-access-last-grant")
    }
}
