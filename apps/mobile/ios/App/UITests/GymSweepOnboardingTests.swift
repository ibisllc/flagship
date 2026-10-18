import XCTest

/// GYM iOS button sweep (mock tier), onboarding and deep-link screens: see
/// GymSweepSupport.
///
/// Onboarding scenarios launch `-smoke-onboarding` (no keys left from an
/// earlier run, mock clients, an unpaired app on Welcome); the mock `.com`
/// holds three existing accounts (GymSweepSeams+Onboarding). Only
/// `test_createRegeneratesTheHandleAndBacksUpToAFile` creates an account:
/// real keys on the simulator, claimed on the mock `.com` only; the next
/// `-smoke-onboarding` launch wipes them. The demo join leaves a demo
/// session, which the same launch also drops.
///
/// Deep-link scenarios launch `-smoke-mode -smoke-visitor` and open the
/// `flagship://` form of each link (the https forms need a verified
/// associated domain the simulator lacks; both parse to the same link). The
/// mock box names the key each redeem / acceptance / knock was signed with,
/// and checks the signature, so the probe proves a visitor signs with its
/// id for that app (never the account id) and an owner's knock with this
/// device's account key.
final class GymSweepOnboardingTests: GymSweepCase {

    // MARK: - Helpers

    private func launchOnboarding(_ extra: [String] = []) -> XCUIApplication {
        let app = XCUIApplication()
        app.terminate()
        app.launchArguments = ["-smoke-onboarding"] + extra
        app.launch()
        XCTAssertTrue(app.buttons["Create your account"].waitForExistence(timeout: 20), "A fresh launch shows Welcome.")
        return app
    }

    /// A text field by its identifier (FSField puts the id on its field, or
    /// on a container holding it).
    private func field(_ app: XCUIApplication, _ id: String) -> XCUIElement {
        let direct = app.textFields[id]
        if direct.waitForExistence(timeout: 3) { return direct }
        let secure = app.secureTextFields[id]
        if secure.exists { return secure }
        return any(app, id).descendants(matching: .textField).firstMatch
    }

    private func clearAndType(_ el: XCUIElement, _ text: String) {
        el.tap()
        if let current = el.value as? String, !current.isEmpty, current != el.placeholderValue {
            el.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: current.count))
        }
        el.typeText(text)
    }

    /// Welcome → Connect to an existing account → type `name` → Continue.
    private func signIn(_ app: XCUIApplication, as name: String) {
        app.buttons["welcome-connect"].tap()
        let cont = app.buttons["connect-name-continue"]
        XCTAssertTrue(cont.waitForExistence(timeout: 10), "Join asks for the account name.")
        XCTAssertFalse(cont.isEnabled, "Nothing to look up yet.")
        let name0 = app.textFields.matching(identifier: "connect-name-field").firstMatch
        XCTAssertTrue(name0.waitForExistence(timeout: 5))
        name0.tap()
        name0.typeText(name)
        wait(cont, "isEnabled == true")
        cont.tap()
    }

    private func openLink(_ app: XCUIApplication, _ link: String) {
        guard let url = URL(string: link) else { return XCTFail("bad link \(link)") }
        app.open(url)
    }

    private let secret = String(repeating: "5e", count: 32)
    private let ownerAid = String(repeating: "7a", count: 32)
    private let inviteId = String(repeating: "c4", count: 16)
    private let friend = "home.trent.flagship.services"
    private let friendApp = "trent--scratchpad"

    private func inviteLink(appRef: String?) -> String {
        "flagship://invite?server=\(friend)&k=\(secret)&a=\(ownerAid)&i=\(inviteId)"
            + (appRef.map { "&s=\($0)" } ?? "")
    }

    /// The deep-link covers carry a Close button; Home's tab bar shows again
    /// once a cover is gone.
    private func waitCoverGone(_ app: XCUIApplication, title: String) {
        waitGone(app.navigationBars[title], timeout: 10)
    }

    // MARK: - Welcome → Join

    /// Connect to an existing account: a name with no account shows the inline
    /// "No Flagship account by that name" state, editing the name clears it,
    /// and Back returns to Welcome.
    func test_haveAnAccountUnknownNameThenBack() throws {
        let app = launchOnboarding()
        signIn(app, as: "nobody-here")
        let unknown = any(app, "join-unknown")
        XCTAssertTrue(unknown.waitForExistence(timeout: 10), "An unknown name is a state, not an error.")
        shot(app, "join-unknown")
        let name = app.textFields.firstMatch
        name.tap()
        name.typeText("x")
        waitGone(unknown)
        XCTAssertTrue(app.buttons["connect-name-continue"].isEnabled, "Editing re-arms Continue.")
        app.buttons["BackButton"].firstMatch.tap()
        XCTAssertTrue(app.buttons["Create your account"].waitForExistence(timeout: 10), "Back returns to Welcome.")
    }

    /// Typing the demo account's name opens its sandbox: the demo server on
    /// Home, and Add/Restore server (a demo account's device stands in for
    /// its owner).
    func test_joinTheDemoAccountOpensItsSandbox() throws {
        let app = launchOnboarding()
        signIn(app, as: "demo")
        XCTAssertTrue(podRow(app, named: "Home").waitForExistence(timeout: 20), "The demo server shows on Home.")
        XCTAssertTrue(app.buttons["home-add-server"].waitForExistence(timeout: 10),
                      "A demo account may add servers.")
        shot(app, "join-demo-home")
    }

    /// An account with a cloud backup on one device asks for the recovery
    /// passphrase (Restore stays off under 8 characters). With no backup on
    /// the mock `.com` the restore fails with a sentence, and Back returns
    /// to the name.
    func test_signInWithCloudBackupAsksForThePassphrase() throws {
        let app = launchOnboarding()
        signIn(app, as: "sole-maple")
        let pass = app.secureTextFields["login-recovery-passphrase"]
        XCTAssertTrue(pass.waitForExistence(timeout: 15), "A one-device account restores with its passphrase.")
        let restore = app.buttons["login-takeover-continue"]
        XCTAssertFalse(restore.isEnabled, "Restore waits for a passphrase.")
        pass.tap()
        pass.typeText("short")
        XCTAssertFalse(restore.isEnabled, "8 characters at least.")
        pass.typeText("-enough")
        wait(restore, "isEnabled == true")
        XCTAssertTrue(app.buttons["login-import-backup"].exists, "A backup file is offered too.")
        restore.tap()
        let err = app.staticTexts["login-takeover-error"]
        XCTAssertTrue(err.waitForExistence(timeout: 30), "With no backup on file the restore says why.")
        XCTAssertFalse(err.label.isEmpty)
        shot(app, "login-single-error")
        let back = button(app, "Back")
        XCTAssertTrue(reveal(app, back))
        back.tap()
        XCTAssertTrue(app.buttons["connect-name-continue"].waitForExistence(timeout: 10), "Back returns to the name.")
    }

    /// A multi-device account needs the passphrase AND a recovery or
    /// authenticator code, behind the 24-hour hold.
    func test_multiDeviceSignInNeedsPassphraseAndCode() throws {
        let app = launchOnboarding()
        signIn(app, as: "many-maple")
        XCTAssertTrue(any(app, "login-grace-24h").waitForExistence(timeout: 15), "The 24-hour hold is explained.")
        let restore = app.buttons["login-takeover-continue"]
        XCTAssertTrue(restore.exists)
        XCTAssertEqual(restore.label, "Restore access (24-hour hold)")
        XCTAssertFalse(restore.isEnabled, "Nothing entered yet.")
        let pass = app.secureTextFields["login-takeover-passphrase"]
        pass.tap()
        pass.typeText("long-enough-pass")
        XCTAssertFalse(restore.isEnabled, "The code is needed too.")
        let code = field(app, "login-second-factor")
        code.tap()
        code.typeText("123456")
        wait(restore, "isEnabled == true")
        shot(app, "login-multi-ready")
        app.buttons["BackButton"].firstMatch.tap()
        XCTAssertTrue(app.buttons["connect-name-continue"].waitForExistence(timeout: 10), "Back returns to the name.")
    }

    /// An account with no cloud backup says so (never a 404) and offers the
    /// backup file: the import sheet starts at picking the file (Import off
    /// until one is picked) and Cancel closes it.
    func test_noBackupAccountOffersTheBackupFile() throws {
        let app = launchOnboarding()
        signIn(app, as: "bare-maple")
        XCTAssertTrue(any(app, "login-no-recovery").waitForExistence(timeout: 15), "No cloud backup is a state.")
        let importRow = app.buttons["login-import-backup"]
        XCTAssertTrue(importRow.exists)
        importRow.tap()
        XCTAssertTrue(app.navigationBars["Import backup file"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["keyfile-import-choose"].exists, "It starts at choosing the file.")
        XCTAssertFalse(app.buttons["keyfile-import-continue"].isEnabled, "Import waits for a file.")
        XCTAssertFalse(any(app, "keyfile-import-passphrase").exists, "The passphrase follows the file.")
        shot(app, "keyfile-import")
        app.navigationBars["Import backup file"].buttons["Cancel"].tap()
        waitGone(app.navigationBars["Import backup file"])
        XCTAssertTrue(any(app, "login-no-recovery").exists, "Cancel returns to the sign-in state.")
    }

    // MARK: - Create

    /// Create your account: Try another changes the handle (after its
    /// cooldown); the account and device names are typed; Skip for now
    /// warns and Back keeps the step; Save a backup file opens the account
    /// backup sheet, and Done there lands on Home with Add/Restore server
    /// (the opener holds the admin root). Creates a real account on the
    /// simulator (mock `.com` only).
    func test_createRegeneratesTheHandleAndBacksUpToAFile() throws {
        let app = launchOnboarding()
        app.buttons["Create your account"].tap()
        let handle = app.staticTexts["suggest-username-name"]
        XCTAssertTrue(handle.waitForExistence(timeout: 10))
        let regen = app.buttons["suggest-regenerate"]
        wait(regen, "isEnabled == true", timeout: 10)
        let first = handle.label
        XCTAssertFalse(first.trimmingCharacters(in: .whitespaces).isEmpty, "A handle is suggested.")
        regen.tap()
        wait(handle, "label != '\(first)'")
        let second = handle.label
        XCTAssertNotEqual(second, first, "Try another hands a new handle.")
        let cont = button(app, "Continue")
        wait(cont, "isEnabled == true")
        cont.tap()

        let open = app.buttons["open-account-continue"]
        XCTAssertTrue(open.waitForExistence(timeout: 10))
        clearAndType(field(app, "open-account-account-name"), "Gym Family")
        clearAndType(field(app, "open-account-device-name"), "Gym iPhone")
        if app.keyboards.count > 0 { app.keyboards.buttons["Return"].firstMatch.tap() }
        wait(open, "isEnabled == true")
        open.tap()

        let skip = app.buttons["secure-account-skip"]
        XCTAssertTrue(skip.waitForExistence(timeout: 20), "A new account is offered a backup.")
        skip.tap()
        let skipAnyway = app.buttons.matching(identifier: "secure-account-skip-anyway").firstMatch
        XCTAssertTrue(skipAnyway.waitForExistence(timeout: 5), "Skipping warns first.")
        // The dialog's Back (cancel role) shows on some layouts only; tapping
        // away from the dialog cancels it the same way.
        let keep = app.buttons["Back"].firstMatch
        if keep.exists && keep.isHittable { keep.tap() } else {
            app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.08)).tap()
        }
        waitGone(skipAnyway)
        XCTAssertTrue(skip.waitForExistence(timeout: 5), "Back keeps the backup step.")

        let cloud = app.buttons["secure-account-option-cloud"]
        let file = app.buttons["secure-account-option-file"]
        XCTAssertTrue(cloud.exists && file.exists, "Cloud and file are both offered.")
        file.tap()
        let secureContinue = app.buttons["secure-account-continue"]
        wait(secureContinue, "isEnabled == true")
        secureContinue.tap()
        XCTAssertTrue(app.navigationBars["Account backup"].waitForExistence(timeout: 10), "The file backup opens.")
        XCTAssertFalse(app.buttons["keyfile-export-create"].isEnabled, "A file needs a passphrase first.")
        shot(app, "secure-account-file")
        app.navigationBars["Account backup"].buttons["Done"].tap()
        XCTAssertTrue(app.buttons["home-add-server"].waitForExistence(timeout: 15),
                      "The account opens on Home, where its admin device may add servers.")
    }

    /// Join an account by pairing, from the admin's link: the six-digit
    /// code shows with the name this device will use (Confirm off while
    /// empty). A pairing that doesn't match fails with a sentence after the
    /// code is confirmed, and Try again goes back to Welcome.
    func test_joinByPairingLinkFailsCleanly() throws {
        let app = launchOnboarding(["-smoke-join-bundle"])
        openLink(app, "flagship://join?sid=gym&pk=ERERERERERERERERERERERERERERERERERERERERERE")
        XCTAssertTrue(app.navigationBars["Join an account"].waitForExistence(timeout: 15), "The link opens Join.")
        let name = app.textFields["Name in this account"]
        XCTAssertTrue(name.waitForExistence(timeout: 15), "The code shows with this device's name.")
        let confirm = button(app, "Confirm name and join")
        XCTAssertTrue(confirm.isEnabled)
        clearAndType(name, "")
        XCTAssertFalse(confirm.isEnabled, "A name is needed.")
        name.typeText("Gym iPhone")
        wait(confirm, "isEnabled == true")
        shot(app, "join-pairing-code")
        confirm.tap()
        XCTAssertTrue(app.staticTexts["Couldn't join"].waitForExistence(timeout: 15))
        XCTAssertTrue(text(app, containing: "the codes may not have matched").exists, "It says why.")
        button(app, "Try again").tap()
        XCTAssertTrue(app.buttons["Create your account"].waitForExistence(timeout: 10), "Try again returns to Welcome.")
    }

    /// Without a live pairing transport (every release build) Join says so and
    /// points at the web app instead of waiting for a peer that can never come.
    func test_joinByPairingLinkWithoutATransportSaysSo() throws {
        let app = launchOnboarding(["-smoke-pairing-unavailable"])
        openLink(app, "flagship://join?sid=gym&pk=ERERERERERERERERERERERERERERERERERERERERERE")
        XCTAssertTrue(app.navigationBars["Join an account"].waitForExistence(timeout: 15))
        let failed = app.staticTexts["Couldn't join"].waitForExistence(timeout: 15)
        if !failed { print("DEBUGTREE", app.debugDescription) }
        XCTAssertTrue(failed)
        XCTAssertTrue(text(app, containing: "Joining an account from this phone isn't available yet. Use the web app.").exists)
        shot(app, "join-unavailable")
    }

    // MARK: - Deep links: invite, approval, knock

    /// An app invite (`/invite`, here its flagship:// form): Accept signs the
    /// redeem with this account's id for that app, never the account id; the
    /// box answers You're in and Open it closes the screen. A knock on that
    /// friend's box then signs with the same per-app id.
    func test_inviteRedeemSignsWithThePerAppId() throws {
        let app = launch(tab: "home", ["-smoke-visitor"])
        XCTAssertTrue(app.buttons["home-add-server"].waitForExistence(timeout: 20))
        openLink(app, inviteLink(appRef: friendApp))
        let accept = app.buttons["invite-redeem-accept"]
        XCTAssertTrue(accept.waitForExistence(timeout: 15), "The invite link opens Accept invite.")
        XCTAssertTrue(text(app, containing: friend).exists, "It names the server.")
        shot(app, "invite-redeem")
        accept.tap()
        let open = app.buttons["invite-redeem-open"]
        XCTAssertTrue(open.waitForExistence(timeout: 15), "The box confirms the access.")
        expectProbe(app, "redeem on \(friend) by the per-app id for \(friendApp)")
        expectNoProbe(app, "by the account id")
        XCTAssertTrue(app.buttons["invite-redeem-home"].exists, "Go to Flagship is offered too.")
        open.tap()
        waitCoverGone(app, title: "Accept invite")

        openLink(app, "flagship://access?server=\(friend)&svc=scratchpad&ref=\(friendApp)&page=gym-page-1")
        let title = app.staticTexts["knock-authorize-title"]
        XCTAssertTrue(title.waitForExistence(timeout: 15), "The knock link opens Open app.")
        XCTAssertEqual(title.label, "Open scratchpad on home?")
        app.buttons["knock-authorize-btn"].tap()
        let done = app.buttons["knock-authorize-done"]
        XCTAssertTrue(done.waitForExistence(timeout: 15),
                      "The browser is signed in. Error: \(app.staticTexts["knock-authorize-error"].exists ? app.staticTexts["knock-authorize-error"].label : "none"); mocks saw: \(probe(app))")
        expectProbe(app, "knock on \(friend) by the per-app id for \(friendApp)")
        done.tap()
        waitCoverGone(app, title: "Open app")
    }

    /// A members-only invite that needs the owner's approval: the redeem
    /// shows the reply to send back (signed with the per-app id) and Done
    /// closes it. The owner opening that reply (`/invite-accept`) approves:
    /// the box binds the per-app id the reply names, and Done closes.
    func test_manualInviteReplyIsApprovedByTheOwner() throws {
        let app = launch(tab: "home", ["-smoke-visitor", "-smoke-invite-manual"])
        XCTAssertTrue(app.buttons["home-add-server"].waitForExistence(timeout: 20))
        openLink(app, inviteLink(appRef: friendApp))
        let accept = app.buttons["invite-redeem-accept"]
        XCTAssertTrue(accept.waitForExistence(timeout: 15))
        accept.tap()
        XCTAssertTrue(any(app, "invite-redeem-pending").waitForExistence(timeout: 15), "The owner must approve.")
        expectProbe(app, "redeem on \(friend) by the per-app id for \(friendApp)")
        let reply = text(app, containing: "/invite-accept#")
        XCTAssertTrue(reveal(app, reply), "The reply link is shown to send back.")
        XCTAssertTrue(reveal(app, any(app, "invite-redeem-reply-copy-btn")), "It can be copied.")
        let replyLink = reply.label
        XCTAssertTrue(replyLink.contains("/invite-accept#"), "Got: \(replyLink)")
        shot(app, "invite-redeem-pending")
        let done = app.buttons["invite-redeem-pending-done"]
        XCTAssertTrue(reveal(app, done))
        done.tap()
        waitCoverGone(app, title: "Accept invite")

        guard let hash = replyLink.range(of: "#") else { return XCTFail("No fragment in \(replyLink)") }
        openLink(app, "flagship://invite-accept?" + replyLink[hash.upperBound...])
        let approve = app.buttons["invite-accept-approve"]
        XCTAssertTrue(approve.waitForExistence(timeout: 15), "The reply opens Approve access.")
        XCTAssertTrue(text(app, containing: friendApp).exists, "It names the app.")
        approve.tap()
        let ok = app.buttons["invite-accept-done"]
        XCTAssertTrue(ok.waitForExistence(timeout: 15), "The box binds the person.")
        expectProbe(app, "accept on \(friend) by the per-app id for \(friendApp)")
        ok.tap()
        waitCoverGone(app, title: "Approve access")
    }

    /// A link made before per-app ids (no `s=`) is refused before anything
    /// is signed or sent, and Close dismisses it.
    func test_oldInviteLinkWithoutAppIsRefused() throws {
        let app = launch(tab: "home", ["-smoke-visitor"])
        XCTAssertTrue(app.buttons["home-add-server"].waitForExistence(timeout: 20))
        openLink(app, inviteLink(appRef: nil))
        let accept = app.buttons["invite-redeem-accept"]
        XCTAssertTrue(accept.waitForExistence(timeout: 15))
        accept.tap()
        let err = app.staticTexts["invite-redeem-error"]
        XCTAssertTrue(err.waitForExistence(timeout: 10))
        XCTAssertEqual(err.label, "This invite link is from an older version of Flagship. Ask the owner for a new link.")
        expectNoProbe(app, "redeem on")
        app.navigationBars["Accept invite"].buttons["Close"].tap()
        waitCoverGone(app, title: "Accept invite")
    }

    /// A knock on one of the account's own servers signs with this device's
    /// account key; one on a server it has no tie to is refused before
    /// anything is sent, and Cancel closes it.
    func test_knockOwnServerSignsWithThisDevicesKey() throws {
        let app = launch(tab: "home", ["-smoke-visitor"])
        XCTAssertTrue(app.buttons["home-add-server"].waitForExistence(timeout: 20))
        let own = "home.bright-maple.flagship.services"
        openLink(app, "flagship://access?server=\(own)&svc=plants&ref=bright-maple--plants&page=gym-page-2")
        XCTAssertTrue(app.staticTexts["knock-authorize-title"].waitForExistence(timeout: 15))
        XCTAssertEqual(app.staticTexts["knock-authorize-site"].label, "plants.\(own)")
        app.buttons["knock-authorize-btn"].tap()
        let done = app.buttons["knock-authorize-done"]
        XCTAssertTrue(done.waitForExistence(timeout: 15))
        expectProbe(app, "knock on \(own) by this device's account key")
        done.tap()
        waitCoverGone(app, title: "Open app")

        let stranger = "home.stranger.flagship.services"
        openLink(app, "flagship://access?server=\(stranger)&svc=notes&ref=stranger--notes&page=gym-page-3")
        let open = app.buttons["knock-authorize-btn"]
        XCTAssertTrue(open.waitForExistence(timeout: 15))
        open.tap()
        let err = app.staticTexts["knock-authorize-error"]
        XCTAssertTrue(err.waitForExistence(timeout: 15))
        XCTAssertEqual(err.label, "This isn't one of your servers. Open its invite link on this phone first, then try again.")
        expectNoProbe(app, "knock on \(stranger)")
        shot(app, "knock-not-yours")
        app.buttons["knock-authorize-cancel"].tap()
        waitCoverGone(app, title: "Open app")
    }
}
