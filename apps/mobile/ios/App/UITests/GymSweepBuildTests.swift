import XCTest

/// GYM iOS button sweep (mock tier), Build and AI: the chooser and its help,
/// git import (fit, not fit, the AI adapt with sharing, relay failure,
/// sealed, taken names), the IDE connection, Build sessions (resume,
/// discard, timelines), the AI-key step, the Describe form, and the build
/// chat (continue a ready or failed chat, switch provider and model, effort,
/// the summarise notice, images and the vision switch, env vars, deploy).
/// See GymSweepSupport. `-smoke-chat` seeds one saved OpenAI key ("Work")
/// and two chats: gym-ready (Flagship Inference, Medium, ready to deploy, a
/// long conversation) and gym-failed (OpenAI, Qwen3 Coder, failed on the
/// Flagship relay).
final class GymSweepBuildTests: GymSweepCase {

    // MARK: - Helpers

    func openBuildChooser(_ app: XCUIApplication) {
        let build = app.buttons["Build another service"]
        XCTAssertTrue(build.waitForExistence(timeout: 15), "Services should offer a build affordance.")
        build.tap()
        XCTAssertTrue(app.buttons["build-src-scratch"].waitForExistence(timeout: 15), "The chooser should render.")
    }

    func openBuildSessions(_ app: XCUIApplication) {
        openBuildChooser(app)
        let link = app.buttons["build-source-journal-link"]
        XCTAssertTrue(link.waitForExistence(timeout: 10))
        link.tap()
        XCTAssertTrue(app.navigationBars["Build sessions"].waitForExistence(timeout: 15))
    }

    /// Build sessions → a chat; waits for its title.
    func openChat(_ app: XCUIApplication, _ id: String, title: String) {
        openBuildSessions(app)
        let row = app.buttons["build-session-\(id)"]
        XCTAssertTrue(reveal(app, row), "Build sessions lists the \(id) chat.")
        row.tap()
        XCTAssertTrue(app.navigationBars[title].waitForExistence(timeout: 15), "The \(id) chat opens (\(title)).")
    }

    /// A text field by identifier, else by its placeholder.
    func field(_ app: XCUIApplication, id: String, placeholder: String) -> XCUIElement {
        app.textFields.matching(NSPredicate(format: "identifier == %@ OR placeholderValue == %@", id, placeholder)).firstMatch
    }

    func replace(_ el: XCUIElement, with text: String) {
        el.tap()
        if let v = el.value as? String, !v.isEmpty, v != el.placeholderValue {
            el.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: v.count))
        }
        el.typeText(text)
    }

    /// Close an open popover (the model menu) by tapping outside it.
    func closePopover(_ app: XCUIApplication) {
        let region = app.otherElements["PopoverDismissRegion"]
        if region.exists { region.tap() } else { app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.95)).tap() }
        waitGone(app.otherElements["model-menu-panel"])
    }

    /// The chat's model menu → one row → closed.
    func pickChatModel(_ app: XCUIApplication, _ row: XCUIElement) {
        let menu = app.buttons["vibecode-model-menu"]
        XCTAssertTrue(menu.waitForExistence(timeout: 15), "The chat offers its model menu.")
        menu.tap()
        XCTAssertTrue(row.waitForExistence(timeout: 15), "The menu lists \(row).")
        row.tap()
        closePopover(app)
    }

    func ownModelRow(_ app: XCUIApplication, _ model: String) -> XCUIElement {
        app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'model-menu-' AND identifier ENDSWITH %@", "-\(model)")).firstMatch
    }

    func send(_ app: XCUIApplication, _ text: String) {
        let reply = app.textFields["vibecode-reply-field"]
        XCTAssertTrue(reply.waitForExistence(timeout: 10), "The chat takes a message.")
        reply.tap()
        reply.typeText(text)
        app.buttons["vibecode-reply-send-btn"].tap()
    }

    /// Flip a SwiftUI Toggle: its switch sits at the trailing edge of the row.
    func flip(_ toggle: XCUIElement) {
        let before = toggle.value as? String
        let inner = toggle.switches.firstMatch
        if inner.exists { inner.tap() } else { toggle.coordinate(withNormalizedOffset: CGVector(dx: 0.95, dy: 0.5)).tap() }
        let changed = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value != %@", before ?? ""), object: toggle)
        if XCTWaiter().wait(for: [changed], timeout: 3) != .completed { toggle.tap() }
    }

    /// Close a confirmation dialog without choosing: its Cancel button when
    /// it shows one, else a tap outside it.
    func dismissDialog(_ app: XCUIApplication) { cancelDialog(app) }

    func probeCount(_ app: XCUIApplication, _ line: String) -> Int {
        probe(app).components(separatedBy: line).count - 1
    }

    /// The chooser → scratch → the AI-key step.
    func openKeyStep(_ app: XCUIApplication) {
        openBuildChooser(app)
        app.buttons["build-src-scratch"].tap()
        XCTAssertTrue(app.navigationBars["AI Key"].waitForExistence(timeout: 15), "Scratch starts at the AI-key step.")
    }

    /// The chooser → git import with `url` checked.
    func checkRepo(_ app: XCUIApplication, url: String) {
        openBuildChooser(app)
        app.buttons["build-src-git"].tap()
        let urlField = field(app, id: "-", placeholder: "https://github.com/you/app")
        XCTAssertTrue(urlField.waitForExistence(timeout: 10))
        urlField.tap()
        urlField.typeText(url)
        app.buttons["build-git-check"].tap()
    }

    // MARK: - Interrupted git build (A2)

    /// A restart cut a git build's AI run off (`-smoke-build-interrupted`):
    /// Build sessions → the kept build shows the box's sentence; "Run the AI
    /// again or deploy" reopens it on the git screen with both actions, and
    /// Deploy puts what the AI wrote live.
    func test_interruptedGitBuildOffersRunAgainAndDeploy() throws {
        let app = launch(tab: "apps", ["-smoke-build-interrupted"])
        openBuildSessions(app)
        let row = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "recipes")).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 15), "The kept git build is listed as open.")
        row.tap()
        let reason = app.staticTexts["build-journal-failed-reason"]
        XCTAssertTrue(reason.waitForExistence(timeout: 15), "The kept build says why its run failed.")
        XCTAssertTrue(reason.label.hasPrefix("The server restarted while the AI was working on this build."),
                      "Got: \(reason.label)")
        shot(app, "build-interrupted-timeline")

        app.buttons["build-journal-open-git"].tap()
        let err = app.staticTexts["build-git-adapt-error"]
        XCTAssertTrue(err.waitForExistence(timeout: 15), "The git screen shows the box's reason.")
        XCTAssertTrue(err.label.contains("Its files are kept"), "Got: \(err.label)")
        let again = app.buttons["build-git-adapt"]
        XCTAssertTrue(reveal(app, again))
        XCTAssertEqual(again.label, "Run the AI again")
        let deploy = app.buttons["build-git-deploy-kept"]
        XCTAssertTrue(reveal(app, deploy), "A kept build offers to deploy what it has.")
        shot(app, "build-interrupted-git")
        deploy.tap()
        XCTAssertTrue(app.staticTexts["Installed"].waitForExistence(timeout: 15), "Deploy puts the kept build live.")
        expectProbe(app, "deployed build bld-recipes03")
    }

    // MARK: - Chooser, help, Build sessions

    /// The chooser's help sheet opens and Done closes it; Build sessions
    /// lists chats, open builds and past builds: discarding a chat or an open
    /// build goes through its dialog (Cancel keeps it), a past build opens
    /// its timeline and "All builds" returns, and pull to refresh reloads.
    func test_chooserHelpAndBuildSessionsDiscard() throws {
        let app = launch(tab: "apps", ["-smoke-chat", "-smoke-build-interrupted"])
        openBuildChooser(app)
        app.buttons["build-source-help"].tap()
        XCTAssertTrue(app.navigationBars["How building works"].waitForExistence(timeout: 10), "Help explains the options.")
        XCTAssertTrue(app.staticTexts["Connect your IDE"].exists)
        shot(app, "build-help")
        app.navigationBars["How building works"].buttons["Done"].tap()
        waitGone(app.navigationBars["How building works"])

        app.buttons["build-source-journal-link"].tap()
        XCTAssertTrue(app.navigationBars["Build sessions"].waitForExistence(timeout: 15))
        let ready = app.buttons["build-session-gym-ready"]
        XCTAssertTrue(ready.waitForExistence(timeout: 15))
        XCTAssertTrue(ready.label.contains("Ready to deploy"), "Got: \(ready.label)")
        XCTAssertTrue(app.buttons["build-session-gym-failed"].label.contains("Failed"))
        shot(app, "build-sessions")

        // Cancel keeps the chat.
        app.buttons["build-session-discard-gym-ready"].tap()
        XCTAssertTrue(text(app, containing: "\"recipe-box\", becomes free again").waitForExistence(timeout: 10),
                      "The dialog says what discarding frees.")
        dismissDialog(app)
        waitGone(text(app, containing: "\"recipe-box\", becomes free again"))
        XCTAssertTrue(ready.waitForExistence(timeout: 5))
        expectNoProbe(app, "discarded chat gym-ready")

        let failedDiscard = app.buttons["build-session-discard-gym-failed"]
        XCTAssertTrue(reveal(app, failedDiscard))
        failedDiscard.tap()
        let discard = app.buttons.matching(NSPredicate(format: "label == %@", "Discard build")).firstMatch
        XCTAssertTrue(discard.waitForExistence(timeout: 10))
        discard.tap()
        expectProbe(app, "discarded chat gym-failed")
        waitGone(app.buttons["build-session-gym-failed"])

        let buildDiscard = app.buttons["build-discard-bld-recipes03"]
        XCTAssertTrue(reveal(app, buildDiscard), "An open git build can be discarded.")
        buildDiscard.tap()
        XCTAssertTrue(text(app, containing: "Its name, \"recipes\", becomes free again").waitForExistence(timeout: 10))
        app.buttons.matching(NSPredicate(format: "label == %@", "Discard build")).firstMatch.tap()
        expectProbe(app, "discarded build bld-recipes03")
        waitGone(app.buttons["build-discard-bld-recipes03"])

        // A past build opens its timeline; "All builds" comes back.
        let past = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "9 steps")).firstMatch
        XCTAssertTrue(reveal(app, past), "The deployed Plants build is a past build.")
        past.tap()
        XCTAssertTrue(app.staticTexts["Build timeline"].waitForExistence(timeout: 10))
        XCTAssertTrue(text(app, containing: "Build a houseplant watering tracker").waitForExistence(timeout: 10))
        app.buttons["All builds"].tap()
        XCTAssertTrue(app.buttons["build-session-gym-ready"].waitForExistence(timeout: 10))
        app.swipeDown()
        XCTAssertTrue(app.buttons["build-session-gym-ready"].waitForExistence(timeout: 10), "Pull to refresh reloads the list.")
    }

    // MARK: - The build chat

    /// A ready chat continues on another provider: it shows the summarised
    /// note and the credits a Flagship reply used; the menu lists Flagship
    /// Inference and the saved key's models; picking GPT-5.4 Mini (Work)
    /// offers its effort levels and warns older turns will be summarised;
    /// the message carries that model, effort and the key's provider (never
    /// the key), and Deploy then puts it live with the same key.
    func test_continueReadyChatOnAnotherProviderThenDeploy() throws {
        let app = launch(tab: "apps", ["-smoke-chat"])
        openChat(app, "gym-ready", title: "Ready to deploy")
        XCTAssertTrue(app.staticTexts["Earlier conversation summarised"].waitForExistence(timeout: 10))
        XCTAssertEqual(app.staticTexts["vibecode-credits"].label, "used 2.5 credits")
        let reply = app.textFields["vibecode-reply-field"]
        XCTAssertTrue(reply.waitForExistence(timeout: 10), "A ready chat takes a new message.")
        XCTAssertEqual(reply.placeholderValue, "Ask for a change…")
        let menu = app.buttons["vibecode-model-menu"]
        XCTAssertTrue(menu.waitForExistence(timeout: 15))
        wait(menu, "label CONTAINS 'Medium 1×'")
        XCTAssertFalse(app.buttons["vibecode-effort-menu"].exists, "Flagship's Medium lists no effort levels.")

        menu.tap()
        XCTAssertTrue(app.buttons["model-menu-flagship-inference-high"].waitForExistence(timeout: 15),
                      "Flagship Inference's models are listed.")
        let gpt = ownModelRow(app, "gpt-5.4-mini")
        XCTAssertTrue(gpt.waitForExistence(timeout: 15), "So are the saved key's models.")
        XCTAssertTrue(app.staticTexts["OPENAI · WORK"].exists, "Grouped under the key.")
        shot(app, "chat-model-menu")
        gpt.tap()
        closePopover(app)
        wait(menu, "label CONTAINS 'GPT-5.4 Mini · Work'")

        let effort = app.buttons["vibecode-effort-menu"]
        XCTAssertTrue(effort.waitForExistence(timeout: 10), "A model with effort levels offers them.")
        XCTAssertEqual(effort.label, "Effort: Medium")
        effort.tap()
        let high = app.buttons.matching(NSPredicate(format: "label == %@", "High")).firstMatch
        XCTAssertTrue(high.waitForExistence(timeout: 10))
        high.tap()
        wait(effort, "label == 'Effort: High'")
        let notice = app.staticTexts["vibecode-context-notice"]
        XCTAssertTrue(notice.waitForExistence(timeout: 10), "Switching would summarise the long conversation.")
        XCTAssertEqual(notice.label, "Older messages will be summarised to fit this model.")
        shot(app, "chat-switched")

        send(app, "Add a dark mode")
        expectProbe(app, "replied to gym-ready: text model=gpt-5.4-mini effort=high provider=openai attachments=0")
        XCTAssertTrue(text(app, containing: "Add a dark mode").waitForExistence(timeout: 10), "The message joins the chat.")

        app.buttons["vibecode-deploy-btn"].tap()
        expectProbe(app, "deploy started gym-ready provider=openai")
        XCTAssertTrue(app.staticTexts["vibecode-deployed-url"].waitForExistence(timeout: 30), "Deploy puts it live.")
        XCTAssertTrue(button(app, "Open").exists, "A live chat offers to open the app.")
        shot(app, "chat-deployed")
    }

    /// A failed chat on the Flagship relay: "Turn the relay off for this
    /// key" says it's off, the retry message carries the key again (the box
    /// must use the new setting), and "Try deploying again" deploys.
    func test_continueFailedChatAfterTurningTheRelayOffThenRedeploy() throws {
        let app = launch(tab: "apps", ["-smoke-chat"])
        openChat(app, "gym-failed", title: "Failed")
        XCTAssertTrue(text(app, containing: "The Flagship relay isn't reachable").waitForExistence(timeout: 10))
        let off = app.buttons["vibecode-relay-off"]
        XCTAssertTrue(off.waitForExistence(timeout: 10), "A relay failure offers to turn the relay off.")
        off.tap()
        XCTAssertTrue(app.staticTexts["The relay is off for this key. Try again."].waitForExistence(timeout: 10))
        XCTAssertFalse(off.exists)
        let reply = app.textFields["vibecode-reply-field"]
        XCTAssertTrue(reply.waitForExistence(timeout: 10), "A failed chat takes a new message.")
        XCTAssertEqual(reply.placeholderValue, "Tell the AI what to try next…")
        shot(app, "chat-failed-relay-off")
        send(app, "Try without the relay")
        expectProbe(app, "replied to gym-failed: text model=qwen3-coder effort=- provider=openai attachments=0")

        let redeploy = app.buttons["vibecode-redeploy-btn"]
        XCTAssertTrue(redeploy.waitForExistence(timeout: 10))
        redeploy.tap()
        expectProbe(app, "deploy started gym-failed provider=openai")
        XCTAssertTrue(app.staticTexts["vibecode-deployed-url"].waitForExistence(timeout: 30), "The retry deploys.")
    }

    /// An image staged on a text-only model (`-smoke-chat-image`): High
    /// can't see images and sends nothing (OK); Medium offers to switch to
    /// its multimodal sibling: Cancel sends nothing, Switch sends the image
    /// to Medium multimodal.
    func test_imageAsksForAModelThatSeesIt() throws {
        let app = launch(tab: "apps", ["-smoke-chat", "-smoke-chat-image"])
        openChat(app, "gym-ready", title: "Ready to deploy")
        XCTAssertTrue(app.buttons["Remove mockup.png"].waitForExistence(timeout: 10), "The image is staged.")
        XCTAssertTrue(app.staticTexts["chat-attach-notice"].exists, "The notice says the AI sees attachments.")

        pickChatModel(app, app.buttons["model-menu-flagship-inference-high"])
        send(app, "Match this mockup")
        let alert = app.alerts.firstMatch
        XCTAssertTrue(alert.waitForExistence(timeout: 10))
        XCTAssertTrue(alert.label.contains("MiniMax-M3 can't see images"), "Got: \(alert.label)")
        alert.buttons["OK"].tap()
        expectNoProbe(app, "replied to gym-ready")

        pickChatModel(app, app.buttons["model-menu-flagship-inference-medium"])
        app.buttons["vibecode-reply-send-btn"].tap()
        XCTAssertTrue(alert.waitForExistence(timeout: 10))
        XCTAssertTrue(alert.label.contains("I'll have to switch to GLM-5.3-Flash (2×) for this."), "Got: \(alert.label)")
        shot(app, "chat-vision-switch")
        alert.buttons["Cancel"].tap()
        expectNoProbe(app, "replied to gym-ready")

        app.buttons["vibecode-reply-send-btn"].tap()
        XCTAssertTrue(alert.waitForExistence(timeout: 10))
        alert.buttons["Switch"].tap()
        expectProbe(app, "replied to gym-ready: text model=medium-vision effort=- provider=flagship attachments=1")
        waitGone(app.buttons["Remove mockup.png"])
    }

    /// Removing a staged image drops it from the next message; the attach
    /// control offers Photo and File (the system pickers aren't driven).
    func test_removedImageIsNotSent() throws {
        let app = launch(tab: "apps", ["-smoke-chat", "-smoke-chat-image"])
        openChat(app, "gym-ready", title: "Ready to deploy")
        let remove = app.buttons["Remove mockup.png"]
        XCTAssertTrue(remove.waitForExistence(timeout: 10))
        remove.tap()
        waitGone(remove)
        XCTAssertFalse(app.staticTexts["chat-attach-notice"].exists)

        let attach = app.buttons["chat-attach"]
        XCTAssertTrue(attach.exists)
        attach.tap()
        XCTAssertTrue(app.buttons["Photo"].waitForExistence(timeout: 10), "Attach offers a photo…")
        XCTAssertTrue(app.buttons["File"].exists, "…or a file.")
        shot(app, "chat-attach-menu")
        app.navigationBars["Ready to deploy"].tap()
        waitGone(app.buttons["File"])

        send(app, "No image after all")
        expectProbe(app, "replied to gym-ready: text model=medium effort=- provider=flagship attachments=0")
    }

    /// The AI asks for an env var (`-smoke-ops`, the gym-smoke chat): Send
    /// value stores it on the box and answers "set"; Decline answers
    /// "declined".
    func test_envVarAnswerSendAndDecline() throws {
        let app = launch(tab: "apps", ["-smoke-ops"])
        let bar = app.buttons["global-operations-bar"]
        let barShown = bar.waitForExistence(timeout: 15) || app.otherElements["global-operations-bar"].waitForExistence(timeout: 3)
        XCTAssertTrue(barShown)
        if bar.exists { bar.tap() } else { app.otherElements["global-operations-bar"].tap() }
        let value = app.secureTextFields["vibecode-envvar-field"]
        XCTAssertTrue(value.waitForExistence(timeout: 15), "The AI waits on WEATHER_API_KEY.")
        XCTAssertTrue(text(app, containing: "The app needs WEATHER_API_KEY").exists)
        let sendValue = app.buttons["vibecode-envvar-send-btn"]
        XCTAssertFalse(sendValue.isEnabled, "Nothing to send yet.")
        value.tap()
        value.typeText("abc123")
        wait(sendValue, "isEnabled == true")
        sendValue.tap()
        expectProbe(app, "replied to gym-smoke: env=set")
        app.buttons["vibecode-envvar-decline-btn"].tap()
        expectProbe(app, "replied to gym-smoke: env=declined")
    }

    // MARK: - The AI-key step and Describe

    /// The key step: Flagship Inference first with its credits; add a key
    /// (provider, key, base URL, label, relay off) and cancel a second form;
    /// a saved key's relay switch; delete through its dialog; Use this moves
    /// on to New Service.
    func test_keyStepAddRelayDeleteAndUse() throws {
        let app = launch(tab: "apps", ["-smoke-chat"])
        openKeyStep(app)
        XCTAssertTrue(app.staticTexts["free-ai-status"].waitForExistence(timeout: 15))
        XCTAssertEqual(app.staticTexts["free-ai-status"].label, "1,840 free credits left · 500 added each week")
        XCTAssertTrue(app.buttons["build-key-use-free-ai"].exists, "Flagship Inference can be used.")
        XCTAssertTrue(app.buttons["build-key-confirm-active"].exists, "The saved Work key is listed, last used.")

        app.buttons["build-key-add"].tap()
        let provider = app.buttons["ai-key-provider"]
        XCTAssertTrue(provider.waitForExistence(timeout: 10))
        provider.tap()
        app.buttons["Anthropic"].tap()
        let key = app.secureTextFields.firstMatch
        key.tap()
        key.typeText("sk-ant-gym-0000000000000000")
        let base = field(app, id: "-", placeholder: "https://…")
        base.tap()
        base.typeText("https://llm.example.com")
        let label = field(app, id: "-", placeholder: "e.g. Personal")
        label.tap()
        label.typeText("Gym")
        let relay = app.switches["ai-key-relay-toggle"]
        XCTAssertTrue(relay.exists)
        XCTAssertEqual(relay.value as? String, "1", "New keys go through the relay by default.")
        flip(relay)
        wait(relay, "value == '0'")
        shot(app, "key-step-form")
        app.buttons["build-key-add-save"].tap()
        XCTAssertTrue(app.staticTexts["Gym"].waitForExistence(timeout: 10), "The new key is listed.")
        XCTAssertTrue(text(app, containing: "anthropic · Gym").exists)

        // A second form can be cancelled.
        app.buttons["build-key-add"].tap()
        XCTAssertTrue(app.buttons["build-key-add-save"].waitForExistence(timeout: 10))
        button(app, "Cancel").tap()
        waitGone(app.buttons["build-key-add-save"])

        let relays = app.switches.matching(identifier: "build-key-relay")
        XCTAssertEqual(relays.count, 2)
        let workRelay = relays.element(boundBy: 0)
        XCTAssertEqual(workRelay.value as? String, AiRelay.on)
        flip(workRelay)
        wait(workRelay, "value == '\(AiRelay.off)'")

        app.buttons["Delete Gym"].tap()
        XCTAssertTrue(text(app, containing: "Gym will be removed from this phone").waitForExistence(timeout: 10))
        app.buttons.matching(NSPredicate(format: "label == %@", "Delete key")).firstMatch.tap()
        waitGone(app.staticTexts["Gym"])

        app.buttons["build-key-confirm-active"].tap()
        XCTAssertTrue(app.navigationBars["New Service"].waitForExistence(timeout: 15), "Use this moves on to Describe.")
    }

    enum AiRelay {
        static let on = "Through the Flagship relay"
        static let off = "Direct"
    }

    /// Describe with Flagship Inference: the example chip fills the prompt,
    /// the keyboard's Done closes it, the visibility and the High model are
    /// picked, and Build it starts the chat with them.
    func test_describeStartsAChatWithTheChosenModel() throws {
        let app = launch(tab: "apps", ["-smoke-chat"])
        openKeyStep(app)
        let free = app.buttons["build-key-use-free-ai"]
        XCTAssertTrue(free.waitForExistence(timeout: 15))
        free.tap()
        XCTAssertTrue(app.navigationBars["New Service"].waitForExistence(timeout: 15))
        let name = field(app, id: "describe-name-field", placeholder: "plant-tracker")
        XCTAssertTrue(name.waitForExistence(timeout: 10))
        name.tap()
        name.typeText("habits")
        XCTAssertTrue(app.staticTexts["Available"].waitForExistence(timeout: 10), "The name is free.")
        app.buttons["Habit tracker"].tap()
        let prompt = app.textViews.firstMatch
        XCTAssertTrue((prompt.value as? String ?? "").hasPrefix("A habit tracker"), "The chip fills the prompt.")
        prompt.tap()
        prompt.typeText(" Weekly view.")
        let done = app.buttons["describe-keyboard-done"]
        XCTAssertTrue(done.waitForExistence(timeout: 5), "The keyboard offers Done.")
        done.tap()
        app.segmentedControls["describe-visibility"].buttons["Anyone with the link"].tap()
        XCTAssertTrue(text(app, containing: "Anyone with the address can open it").exists)

        let model = app.buttons["describe-model-menu"]
        XCTAssertTrue(reveal(app, model))
        model.tap()
        let high = app.buttons["model-menu-high"]
        XCTAssertTrue(high.waitForExistence(timeout: 15), "Flagship Inference's models are listed.")
        high.tap()
        closePopover(app)
        wait(model, "label CONTAINS 'High 3.5×'")
        shot(app, "describe-filled")
        let build = app.buttons["describe-build"]
        XCTAssertTrue(reveal(app, build))
        build.tap()
        expectProbe(app, "started chat: name=habits visibility=link model=high effort=- provider=flagship attachments=0")
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'session vc-'")).firstMatch
            .waitForExistence(timeout: 15), "The chat opens.")
    }

    /// Describe with the saved OpenAI key: its model lists effort levels
    /// beside the menu; Low travels with the start.
    func test_describeWithOwnKeyAndEffort() throws {
        let app = launch(tab: "apps", ["-smoke-chat"])
        openKeyStep(app)
        let work = app.buttons["build-key-confirm-active"]
        XCTAssertTrue(work.waitForExistence(timeout: 15))
        work.tap()
        XCTAssertTrue(app.navigationBars["New Service"].waitForExistence(timeout: 15))
        let effort = app.buttons["describe-effort-menu"]
        XCTAssertTrue(reveal(app, effort), "GPT-5.4 Mini lists effort levels.")
        XCTAssertEqual(effort.label, "Effort: Medium")
        effort.tap()
        app.buttons.matching(NSPredicate(format: "label == %@", "Low")).firstMatch.tap()
        wait(effort, "label == 'Effort: Low'")
        let name = field(app, id: "describe-name-field", placeholder: "plant-tracker")
        revealUp(app, name)
        name.tap()
        name.typeText("notes")
        app.buttons["Sleep journal"].tap()
        let build = app.buttons["describe-build"]
        XCTAssertTrue(reveal(app, build))
        build.tap()
        expectProbe(app, "started chat: name=notes visibility=just-me model=gpt-5.4-mini effort=low provider=openai attachments=0")
    }

    /// Taken names on Describe: an installed app's name is refused inline; a
    /// build session's name too, and Build it asks: Pick another name stays,
    /// Open build sessions goes there.
    func test_describeTakenNames() throws {
        let app = launch(tab: "apps", ["-smoke-chat"])
        openKeyStep(app)
        app.buttons["build-key-use-free-ai"].tap()
        XCTAssertTrue(app.navigationBars["New Service"].waitForExistence(timeout: 15))
        let name = field(app, id: "describe-name-field", placeholder: "plant-tracker")
        name.tap()
        name.typeText("plants")
        let taken = app.descendants(matching: .any).matching(identifier: "describe-name-taken").firstMatch
        XCTAssertTrue(taken.waitForExistence(timeout: 10))
        XCTAssertTrue(taken.label.contains("You already have a service called \"plants\""), "Got: \(taken.label)")
        replace(name, with: "recipe-box")
        wait(taken, "label CONTAINS 'A build session already uses'")
        app.buttons["Habit tracker"].tap()
        let build = app.buttons["describe-build"]
        XCTAssertTrue(reveal(app, build))
        build.tap()
        let alert = app.alerts["That name is taken"]
        XCTAssertTrue(alert.waitForExistence(timeout: 10))
        shot(app, "describe-name-taken")
        alert.buttons["Pick another name"].tap()
        waitGone(alert)
        XCTAssertTrue(app.navigationBars["New Service"].exists, "Pick another name stays on the form.")
        build.tap()
        XCTAssertTrue(alert.waitForExistence(timeout: 10))
        alert.buttons["Open build sessions"].tap()
        XCTAssertTrue(app.navigationBars["Build sessions"].waitForExistence(timeout: 15))
        XCTAssertTrue(app.buttons["build-session-gym-ready"].waitForExistence(timeout: 10))
        expectNoProbe(app, "started chat")
    }

    /// Settings → AI keys: "Make default" makes Flagship Inference the
    /// default for new builds, and the key step then marks it last used.
    func test_flagshipInferenceMakeDefault() throws {
        let app = launch(tab: "settings", ["-smoke-chat"])
        let row = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "AI keys")).firstMatch
        XCTAssertTrue(reveal(app, row))
        row.tap()
        let make = app.buttons["free-ai-make-default"]
        XCTAssertTrue(make.waitForExistence(timeout: 15), "The saved key is the default, so Flagship Inference offers Make default.")
        make.tap()
        XCTAssertTrue(app.staticTexts["Default for new builds"].waitForExistence(timeout: 10))
        waitGone(make)
        shot(app, "free-ai-default")
        app.tabBars.buttons["Services"].tap()
        openKeyStep(app)
        XCTAssertTrue(app.staticTexts["Last used"].waitForExistence(timeout: 15), "The key step marks it last used.")
        XCTAssertTrue(app.buttons["build-key-use-saved"].exists, "The Work key is no longer the active one.")
    }

    // MARK: - Git import

    /// A Flagship-ready repo with a branch and a name: the verdict, its
    /// journal, Install it, and the flagship.app.json export's share sheet.
    func test_gitFitInstallJournalAndExport() throws {
        let app = launch(tab: "apps")
        openBuildChooser(app)
        app.buttons["build-src-git"].tap()
        let url = field(app, id: "-", placeholder: "https://github.com/you/app")
        XCTAssertTrue(url.waitForExistence(timeout: 10))
        url.tap()
        url.typeText("https://github.com/flagship/sample-service")
        let ref = field(app, id: "-", placeholder: "main")
        ref.tap()
        ref.typeText("v1")
        let name = field(app, id: "build-git-name", placeholder: "From the repo's name")
        name.tap()
        name.typeText("sample")
        XCTAssertTrue(app.staticTexts["Available"].waitForExistence(timeout: 10))
        wait(app.staticTexts["build-git-address"], "label CONTAINS 'sample.'")
        app.buttons["build-git-check"].tap()
        XCTAssertTrue(app.staticTexts["Flagship-ready"].waitForExistence(timeout: 15))
        expectProbe(app, "git check https://github.com/flagship/sample-service ref=v1 name=sample")
        XCTAssertTrue(app.buttons["build-git-check-again"].exists, "The verdict carries Check again.")
        XCTAssertFalse(app.buttons["build-git-check"].exists, "Check repo steps aside.")

        app.buttons["View build journal →"].tap()
        XCTAssertTrue(app.staticTexts["Build timeline"].waitForExistence(timeout: 15))
        app.navBackButton(in: "Build sessions").tap()
        XCTAssertTrue(app.navigationBars["Git import"].waitForExistence(timeout: 10))

        app.buttons["build-git-deploy"].tap()
        XCTAssertTrue(app.staticTexts["Installed"].waitForExistence(timeout: 15))
        expectProbe(app, "deployed build")
        let export = app.buttons["build-git-export"]
        XCTAssertTrue(reveal(app, export))
        export.tap()
        let share = app.otherElements["ActivityListView"]
        let close = app.buttons["Close"]
        XCTAssertTrue(share.waitForExistence(timeout: 15) || close.waitForExistence(timeout: 3),
                      "The share sheet offers flagship.app.json.")
        shot(app, "git-export-share")
        if close.exists { close.tap() } else { app.swipeDown() }
    }

    /// A repo that isn't ready: share off, Use AI to adapt → the AI-key
    /// step's saved key → the adapt runs with sharing off → Adapted →
    /// Install it.
    func test_gitNotReadyAdaptWithSharingOff() throws {
        let app = launch(tab: "apps", ["-smoke-chat"])
        checkRepo(app, url: "https://github.com/someone/notes-app")
        XCTAssertTrue(app.staticTexts["This repo is not yet adapted for Flagship."].waitForExistence(timeout: 15))
        let share = app.switches["build-git-share"]
        XCTAssertTrue(reveal(app, share))
        XCTAssertEqual(share.value as? String, "1", "Sharing is on for a new check.")
        flip(share)
        wait(share, "value == '0'")
        app.buttons["build-git-adapt"].tap()
        XCTAssertTrue(app.navigationBars["AI Key"].waitForExistence(timeout: 15), "The adapt asks which key first.")
        app.buttons["build-key-confirm-active"].tap()
        expectProbe(app, "adapt started share=false provider=openai")
        XCTAssertTrue(app.staticTexts["Adapted"].waitForExistence(timeout: 20), "The AI adapted the repo.")
        app.buttons["build-git-deploy"].tap()
        XCTAssertTrue(app.staticTexts["Installed"].waitForExistence(timeout: 15))
        expectProbe(app, "deployed build")
    }

    /// The adapt fails on the Flagship relay (`-smoke-git-relay-fails`):
    /// "Turn the relay off for this key" turns it off and says so; the kept
    /// files offer Run the AI again and Deploy.
    func test_gitAdaptRelayFailureTurnsRelayOff() throws {
        let app = launch(tab: "apps", ["-smoke-chat", "-smoke-git-relay-fails"])
        checkRepo(app, url: "https://github.com/someone/notes-app")
        let adapt = app.buttons["build-git-adapt"]
        XCTAssertTrue(adapt.waitForExistence(timeout: 15))
        adapt.tap()
        app.buttons["build-key-confirm-active"].tap()
        let err = app.staticTexts["build-git-adapt-error"]
        XCTAssertTrue(err.waitForExistence(timeout: 20))
        XCTAssertTrue(err.label.contains("Flagship relay"), "Got: \(err.label)")
        let off = app.buttons["build-git-relay-off"]
        XCTAssertTrue(reveal(app, off))
        off.tap()
        wait(err, "label == 'The relay is off for this key. Try again.'")
        waitGone(off)
        XCTAssertEqual(app.buttons["build-git-adapt"].label, "Run the AI again")
        XCTAssertTrue(app.buttons["build-git-deploy-kept"].exists)
    }

    /// The box closed the build to the AI (`-smoke-git-sealed`): the card
    /// says so and Check again starts a new build.
    func test_gitSealedBuildChecksAgain() throws {
        let app = launch(tab: "apps", ["-smoke-chat", "-smoke-git-sealed"])
        checkRepo(app, url: "https://github.com/someone/notes-app")
        let adapt = app.buttons["build-git-adapt"]
        XCTAssertTrue(adapt.waitForExistence(timeout: 15))
        adapt.tap()
        app.buttons["build-key-confirm-active"].tap()
        let err = app.staticTexts["build-git-adapt-error"]
        XCTAssertTrue(err.waitForExistence(timeout: 15))
        XCTAssertTrue(err.label.hasPrefix("This build is closed to the AI"), "Got: \(err.label)")
        let again = app.buttons["build-git-check-again-sealed"]
        XCTAssertTrue(reveal(app, again))
        XCTAssertFalse(app.buttons["build-git-adapt"].exists, "No AI run on a sealed build.")
        again.tap()
        let twice = NSPredicate { _, _ in self.probeCount(app, "git check https://github.com/someone/notes-app") >= 2 }
        XCTAssertEqual(XCTWaiter().wait(for: [XCTNSPredicateExpectation(predicate: twice, object: nil)], timeout: 15),
                       .completed, "Check again checks the repo afresh: \(probe(app))")
    }

    /// A taken name on Git import: refused inline as you type, and when the
    /// box refuses the check (`-smoke-git-name-taken`): Pick another name
    /// stays, Open build sessions goes there.
    func test_gitNameTaken() throws {
        let app = launch(tab: "apps", ["-smoke-chat", "-smoke-git-name-taken"])
        openBuildChooser(app)
        app.buttons["build-src-git"].tap()
        let name = field(app, id: "build-git-name", placeholder: "From the repo's name")
        XCTAssertTrue(name.waitForExistence(timeout: 10))
        name.tap()
        name.typeText("recipe-box")
        let inline = app.descendants(matching: .any).matching(identifier: "build-git-name-taken").firstMatch
        XCTAssertTrue(inline.waitForExistence(timeout: 10), "A build session's name is refused as you type.")
        replace(name, with: "recipes")
        let url = field(app, id: "-", placeholder: "https://github.com/you/app")
        url.tap()
        url.typeText("https://github.com/someone/recipes")
        app.buttons["build-git-check"].tap()
        let alert = app.alerts["That name is taken"]
        XCTAssertTrue(alert.waitForExistence(timeout: 15))
        alert.buttons["Pick another name"].tap()
        waitGone(alert)
        XCTAssertTrue(app.navigationBars["Git import"].exists)
        app.buttons["build-git-check"].tap()
        XCTAssertTrue(alert.waitForExistence(timeout: 15))
        alert.buttons["Open build sessions"].tap()
        XCTAssertTrue(app.navigationBars["Build sessions"].waitForExistence(timeout: 15))
    }

    // MARK: - IDE connection

    /// Create a connection, copy its URL, key and config, regenerate the
    /// key, open its journal, deploy, and refresh the secrets it asked for.
    func test_mcpConnectCopyRotateJournalDeploy() throws {
        let app = launch(tab: "apps")
        openBuildChooser(app)
        app.buttons["build-src-mcp"].tap()
        let create = app.buttons["build-mcp-create"]
        XCTAssertTrue(create.waitForExistence(timeout: 15))
        create.tap()
        expectProbe(app, "mcp created")
        let copies = app.buttons.matching(NSPredicate(format: "label == %@", "Copy"))
        XCTAssertTrue(copies.firstMatch.waitForExistence(timeout: 15))
        copies.element(boundBy: 0).tap()
        XCTAssertTrue(app.staticTexts["URL copied"].waitForExistence(timeout: 5))
        copies.element(boundBy: 1).tap()
        XCTAssertTrue(app.staticTexts["Key copied"].waitForExistence(timeout: 5))
        app.buttons["build-mcp-copy-config"].tap()
        XCTAssertTrue(app.staticTexts["Config copied"].waitForExistence(timeout: 5))
        app.buttons["build-mcp-rotate"].tap()
        expectProbe(app, "mcp rotated")
        shot(app, "mcp-connected")

        let journal = app.buttons["View journal"]
        XCTAssertTrue(reveal(app, journal))
        journal.tap()
        XCTAssertTrue(app.staticTexts["Build timeline"].waitForExistence(timeout: 15))
        app.navBackButton(in: "Build sessions").tap()
        XCTAssertTrue(app.navigationBars["Connect IDE"].waitForExistence(timeout: 10))

        let deploy = app.buttons["build-mcp-deploy"]
        XCTAssertTrue(reveal(app, deploy))
        deploy.tap()
        expectProbe(app, "deployed build")
        XCTAssertTrue(app.links.matching(NSPredicate(format: "label CONTAINS 'imported-app.'")).firstMatch
            .waitForExistence(timeout: 10), "Deploy shows the live address.")
        let refresh = app.buttons["Refresh"]
        if reveal(app, refresh) {
            refresh.tap()
            XCTAssertTrue(app.staticTexts["Your IDE asked for these secrets"].exists)
        }
    }
}
