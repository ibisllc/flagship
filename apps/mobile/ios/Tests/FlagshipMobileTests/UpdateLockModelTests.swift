import XCTest
import FlagshipCore
@testable import FlagshipUI

/// The exact words of the banner and the "Update required" lock
/// (docs/security-notices.md section 6.4 and 6.5).
final class UpdateLockModelTests: XCTestCase {
    private func lockNotice() throws -> SecurityNotice {
        let json = try XCTUnwrap(SecurityNoticeGym.notices["lock"])
        let any = try JSONSerialization.jsonObject(with: Data(json.utf8))
        return try XCTUnwrap(SecurityNotice.parse(any))
    }

    func testLockScreenStrings() throws {
        let m = UpdateLockModel(notice: try lockNotice(), accountUnlocked: true) { _ in "Wednesday, October 28 at 9:00 AM" }
        XCTAssertEqual(m.kicker, "Security update")
        XCTAssertEqual(m.title, "Update required")
        XCTAssertEqual(m.body, "You must update Flagship by Wednesday, October 28 at 9:00 AM. Older versions will stop working.")
        XCTAssertEqual(m.why, "Why: A flaw in how a signed message is checked lets an attacker act as you.")
        XCTAssertEqual(m.reassure, "Your accounts and servers are unchanged and nothing has been deleted. Flagship is paused on this device until you update.")
        XCTAssertEqual(m.update, "Update Flagship")
        XCTAssertEqual(m.backup, "Back up my account key")
        XCTAssertEqual(m.signOut, "Sign out")
        XCTAssertEqual(m.meta, "Advisory FSA-2026-001 · Signed by the Flagship maintainers")
    }

    func testBackupStepsAsideToTheUnlockWhileTheAccountIsLocked() throws {
        let m = UpdateLockModel(notice: try lockNotice(), accountUnlocked: false) { _ in "x" }
        XCTAssertEqual(m.backup, "Unlock to back up my account key")
    }

    func testTheStoreLinkIsTheAppsOwnConstant() {
        XCTAssertEqual(AppStoreListing.url.absoluteString, "https://apps.apple.com/app/id6768945985")
    }

    func testBannerStrings() {
        XCTAssertEqual(NoticeCopy.bannerDismiss, "Dismiss")
        XCTAssertEqual(NoticeCopy.bannerUpdate, "Update")
        XCTAssertEqual(NoticeCopy.updateFailed, "Couldn't update yet. Check your connection and try again.")
    }
}
