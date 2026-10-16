import XCTest

/// GYM iOS button sweep (mock tier), Home + Activity + the shell: see
/// GymSweepSupport. Every control is reached from its tab and pressed; the
/// effect is checked on screen and, for orders, in what the mocks received.
final class GymSweepHomeTests: GymSweepCase {

    // MARK: helpers

    /// Long-press a Home row and wait for its context menu.
    private func openMenu(_ app: XCUIApplication, on name: String, file: StaticString = #filePath, line: UInt = #line) {
        let row = podRow(app, named: name)
        XCTAssertTrue(reveal(app, row), "\(name) should be on Home.", file: file, line: line)
        row.press(forDuration: 1.2)
        XCTAssertTrue(button(app, "Open").waitForExistence(timeout: 10), "The context menu should open.", file: file, line: line)
    }

    /// Close an open context menu without choosing anything.
    private func closeMenu(_ app: XCUIApplication) {
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.15)).tap()
        waitGone(button(app, "Open"))
    }

    /// `a` is drawn above `b` on Home.
    private func isAbove(_ a: XCUIElement, _ b: XCUIElement) -> Bool {
        a.exists && b.exists && a.frame.minY < b.frame.minY
    }

    private func count(_ needle: String, in haystack: String) -> Int {
        haystack.components(separatedBy: needle).count - 1
    }

    /// Pull the screen's list down far enough to refresh it.
    private func pullToRefresh(_ app: XCUIApplication) {
        let start = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.3))
        start.press(forDuration: 0.1, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.9)))
    }

    // MARK: Add/Import a server

    /// The menu's other choices: Cancel does nothing, Co-manage opens the
    /// accept-a-share screen, Import opens the restore flow.
    func test_addImportMenuCancelCoManageAndImport() throws {
        let app = launch()
        let add = app.buttons["home-add-server"]
        XCTAssertTrue(add.waitForExistence(timeout: 20))
        add.tap()
        let coManage = app.buttons.matching(identifier: "home-co-manage").firstMatch
        XCTAssertTrue(coManage.waitForExistence(timeout: 10), "The menu offers Co-manage a running server.")
        shot(app, "add-import-menu")
        // The menu's Cancel is a tap outside it.
        let cancel = button(app, "Cancel")
        if cancel.exists { cancel.tap() } else { app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.12)).tap() }
        waitGone(app.buttons.matching(identifier: "home-add-new-server").firstMatch)
        XCTAssertTrue(add.isHittable, "Cancel leaves Home as it was.")

        add.tap()
        app.buttons.matching(identifier: "home-co-manage").firstMatch.tap()
        XCTAssertTrue(any(app, "share-accept-paste").waitForExistence(timeout: 10),
                      "Co-manage a running server opens the accept-a-share screen.")
        XCTAssertTrue(app.buttons["share-accept-scan"].exists)
        XCTAssertFalse(app.buttons["share-accept-open"].isEnabled, "Open waits for a link.")
        shot(app, "co-manage")
        app.navigationBars.descendants(matching: .any).matching(identifier: "BackButton").firstMatch.tap()

        XCTAssertTrue(add.waitForExistence(timeout: 10))
        add.tap()
        app.buttons.matching(identifier: "home-import-backup").firstMatch.tap()
        XCTAssertTrue(app.buttons["import-backup-choose"].waitForExistence(timeout: 10),
                      "Import a backup starts by picking the files.")
    }

    // MARK: Filters and search

    func test_filterChipsAndSearchNarrowTheList() throws {
        let app = launch()
        let home = podRow(app, named: "Home"), office = podRow(app, named: "Office"), music = podRow(app, named: "Music")
        XCTAssertTrue(home.waitForExistence(timeout: 20))
        XCTAssertTrue(office.exists && music.exists)

        any(app, "fs-chip-offline").tap()
        waitGone(home)
        XCTAssertTrue(music.exists, "Offline keeps Music.")
        XCTAssertFalse(office.exists)
        shot(app, "filter-offline")

        any(app, "fs-chip-online").tap()
        XCTAssertTrue(home.waitForExistence(timeout: 5) && office.exists)
        XCTAssertFalse(music.exists, "Online drops Music.")

        any(app, "fs-chip-pending").tap()
        XCTAssertTrue(text(app, containing: "No servers match").waitForExistence(timeout: 5),
                      "No server is pending, and Home says so.")

        any(app, "fs-chip-all").tap()
        XCTAssertTrue(music.waitForExistence(timeout: 5) && home.exists && office.exists)

        let search = app.searchFields.firstMatch
        if !search.exists { app.swipeDown() }
        XCTAssertTrue(search.waitForExistence(timeout: 5), "Home has a search field.")
        search.tap()
        search.typeText("office")
        waitGone(home)
        XCTAssertTrue(office.exists, "Search keeps the server it names.")
        shot(app, "search-office")
    }

    // MARK: Server order

    /// Long-press → Make leader: the admin device signs the order with the
    /// admin root (the mock `.com` and boxes verify it) and Office moves up.
    func test_contextMenuMakeLeaderSignsWithTheAdminRoot() throws {
        let app = launch(admin: true, ["-smoke-pod-keys"])
        openMenu(app, on: "Office")
        XCTAssertTrue(button(app, "Delete server…").exists)
        shot(app, "context-menu")
        button(app, "Make leader").tap()
        expectProbe(app, "signed server-order by admin-root")
        let office = podRow(app, named: "Office"), home = podRow(app, named: "Home")
        let moved = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in self.isAbove(office, home) }, object: nil)
        XCTAssertEqual(XCTWaiter().wait(for: [moved], timeout: 10), .completed, "Office now leads the list.")
        XCTAssertTrue(office.label.contains("Leader"), "Office carries the Leader badge; got \(office.label)")
        expectNoProbe(app, "refused")
    }

    /// Dragging a row by its handle reorders the list and signs the order.
    func test_dragHandleReordersAndSigns() throws {
        let app = launch(admin: true, ["-smoke-pod-keys"])
        let office = podRow(app, named: "Office"), home = podRow(app, named: "Home")
        XCTAssertTrue(office.waitForExistence(timeout: 20) && home.exists)
        XCTAssertTrue(isAbove(home, office))
        // The handle sits left of the row's button and is hidden from
        // accessibility, so it is grabbed by coordinates.
        let grab = office.coordinate(withNormalizedOffset: CGVector(dx: 0, dy: 0.5)).withOffset(CGVector(dx: -22, dy: 0))
        let drop = home.coordinate(withNormalizedOffset: CGVector(dx: 0, dy: 0)).withOffset(CGVector(dx: -22, dy: -8))
        grab.press(forDuration: 0.5, thenDragTo: drop)
        expectProbe(app, "signed server-order by admin-root")
        let moved = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in self.isAbove(office, home) }, object: nil)
        XCTAssertEqual(XCTWaiter().wait(for: [moved], timeout: 10), .completed, "The dragged server moved up.")
        shot(app, "dragged")
    }

    /// A device without the admin root isn't offered the orders `.com` would
    /// refuse from it: no Make leader, no Delete or Cancel in the menu, no
    /// drag handle, and the pending page says why it can't cancel.
    func test_nonAdminDeviceIsNotOfferedServerOrders() throws {
        let app = launch(admin: false, ["-smoke-pod-keys", "-smoke-pending-pod"])
        XCTAssertFalse(app.buttons["home-add-server"].waitForExistence(timeout: 10), "No Add/Import a server.")
        XCTAssertTrue(app.staticTexts["home-servers-admin-only"].waitForExistence(timeout: 10),
                      "Home says the servers are read-only on this device.")
        openMenu(app, on: "Office")
        XCTAssertFalse(button(app, "Make leader").exists, "No Make leader on a non-admin device.")
        XCTAssertFalse(button(app, "Delete server…").exists)
        shot(app, "non-admin-menu")
        closeMenu(app)

        openMenu(app, on: "Shed")
        XCTAssertFalse(button(app, "Cancel server").exists, "No Cancel server on a non-admin device.")
        button(app, "Open").tap()
        XCTAssertTrue(app.navigationBars["Pending"].waitForExistence(timeout: 10))
        let refusal = app.staticTexts["pending-cancel-admin-only"]
        XCTAssertTrue(refusal.waitForExistence(timeout: 10))
        XCTAssertEqual(refusal.label, "Only an admin device can change this server. This device can see it.")
        XCTAssertFalse(app.buttons["pending-cancel-order-button"].exists)
        expectNoProbe(app, "refused")
    }

    /// A demo account (no keys; the operator runs it): Add/Import shows and
    /// Make leader keeps the order on the device, signing nothing.
    func test_demoAccountKeepsTheOrderOnTheDevice() throws {
        let app = launch(admin: false, ["-smoke-demo-account", "-smoke-pod-keys"])
        XCTAssertTrue(app.buttons["home-add-server"].waitForExistence(timeout: 20), "A demo account adds servers.")
        XCTAssertFalse(any(app, "recovery-backup-banner").exists, "A demo account has nothing to back up.")
        openMenu(app, on: "Office")
        button(app, "Make leader").tap()
        let office = podRow(app, named: "Office"), home = podRow(app, named: "Home")
        let moved = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in self.isAbove(office, home) }, object: nil)
        XCTAssertEqual(XCTWaiter().wait(for: [moved], timeout: 10), .completed)
        expectNoProbe(app, "server-order")
        shot(app, "demo-make-leader")
    }

    // MARK: Send the backup

    /// A server waiting for its backup: an admin device sends it from the
    /// menu; another device only opens the server.
    func test_sendTheBackupOnlyFromAnAdminDevice() throws {
        var app = launch(admin: true, ["-smoke-awaiting-backup"])
        openMenu(app, on: "Home")
        button(app, "Send the backup").tap()
        XCTAssertTrue(app.buttons["import-backup-choose"].waitForExistence(timeout: 10), "Send the backup opens the send flow.")

        app = launch(admin: false, ["-smoke-awaiting-backup"])
        openMenu(app, on: "Home")
        XCTAssertFalse(button(app, "Send the backup").exists, "Not offered on a non-admin device.")
        button(app, "Open").tap()
        XCTAssertTrue(app.serverPageBackButton(named: "Home").waitForExistence(timeout: 15), "It opens the server page instead.")
        XCTAssertFalse(app.buttons["import-backup-choose"].exists)
    }

    // MARK: Context menu: Open, Delete

    func test_contextMenuOpensAndDeletesAfterTypedName() throws {
        let app = launch(admin: true, ["-smoke-pod-keys"])
        openMenu(app, on: "Office")
        button(app, "Open").tap()
        XCTAssertTrue(app.serverPageBackButton(named: "Office").waitForExistence(timeout: 15), "Open shows the server page.")
        app.serverPageBackButton(named: "Office").tap()

        openMenu(app, on: "Music")
        button(app, "Delete server…").tap()
        let field = any(app, "delete-server-name-field")
        XCTAssertTrue(field.waitForExistence(timeout: 10), "Delete asks for the server's name first.")
        let confirm = app.buttons["delete-server-confirm"]
        XCTAssertFalse(confirm.isEnabled, "Delete waits for the name.")
        let input = app.textFields.matching(NSPredicate(format: "placeholderValue == %@", "music")).firstMatch
        let target = input.exists ? input : app.textFields.firstMatch
        target.tap()
        target.typeText("musi")
        XCTAssertFalse(confirm.isEnabled, "A wrong name doesn't arm it.")
        shot(app, "delete-typed-wrong")
        app.buttons.matching(NSPredicate(format: "label == %@", "Cancel")).firstMatch.tap()
        waitGone(confirm)
        expectNoProbe(app, "release-server-name")

        openMenu(app, on: "Music")
        button(app, "Delete server…").tap()
        XCTAssertTrue(confirm.waitForExistence(timeout: 10))
        let again = app.textFields.firstMatch
        again.tap()
        again.typeText("music")
        wait(confirm, "isEnabled == true")
        confirm.tap()
        expectProbe(app, "signed server-decommission by admin-root")
        expectProbe(app, "signed release-server-name by admin-root")
        waitGone(confirm, timeout: 15)
    }

    // MARK: Pending server

    func test_pendingServerCancelFromMenuAndPage() throws {
        var app = launch(admin: true, ["-smoke-pending-pod"])
        openMenu(app, on: "Shed")
        XCTAssertFalse(button(app, "Make leader").exists, "A pending server can't lead.")
        button(app, "Cancel server").tap()
        expectProbe(app, "signed release-server-name by admin-root")
        waitGone(podRow(app, named: "Shed"), timeout: 15)

        app = launch(admin: true, ["-smoke-pending-pod"])
        let row = podRow(app, named: "Shed")
        XCTAssertTrue(reveal(app, row))
        row.tap()
        XCTAssertTrue(app.navigationBars["Pending"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.links["How to flash + boot"].exists || app.buttons["How to flash + boot"].exists,
                      "The pending page links the flashing guide.")
        let cancel = app.buttons["pending-cancel-order-button"]
        XCTAssertTrue(reveal(app, cancel))
        shot(app, "pending-page")
        cancel.tap()
        expectProbe(app, "signed release-server-name by admin-root")
        XCTAssertTrue(app.buttons["home-add-server"].waitForExistence(timeout: 15), "Cancelling returns to Home.")
        waitGone(podRow(app, named: "Shed"))
    }

    // MARK: Status paused / locked list

    func test_statusPausedUnlockReadsAgain() throws {
        let app = launch(admin: true, ["-smoke-status-paused"])
        let paused = any(app, "status-paused")
        XCTAssertTrue(paused.waitForExistence(timeout: 20), "Home says status is paused.")
        app.buttons["status-paused-unlock"].tap()
        waitGone(paused, timeout: 15)
        shot(app, "status-resumed")
    }

    /// When the read still fails the warning toast says so, and a tap on the
    /// toast dismisses it before it times out.
    func test_statusPausedUnlockFailingWarnsAndToastDismissesOnTap() throws {
        let app = launch(admin: true, ["-smoke-status-paused", "-smoke-unlock-fails"])
        XCTAssertTrue(any(app, "status-paused").waitForExistence(timeout: 20))
        app.buttons["status-paused-unlock"].tap()
        let toast = text(app, containing: "Couldn't load your servers")
        XCTAssertTrue(toast.waitForExistence(timeout: 15), "A read that still fails warns.")
        let shown = Date()
        toast.tap()
        waitGone(toast, timeout: 3)
        XCTAssertLessThan(Date().timeIntervalSince(shown), 3.5, "The tap dismissed it, not its 4 s timer.")
    }

    func test_lockedListShowsMyServers() throws {
        let app = launch(admin: true, ["-smoke-list-locked"])
        XCTAssertTrue(any(app, "home-locked-state").waitForExistence(timeout: 20), "Home says the list is locked.")
        XCTAssertFalse(podRow(app, named: "Home").exists)
        shot(app, "list-locked")
        app.buttons["home-show-my-servers"].tap()
        XCTAssertTrue(podRow(app, named: "Home").waitForExistence(timeout: 15), "Show my servers lists them.")
        XCTAssertFalse(any(app, "home-locked-state").exists)
    }

    func test_pullToRefreshReadsTheServerListAgain() throws {
        let app = launch()
        XCTAssertTrue(podRow(app, named: "Home").waitForExistence(timeout: 20))
        expectProbe(app, "read pods")
        let before = count("read pods", in: probe(app))
        pullToRefresh(app)
        let more = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            self.count("read pods", in: self.probe(app)) > before
        }, object: nil)
        XCTAssertEqual(XCTWaiter().wait(for: [more], timeout: 15), .completed, "Pulling down reads /pods again.")
    }

    // MARK: Announcements

    func test_accountResetBannerSignsInAgain() throws {
        let app = launch(admin: true, ["-smoke-account-reset"])
        let banner = any(app, "account-reset-banner")
        XCTAssertTrue(banner.waitForExistence(timeout: 20))
        XCTAssertTrue(text(app, containing: "This device was removed from your account").exists)
        shot(app, "account-reset")
        app.buttons["fs-announcement-cta"].tap()
        XCTAssertTrue(app.buttons["Create your account"].waitForExistence(timeout: 15), "Sign in again returns to Welcome.")
    }

    /// The backup banner's Not now sticks across launches; the recovery
    /// nudge behind it is dismissed for the session only, and its CTA opens
    /// Cloud recovery.
    func test_backupBannerAndRecoveryNudge() throws {
        var app = launch(admin: true, ["-smoke-banners-fresh"])
        XCTAssertTrue(text(app, containing: "Your account isn't backed up yet").waitForExistence(timeout: 20))
        app.buttons["fs-announcement-dismiss"].tap()
        XCTAssertTrue(text(app, containing: "Set up recovery").waitForExistence(timeout: 10),
                      "With the banner gone the recovery nudge shows.")
        XCTAssertFalse(text(app, containing: "Your account isn't backed up yet").exists)
        app.buttons["fs-announcement-dismiss"].tap()
        waitGone(text(app, containing: "Set up recovery"))

        app = launch(admin: true)
        XCTAssertTrue(text(app, containing: "Set up recovery").waitForExistence(timeout: 20),
                      "The nudge comes back next launch; the banner doesn't.")
        XCTAssertFalse(text(app, containing: "Your account isn't backed up yet").exists)
        app.buttons["fs-announcement-cta"].tap()
        XCTAssertTrue(app.navigationBars["Cloud recovery"].waitForExistence(timeout: 15), "Set it up opens Cloud recovery.")
    }

    // MARK: Apple Watch waiting

    func test_watchWaitingAlertNotNowAndUnlock() throws {
        var app = launch(admin: true, ["-smoke-watch-waiting"])
        let alert = app.alerts["Your Apple Watch is waiting"]
        XCTAssertTrue(alert.waitForExistence(timeout: 20), "The watch's waiting ask shows in the app.")
        XCTAssertTrue(alert.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "Home's start-up")).firstMatch.exists,
                      "It names the server.")
        shot(app, "watch-waiting")
        alert.buttons["Not now"].tap()
        waitGone(alert)

        app = launch(admin: true, ["-smoke-watch-waiting"])
        XCTAssertTrue(alert.waitForExistence(timeout: 20))
        app.alerts.firstMatch.buttons["Unlock"].tap()
        waitGone(app.alerts.firstMatch)
        XCTAssertTrue(podRow(app, named: "Home").isHittable)
    }

    // MARK: Lock screen

    /// Sign out on the lock screen asks first: Cancel closes the question,
    /// Sign out anyway returns to Welcome. (Unlock itself needs the
    /// simulator's biometric, which the gym doesn't control.)
    func test_lockScreenSignOutAsksFirst() throws {
        var app = launch(admin: true, ["-smoke-locked"])
        var signOut = app.buttons["lock-sign-out-btn"]
        XCTAssertTrue(signOut.waitForExistence(timeout: 20))
        XCTAssertTrue(button(app, "Unlock").exists, "The lock screen offers Unlock.")
        signOut.tap()
        let anyway = button(app, "Sign out anyway")
        XCTAssertTrue(anyway.waitForExistence(timeout: 10), "Without recovery it asks to sign out anyway.")
        shot(app, "lock-sign-out-ask")
        let cancel = button(app, "Cancel")
        if cancel.exists { cancel.tap() } else { app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.12)).tap() }
        waitGone(anyway)

        app = launch(admin: true, ["-smoke-locked"])
        signOut = app.buttons["lock-sign-out-btn"]
        XCTAssertTrue(signOut.waitForExistence(timeout: 20))
        signOut.tap()
        XCTAssertTrue(button(app, "Sign out anyway").waitForExistence(timeout: 10))
        button(app, "Sign out anyway").tap()
        XCTAssertTrue(app.buttons["Create your account"].waitForExistence(timeout: 15), "Signing out returns to Welcome.")
    }

    // MARK: Activity

    func test_activityMergesBoxAndAccountEvents() throws {
        let app = launch(tab: "activity", admin: true, ["-smoke-activity"])
        XCTAssertTrue(text(app, containing: "Backup ready").waitForExistence(timeout: 20), "The box's own log is listed.")
        XCTAssertTrue(text(app, containing: "App installed by Sam").exists, "A co-manager's action names them.")
        XCTAssertTrue(text(app, containing: "Update refused").exists)
        XCTAssertFalse(text(app, containing: "api/screens").exists, "Raw request lines are left out.")
        XCTAssertTrue(text(app, containing: "Server came online").exists, "Account events from .com are merged in.")
        shot(app, "activity-feed")

        expectProbe(app, "read box activity")
        let before = count("read box activity", in: probe(app))
        pullToRefresh(app)
        let more = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            self.count("read box activity", in: self.probe(app)) > before
        }, object: nil)
        XCTAssertEqual(XCTWaiter().wait(for: [more], timeout: 15), .completed, "Pulling down reloads the feed.")
    }

    func test_activityReportApprovalsAndAuditLog() throws {
        let app = launch(tab: "activity", admin: true, ["-smoke-activity"])
        let report = button(app, "View report")
        XCTAssertTrue(reveal(app, report), "A finished re-attach offers its report.")
        XCTAssertTrue(text(app, containing: "Re-attach finished.").exists)
        report.tap()
        XCTAssertTrue(app.navigationBars["Re-attach progress"].waitForExistence(timeout: 10))
        app.navBackButton(in: "Re-attach progress").tap()

        let approvals = button(app, "Open approvals")
        XCTAssertTrue(revealUp(app, approvals))
        approvals.tap()
        XCTAssertTrue(app.navigationBars["Approve box"].waitForExistence(timeout: 10))
        XCTAssertTrue(text(app, containing: "No box is waiting for approval right now.").waitForExistence(timeout: 10))
        app.navBackButton(in: "Approve box").tap()

        let audit = app.buttons["activity-open-audit-log"]
        XCTAssertTrue(reveal(app, audit))
        audit.tap()
        XCTAssertTrue(app.navigationBars["Audit log"].waitForExistence(timeout: 10))
        let more = app.buttons["audit-log-load-more"]
        XCTAssertTrue(reveal(app, more), "30 of 35 events: Load more.")
        XCTAssertFalse(text(app, containing: "Server transfer claimed").exists, "The oldest isn't loaded yet.")
        shot(app, "audit-log")
        more.tap()
        let oldest = text(app, containing: "Server transfer claimed")
        for _ in 0..<8 where !oldest.exists { app.swipeUp() }
        XCTAssertTrue(oldest.waitForExistence(timeout: 10), "Load more brings the older events.")
        XCTAssertFalse(more.exists, "Nothing more to load.")
    }

    func test_activityServerSwitcherPicksAServer() throws {
        let app = launch(tab: "activity", admin: true, ["-smoke-activity"])
        let switcher = app.buttons["pod-switcher"]
        XCTAssertTrue(switcher.waitForExistence(timeout: 20))
        switcher.tap()
        let office = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Office")).firstMatch
        XCTAssertTrue(office.waitForExistence(timeout: 10))
        office.tap()
        wait(switcher, "label CONTAINS 'Office'")
        switcher.tap()
        let all = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "All servers")).firstMatch
        XCTAssertTrue(all.waitForExistence(timeout: 10))
        all.tap()
        wait(switcher, "label CONTAINS 'All servers'")
    }

    // MARK: Demo install progress

    func test_demoServerInstallingShowsProgress() throws {
        let app = launch(admin: false, ["-smoke-demo-installing"])
        let row = podRow(app, named: "Home")
        XCTAssertTrue(row.waitForExistence(timeout: 20))
        row.tap()
        XCTAssertTrue(app.navigationBars["Installing"].waitForExistence(timeout: 15), "A demo server still installing shows its progress.")
        XCTAssertTrue(any(app, "install-progress-bar").exists)
        XCTAssertFalse(app.buttons["install-cancel-device-button"].exists,
                       "Demo servers are operator-run: nothing to cancel.")
        shot(app, "demo-installing")
    }
}
