import XCTest
import CryptoKit

/// GYM iOS mock tier for voi.ci pages and Messages (docs/voici-and-messages.md, release 0.3 H11): the Messages tab,
/// a thread with reply, rename, block and report, the page editor on an admin and a non-admin device, an admin device
/// publishing another device's draft, and "Sign in with Flagship" approval. The mock `.com` signs and seals for real.
/// Seams: GymSweepSeams+Messages.swift.
final class GymMessagesTests: GymSweepCase {

    private func openMessages(_ extra: [String], admin: Bool = true) -> XCUIApplication {
        let app = launch(tab: "messages", admin: admin, extra)
        XCTAssertTrue(any(app, "messages-your-page").waitForExistence(timeout: 20), "The Messages tab shows the page row.")
        return app
    }

    private func rows(_ app: XCUIApplication) -> XCUIElementQuery {
        app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'messages-row-'"))
    }

    private func requestsSegment(_ app: XCUIApplication) -> XCUIElement {
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Requests'")).firstMatch
    }

    private func openFirstRequest(_ app: XCUIApplication) {
        let seg = requestsSegment(app)
        XCTAssertTrue(seg.waitForExistence(timeout: 15))
        seg.tap()
        let row = rows(app).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 15), "The request is listed.")
        row.tap()
        XCTAssertTrue(any(app, "thread-compose").waitForExistence(timeout: 10))
    }

    private func menu(_ app: XCUIApplication, _ item: String) {
        let m = any(app, "thread-menu")
        XCTAssertTrue(m.waitForExistence(timeout: 10))
        m.tap()
        let b = app.buttons[item].firstMatch
        XCTAssertTrue(b.waitForExistence(timeout: 5), "\(item) is in the menu.")
        b.tap()
    }

    // MARK: - The tab

    func test_tabListsAnsweredConversationsAndRequests() throws {
        let app = openMessages(["-smoke-messages"])
        wait(any(app, "messages-page-status"), "label == 'Published'", timeout: 20)
        XCTAssertTrue(rows(app).firstMatch.waitForExistence(timeout: 20), "The answered conversation is under Messages.")
        XCTAssertEqual(rows(app).count, 1)
        XCTAssertTrue(requestsSegment(app).label.contains("1"), "One request waits: \(requestsSegment(app).label)")
        requestsSegment(app).tap()
        XCTAssertTrue(rows(app).firstMatch.waitForExistence(timeout: 10))
        XCTAssertTrue(rows(app).firstMatch.identifier.hasPrefix("messages-row-Visitor "), "A visitor shows by the generated name.")
        shot(app, "messages-requests")
    }

    func test_emptyAccountInvitesToTurnOnMessages() throws {
        let app = openMessages(["-smoke-messages-empty"])
        let empty = any(app, "messages-empty")
        XCTAssertTrue(empty.waitForExistence(timeout: 15))
        XCTAssertTrue(empty.label.contains("Accept messages"))
        wait(any(app, "messages-page-status"), "label == 'No page yet'", timeout: 15)
    }

    // MARK: - A thread

    func test_replyingAcceptsTheRequest() throws {
        let app = openMessages(["-smoke-messages"])
        openFirstRequest(app)
        XCTAssertEqual(app.descendants(matching: .any).matching(identifier: "bubble-visitor").count, 1)
        let field = any(app, "thread-compose")
        field.tap()
        field.typeText("Yes, which size?")
        any(app, "thread-send").tap()
        XCTAssertTrue(any(app, "bubble-owner").waitForExistence(timeout: 15), "The reply shows as the owner's bubble.")
        wait(any(app, "thread-receipt"), "label == 'Sent'", timeout: 10)
        shot(app, "messages-replied")
        app.navigationBars.buttons.firstMatch.tap()
        // Answered: it left Requests.
        XCTAssertTrue(any(app, "messages-empty").waitForExistence(timeout: 10), "Requests is empty after the reply.")
    }

    func test_renameShowsTheNickname() throws {
        let app = openMessages(["-smoke-messages"])
        XCTAssertTrue(rows(app).firstMatch.waitForExistence(timeout: 20))
        rows(app).firstMatch.tap()
        menu(app, "Rename")
        let field = app.alerts.textFields.firstMatch
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        field.typeText("Garden friend")
        app.alerts.buttons["Save"].tap()
        XCTAssertTrue(app.navigationBars["Garden friend"].waitForExistence(timeout: 10), "The thread is titled with the nickname.")
        app.navigationBars.buttons.firstMatch.tap()
        XCTAssertTrue(any(app, "messages-row-Garden friend").waitForExistence(timeout: 10), "The list shows the nickname.")
    }

    func test_blockHidesTheConversation() throws {
        let app = openMessages(["-smoke-messages"])
        openFirstRequest(app)
        menu(app, "Block")
        let confirm = app.buttons.matching(NSPredicate(format: "label == 'Block'")).element(boundBy: 0)
        XCTAssertTrue(confirm.waitForExistence(timeout: 5))
        confirm.tap()
        XCTAssertTrue(text(app, containing: "You blocked this visitor").waitForExistence(timeout: 10))
        app.navigationBars.buttons.firstMatch.tap()
        XCTAssertTrue(any(app, "messages-empty").waitForExistence(timeout: 10), "A blocked visitor's request is gone.")
    }

    func test_reportSendsTheMessage() throws {
        let app = openMessages(["-smoke-messages"])
        openFirstRequest(app)
        menu(app, "Report")
        let send = any(app, "report-send")
        XCTAssertTrue(send.waitForExistence(timeout: 5))
        send.tap()
        XCTAssertTrue(app.alerts["Reported"].waitForExistence(timeout: 10))
        app.alerts.buttons["OK"].tap()
    }

    func test_aLinkAsksBeforeLeavingTheApp() throws {
        let app = openMessages(["-smoke-messages"])
        XCTAssertTrue(rows(app).firstMatch.waitForExistence(timeout: 20))
        rows(app).firstMatch.tap()
        let link = app.links.matching(NSPredicate(format: "label CONTAINS 'example.org'")).firstMatch
        XCTAssertTrue(link.waitForExistence(timeout: 10), "The https link is tappable.")
        link.tap()
        let alert = app.alerts["Open example.org?"]
        XCTAssertTrue(alert.waitForExistence(timeout: 5), "A tap asks first, naming the host.")
        XCTAssertTrue(alert.staticTexts["https://example.org/garden"].exists, "The full address is shown.")
        alert.buttons["Cancel"].tap()
    }

    // MARK: - The page

    func test_adminPublishesTheFirstPageAfterTheWarning() throws {
        let app = openMessages(["-smoke-messages-empty"])
        any(app, "messages-your-page").tap()
        XCTAssertTrue(any(app, "page-warning").waitForExistence(timeout: 10), "The warning sits above the profile.")
        let name = app.textFields["page-display-name"].firstMatch
        XCTAssertTrue(name.waitForExistence(timeout: 5))
        replaceText(name, with: "Bright Maple")
        dismissKeyboard(app)
        let publish = any(app, "page-publish")
        XCTAssertTrue(reveal(app, publish))
        publish.tap()
        let agree = any(app, "rules-agree")
        XCTAssertTrue(agree.waitForExistence(timeout: 5), "The rules come before the first publish.")
        agree.tap()
        let alert = app.alerts["Publish your page?"]
        XCTAssertTrue(alert.waitForExistence(timeout: 5), "The first publish asks with the warning.")
        alert.buttons["Publish"].tap()
        XCTAssertTrue(app.buttons["Copy link"].waitForExistence(timeout: 20), "Published: the link can be copied.")
        shot(app, "page-published")
    }

    func test_nonAdminPostWaitsForAnAdminDevice() throws {
        let app = openMessages(["-smoke-messages"], admin: false)
        any(app, "messages-your-page").tap()
        let post = app.textFields["page-new-post"].firstMatch
        XCTAssertTrue(reveal(app, post))
        post.tap()
        post.typeText("Written on this phone.")
        any(app, "page-add-post").tap()
        let pending = any(app, "page-post-pending")
        XCTAssertTrue(pending.waitForExistence(timeout: 15), "The new post is grayed.")
        XCTAssertTrue(text(app, containing: "Waiting for an admin device to publish").waitForExistence(timeout: 5))
        XCTAssertFalse(any(app, "page-publish").exists, "Only an admin device has Publish.")
        shot(app, "page-waiting-for-admin")
    }

    func test_adminPublishesAnotherDevicesDraft() throws {
        let app = openMessages(["-smoke-messages", "-smoke-messages-lane"])
        wait(any(app, "messages-page-status"), "label == 'Published'", timeout: 30)
        any(app, "messages-your-page").tap()
        let written = text(app, containing: "Written on my iPad.")
        XCTAssertTrue(reveal(app, written), "The other device's post is on the page.")
        XCTAssertFalse(any(app, "page-post-pending").exists, "It is published, not grayed.")
    }

    // MARK: - Sign in with Flagship

    private func signInURL() -> URL {
        func b64u(_ d: Data) -> String {
            d.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
        }
        let sid = b64u(Data((0..<16).map { _ in UInt8.random(in: 0...255) }))
        let k = b64u(Curve25519.KeyAgreement.PrivateKey().publicKey.rawRepresentation)
        let d = P256.Signing.PrivateKey().publicKey.x963Representation.map { String(format: "%02x", $0) }.joined()
        let n = (0..<16).map { _ in String(format: "%02x", UInt8.random(in: 0...255)) }.joined()
        return URL(string: "flagship://voici-sign-in?s=\(sid)&k=\(k)&p=\(String(repeating: "07", count: 16))&u=river-otter&d=\(d)&n=\(n)")!
    }

    func test_signInApprovalThenSignOutInSettings() throws {
        let app = openMessages(["-smoke-voici-page"])
        app.open(signInURL())
        let title = any(app, "voici-signin-title")
        XCTAssertTrue(title.waitForExistence(timeout: 20))
        XCTAssertTrue(title.label.contains("River Otter"), "The page's verified name: \(title.label)")
        XCTAssertTrue(any(app, "voici-signin-code").waitForExistence(timeout: 10), "The 6-digit code shows.")
        XCTAssertTrue(text(app, containing: "They never see your username").exists)
        shot(app, "voici-sign-in")
        any(app, "voici-signin-approve").tap()
        let agree = any(app, "rules-agree")
        XCTAssertTrue(agree.waitForExistence(timeout: 5))
        agree.tap()
        XCTAssertTrue(any(app, "voici-signin-done").waitForExistence(timeout: 20), "Signed in.")
        app.buttons["Done"].tap()
        app.tabBars.buttons["Settings"].tap()
        let row = app.buttons.matching(NSPredicate(format: "label CONTAINS 'inbox key'")).firstMatch
        XCTAssertTrue(reveal(app, row))
        row.tap()
        let signOut = any(app, "messages-settings-sign-out")
        XCTAssertTrue(signOut.waitForExistence(timeout: 10), "The website is listed.")
        XCTAssertTrue(text(app, containing: "voi.ci/river-otter").exists)
        signOut.tap()
        XCTAssertTrue(any(app, "messages-settings-no-sites").waitForExistence(timeout: 10), "Signed out.")
    }

    func test_signInRefusalSaysWhy() throws {
        let app = openMessages(["-smoke-voici-page", "-smoke-voici-attest-limit"])
        app.open(signInURL())
        XCTAssertTrue(any(app, "voici-signin-approve").waitForExistence(timeout: 20))
        any(app, "voici-signin-approve").tap()
        let agree = any(app, "rules-agree")
        XCTAssertTrue(agree.waitForExistence(timeout: 5))
        agree.tap()
        let err = any(app, "voici-signin-error")
        XCTAssertTrue(err.waitForExistence(timeout: 15))
        XCTAssertTrue(err.label.contains("as many new conversations as you can today"), err.label)
    }

    // MARK: - Replies to this account on other pages

    func test_aReplyOnAnotherPageShowsANotice() throws {
        let app = openMessages(["-smoke-voici-page", "-smoke-voici-reply"])
        let notice = any(app, "messages-reply-notice")
        XCTAssertTrue(notice.waitForExistence(timeout: 30), "The owner's reply shows as a notice.")
        XCTAssertTrue(notice.label.contains("You have a reply on voi.ci/river-otter"), notice.label)
        XCTAssertFalse(text(app, containing: "Thank you!").exists, "The conversation itself stays on voi.ci.")
        shot(app, "messages-reply-notice")
    }
}
