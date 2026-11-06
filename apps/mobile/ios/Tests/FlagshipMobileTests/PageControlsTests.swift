import XCTest
import CryptoKit
@testable import Flagship
@testable import FlagshipCore
@testable import FlagshipUI

/// The page's controls (docs/voici-and-messages.md §3.3, §11): Home's pointer, the one-time public warning, and the
/// store's Public switch, quick name edit and "Remove my page" against the mock `.com` (which runs `.com`'s checks,
/// including checkVoiciPageRemove). Mirrors Android's PageControlsTest.
@MainActor
final class PageControlsTests: XCTestCase {

    private func freshDefaults() -> UserDefaults {
        let name = "flagship.tests.pageControls." + UUID().uuidString
        let d = UserDefaults(suiteName: name)!
        d.removePersistentDomain(forName: name)
        return d
    }

    // MARK: Home's pointer

    private func pointer(checked: Bool = true, published: Bool = false, ever: Bool = false, pending: Int = 0,
                         dismissed: Bool = false, hasAccount: Bool = true) -> PageWelcomeCardStore.Pointer {
        PageWelcomeCardStore.pointer(hasAccount: hasAccount, checked: checked, published: published, everPublished: ever,
                                     pendingChanges: pending, dismissed: dismissed)
    }

    func test_pointer_welcomeUntilFirstPublic() {
        XCTAssertEqual(pointer(), .welcome)
        XCTAssertEqual(pointer(published: true, ever: true), .row(isPublic: true))
    }

    func test_pointer_rowStaysAfterTheCardIsDismissedOrThePageTurnedOff() {
        XCTAssertEqual(pointer(dismissed: true), .row(isPublic: false))
        XCTAssertEqual(pointer(ever: true), .row(isPublic: false), "A page turned off keeps the row, never the welcome again.")
        XCTAssertEqual(pointer(pending: 2), .row(isPublic: false), "Changes started: the person found the page.")
    }

    func test_pointer_hiddenForASampleAccountOrBeforeTheRead() {
        XCTAssertEqual(pointer(hasAccount: false), .hidden)
        XCTAssertEqual(pointer(checked: false), .hidden)
    }

    func test_everPublishedIsPerAccountAndPersists() {
        let d = freshDefaults()
        let a = PageWelcomeCardStore(defaults: d)
        XCTAssertFalse(a.everPublished(username: "jolly-quince"))
        PageWelcomeCardStore.recordPublished(username: "jolly-quince", defaults: d)
        XCTAssertTrue(PageWelcomeCardStore(defaults: d).everPublished(username: "Jolly-Quince"))
        XCTAssertFalse(a.everPublished(username: "plucky-avocet"))
    }

    // MARK: the one-time warning

    func test_warningSteps() {
        XCTAssertEqual(PagePublicWarning.next(isAdmin: false, rulesAccepted: true, acknowledged: true), .refuse,
                       "A non-admin device never reaches a signature.")
        XCTAssertEqual(PagePublicWarning.next(isAdmin: true, rulesAccepted: false, acknowledged: true), .rules)
        XCTAssertEqual(PagePublicWarning.next(isAdmin: true, rulesAccepted: true, acknowledged: false), .warning)
        XCTAssertEqual(PagePublicWarning.next(isAdmin: true, rulesAccepted: true, acknowledged: true), .publish)
    }

    func test_warningIsRememberedPerAccount() {
        let d = freshDefaults()
        let w = PagePublicWarning(defaults: d)
        XCTAssertFalse(w.acknowledged(username: "jolly-quince"))
        w.acknowledge(username: "Jolly-Quince")
        XCTAssertTrue(PagePublicWarning(defaults: d).acknowledged(username: "jolly-quince"))
        XCTAssertFalse(w.acknowledged(username: "plucky-avocet"))
        XCTAssertFalse(w.acknowledged(username: nil))
    }

    // MARK: the store against the mock `.com`

    private var user = ""
    private var mock = MockVoiciComClient()

    override func setUp() {
        super.setUp()
        GymSeams.adminRootSeed = GymSeams.gymAdminRootSeed
        GymSeams.accountRootSeed = Data(repeating: 0x42, count: 32)
        user = "page-" + String(UUID().uuidString.prefix(8)).lowercased()
        mock = MockVoiciComClient()
        let admin = CanonicalJson.hex(try! CanonicalJson.ed25519PublicKey(seed: Array(GymSeams.gymAdminRootSeed)))
        mock.keys[user] = VoiciAccountKeys(irkPub: String(repeating: "11", count: 32), adminRootPub: admin)
    }

    override func tearDown() {
        GymSeams.adminRootSeed = nil
        GymSeams.accountRootSeed = nil
        super.tearDown()
    }

    private func store() async -> MessagesStore {
        let s = MessagesStore()
        s.directDelivery = false
        s.configure(client: mock, username: user, deviceId: "d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0", isDemo: false)
        await s.refresh()
        return s
    }

    private func publishedIndex() -> VoiciPageIndex? { mock.pages[user].flatMap { VoiciPage.parseVoiciPageIndex($0) } }

    func test_switchOnPublishesTheNameAndLeavesOtherDraftsAsDrafts() async throws {
        let s = await store()
        XCTAssertEqual(s.phase, .ready)
        XCTAssertFalse(s.isPublic)
        let r1 = await s.setQuickProfile(displayName: "Bright Maple", avatar: nil)
        XCTAssertNil(r1)
        XCTAssertEqual(s.pendingCount, 1, "Before the page is public a name change is a draft.")
        XCTAssertEqual(mock.publishes, 0)
        await s.addPost(text: "Not yet.", links: [], images: [:])
        await s.goPublic()
        XCTAssertTrue(s.isPublic)
        XCTAssertEqual(publishedIndex()?.seq, 1)
        XCTAssertEqual(s.published?.profile.displayName, "Bright Maple")
        XCTAssertEqual(s.published?.chunks.flatMap { $0 }.count, 0, "The post draft was not published.")
        XCTAssertEqual(s.pendingCount, 1, "Only the post waits; the name draft is in the page.")

        // While public the quick name edit publishes at once, and only that.
        let r2 = await s.setQuickProfile(displayName: "Maple", avatar: nil)
        XCTAssertNil(r2)
        XCTAssertEqual(publishedIndex()?.seq, 2)
        XCTAssertEqual(s.published?.profile.displayName, "Maple")
        XCTAssertEqual(s.pendingCount, 1)

        // The editor's Publish takes the rest.
        await s.publishNow()
        XCTAssertEqual(publishedIndex()?.seq, 3)
        XCTAssertEqual(s.published?.chunks.flatMap { $0 }.map(\.text), ["Not yet."])
        XCTAssertEqual(s.pendingCount, 0)
    }

    func test_editsAreDraftsUntilPublish() async throws {
        let s = await store()
        await s.goPublic()
        let before = mock.publishes
        await s.setAcceptsMessages(true)
        await s.addPost(text: "Draft.", links: [], images: [:])
        await s.refresh()
        XCTAssertEqual(mock.publishes, before, "Neither the edit nor a refresh publishes a draft.")
        XCTAssertEqual(s.pendingCount, 2)
        await s.setAcceptsMessages(false)
        XCTAssertEqual(s.pendingCount, 1, "Setting it back drops the draft.")
    }

    func test_removeSignsTheNextSeqAndRepublishingContinuesTheLadder() async throws {
        let s = await store()
        _ = await s.setQuickProfile(displayName: "Bright Maple", avatar: nil)
        await s.goPublic()
        await s.addPost(text: "Kept on the device.", links: [], images: [:])
        let idx = try XCTUnwrap(publishedIndex())

        await s.removePage()
        XCTAssertNil(s.publishError)
        XCTAssertTrue(s.isRemoved)
        XCTAssertFalse(s.isPublic)
        let sent = try XCTUnwrap(mock.removals.last)
        let r = try XCTUnwrap(VoiciPageRemove.parse(sent))
        XCTAssertEqual(r.seq, idx.seq + 1)
        XCTAssertEqual(r.pageId, idx.pageId)
        XCTAssertEqual(r.signerKind, "admin-root", "Signed by the key that signs the index.")
        XCTAssertEqual(r.signerPub, mock.keys[user]?.adminRootPub)
        let page = try await mock.page(username: user)
        XCTAssertNil(page, "Visitors see no page.")
        XCTAssertEqual(s.pendingCount, 1, "Drafts stay.")

        // A relaunch remembers the removal and the content.
        let again = await store()
        XCTAssertTrue(again.isRemoved)
        XCTAssertEqual(again.published?.profile.displayName, "Bright Maple")

        await again.goPublic()
        XCTAssertTrue(again.isPublic)
        XCTAssertEqual(publishedIndex()?.seq, r.seq + 1, "Republishing takes the removal's seq + 1.")
        XCTAssertEqual(publishedIndex()?.pageId, idx.pageId)
        XCTAssertEqual(again.published?.profile.displayName, "Bright Maple", "The page comes back as it was.")
    }

    func test_removalOnAnotherDeviceIsSeenAndAQuickEditDoesNotBringThePageBack() async throws {
        let s = await store()
        await s.goPublic()
        let idx = try XCTUnwrap(publishedIndex())
        mock.removed[user] = (idx.seq + 1, idx.pageId)
        // This device has not refreshed yet: its quick edit meets the 409 and stops.
        _ = await s.setQuickProfile(displayName: "Oak", avatar: nil)
        XCTAssertTrue(s.isRemoved)
        let page = try await mock.page(username: user)
        XCTAssertNil(page, "Only the Public switch brings a removed page back.")
        // The switch does, on the ladder.
        await s.goPublic()
        XCTAssertEqual(publishedIndex()?.seq, idx.seq + 2)
    }

    func test_aNewDeviceRepublishesARemovedPageOnItsLadderAndPageId() async throws {
        let s = await store()
        await s.goPublic()
        await s.removePage()
        let removedAt = try XCTUnwrap(VoiciPageRemove.parse(try XCTUnwrap(mock.removals.last)))
        // A device that never saw the page: nothing on disk for it.
        let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("flagship-messages")
        try? FileManager.default.removeItem(at: dir.appendingPathComponent("\(user).json"))
        let fresh = await store()
        XCTAssertNil(fresh.index)
        await fresh.goPublic()
        XCTAssertNil(fresh.publishError)
        XCTAssertEqual(publishedIndex()?.seq, removedAt.seq + 1)
        XCTAssertEqual(publishedIndex()?.pageId, removedAt.pageId)
    }

    func test_removeAfterAnotherDevicePublishedRetriesOnceOnTheNewIndex() async throws {
        let s = await store()
        await s.goPublic()
        // Another admin device publishes seq 2 meanwhile.
        let other = await store()
        _ = await other.setQuickProfile(displayName: "Other device", avatar: nil)
        XCTAssertEqual(publishedIndex()?.seq, 2)
        await s.removePage()
        XCTAssertNil(s.publishError)
        XCTAssertEqual(mock.removals.count, 1)
        XCTAssertEqual(VoiciPageRemove.parse(try XCTUnwrap(mock.removals.last))?.seq, 3)
    }

    func test_aDeviceWithoutTheAdminRootCanNeitherPublishNorRemove() async throws {
        GymSeams.adminRootSeed = nil
        let s = await store()
        XCTAssertFalse(s.isAdmin)
        await s.goPublic()
        await s.removePage()
        XCTAssertEqual(mock.publishes, 0)
        XCTAssertTrue(mock.removals.isEmpty)
    }
}
