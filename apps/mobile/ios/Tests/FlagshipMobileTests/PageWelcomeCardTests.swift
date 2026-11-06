import XCTest
@testable import FlagshipCore

/// Home's voi.ci page welcome card. Mirror of Android's PageWelcomeCardTest and the webapp's
/// homePageWelcome.test.ts: same truth table, dismissal kept per account.
@MainActor
final class PageWelcomeCardTests: XCTestCase {

    private func freshDefaults() -> UserDefaults {
        let name = "flagship.tests.pageWelcome." + UUID().uuidString
        let d = UserDefaults(suiteName: name)!
        d.removePersistentDomain(forName: name)
        return d
    }

    private func show(hasAccount: Bool = true, checked: Bool = true, published: Bool = false,
                      pending: Int = 0, dismissed: Bool = false) -> Bool {
        PageWelcomeCardStore.shouldShow(hasAccount: hasAccount, checked: checked, published: published,
                                        pendingChanges: pending, dismissed: dismissed)
    }

    func test_showsForAnAccountWithNoPage() {
        XCTAssertTrue(show())
    }

    func test_hiddenOnceThePageIsPublished() {
        XCTAssertFalse(show(published: true))
    }

    func test_hiddenWhileAChangeWaitsToBePublished() {
        XCTAssertFalse(show(pending: 1))
    }

    func test_hiddenAfterDismiss() {
        XCTAssertFalse(show(dismissed: true))
    }

    func test_hiddenForASampleAccountOrNoAccount() {
        XCTAssertFalse(show(hasAccount: false))
    }

    func test_hiddenUntilThePageWasRead() {
        // A failed or not-yet-made read is not "no page".
        XCTAssertFalse(show(checked: false))
    }

    func test_dismissIsPerAccountAndPersists() {
        let d = freshDefaults()
        let a = PageWelcomeCardStore(defaults: d)
        XCTAssertFalse(a.isDismissed(username: "jolly-quince"))
        a.dismiss(username: "Jolly-Quince")
        XCTAssertTrue(a.isDismissed(username: "jolly-quince"))
        XCTAssertFalse(a.isDismissed(username: "plucky-avocet"), "another account on this device still sees it")
        let b = PageWelcomeCardStore(defaults: d)
        XCTAssertTrue(b.isDismissed(username: "jolly-quince"), "a new launch remembers it")
    }

    func test_noAccountCountsAsDismissed() {
        let s = PageWelcomeCardStore(defaults: freshDefaults())
        XCTAssertTrue(s.isDismissed(username: nil))
        XCTAssertTrue(s.isDismissed(username: ""))
    }
}
