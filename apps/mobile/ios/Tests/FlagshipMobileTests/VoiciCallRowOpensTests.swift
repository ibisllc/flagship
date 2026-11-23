import XCTest
@testable import FlagshipUI

/// A Calls row opens the conversation it belongs to, or nothing when there is none (Android: VoiciCallHistoryScreen).
final class VoiciCallRowOpensTests: XCTestCase {
    private func record(_ peer: VoiciCallRecord.Peer, _ dir: VoiciCallRecord.Direction = .incoming) -> VoiciCallRecord {
        VoiciCallRecord(callId: "c1", direction: dir, outcome: .answered, peer: peer, video: false, at: 0)
    }

    func test_aCallToAPageOpensThatConversation() {
        let o = VoiciCallsScreen.opens(record(.page(username: "brisk-quartz", pageId: "p1"), .outgoing), hasThread: { _ in false }, title: "t")
        XCTAssertEqual(o, .page(username: "brisk-quartz", pageId: "p1", title: "t"))
    }

    func test_aCallerWithAThreadOpensIt() {
        let o = VoiciCallsScreen.opens(record(.visitor(conv: "cv", pseudonymPub: String(repeating: "a", count: 64))), hasThread: { $0 == "cv" }, title: "t")
        XCTAssertEqual(o, .thread(conv: "cv"))
    }

    func test_aCallerWhoNeverWroteOrAnAnonymousOneOpensNothing() {
        XCTAssertNil(VoiciCallsScreen.opens(record(.visitor(conv: "cv", pseudonymPub: String(repeating: "a", count: 64))), hasThread: { _ in false }, title: "t"))
        XCTAssertNil(VoiciCallsScreen.opens(record(.visitor(conv: "cv", pseudonymPub: "")), hasThread: { _ in true }, title: "t"))
    }

    // MARK: Call back on a row (a caller who never wrote, while call-backs are allowed)

    private let pseudonym = String(repeating: "a", count: 64)
    private let thread = String(repeating: "b", count: 64)

    private func visitorCall(threadPub: String?, dir: VoiciCallRecord.Direction = .incoming, pseudonymPub: String? = nil) -> VoiciCallRecord {
        VoiciCallRecord(callId: "c1", direction: dir, outcome: .missed, peer: .visitor(conv: "cv", pseudonymPub: pseudonymPub ?? pseudonym),
                        video: false, at: 0, threadPub: threadPub)
    }

    func test_aCallerWhoNeverWroteCanBeCalledBackWhileAllowed() {
        var asked: [String] = []
        let b = VoiciCallsScreen.callBack(visitorCall(threadPub: thread), hasThread: { _ in false }, canRingBack: { conv, p, t in
            asked = [conv, p, t]; return true
        })
        XCTAssertEqual(b, VoiciCallsScreen.CallBack(conv: "cv", pseudonymPub: pseudonym, threadPub: thread))
        XCTAssertEqual(asked, ["cv", pseudonym, thread])
    }

    func test_noCallBackWhenRefusedThreadedAnonymousOrWithoutThreadKey() {
        let yes: (String, String, String) -> Bool = { _, _, _ in true }
        // Call-backs no longer allowed (a refused ring, a block, calls off).
        XCTAssertNil(VoiciCallsScreen.callBack(visitorCall(threadPub: thread), hasThread: { _ in false }, canRingBack: { _, _, _ in false }))
        // A thread exists: the row opens it, and its Call rings back.
        XCTAssertNil(VoiciCallsScreen.callBack(visitorCall(threadPub: thread), hasThread: { _ in true }, canRingBack: yes))
        // An anonymous caller can't be rung back.
        XCTAssertNil(VoiciCallsScreen.callBack(visitorCall(threadPub: thread, pseudonymPub: ""), hasThread: { _ in false }, canRingBack: yes))
        // A record without the caller's thread key (an older build's record).
        XCTAssertNil(VoiciCallsScreen.callBack(visitorCall(threadPub: nil), hasThread: { _ in false }, canRingBack: yes))
        XCTAssertNil(VoiciCallsScreen.callBack(visitorCall(threadPub: ""), hasThread: { _ in false }, canRingBack: yes))
        // A call this device placed to a page is called again with Call, not Call back.
        let out = VoiciCallRecord(callId: "c2", direction: .outgoing, outcome: .answered, peer: .page(username: "u", pageId: "p"), video: false, at: 0)
        XCTAssertNil(VoiciCallsScreen.callBack(out, hasThread: { _ in false }, canRingBack: yes))
    }

    func test_aMissedCallKeepsTheCallersThreadKeyInTheList() {
        let m = VoiciMissedCallRow(callId: "m1", conv: "cv", pseudonymPub: pseudonym, reason: "no-answer", ringingAt: 5, video: true, threadPub: thread)
        let rows = VoiciCallHistory.merge(records: [], missed: [m])
        XCTAssertEqual(rows.first?.threadPub, thread)
        let anon = VoiciMissedCallRow(callId: "m2", conv: "cv2", pseudonymPub: "", reason: "no-answer", ringingAt: 6, video: false)
        XCTAssertNil(VoiciCallHistory.merge(records: [], missed: [anon]).first?.threadPub)
    }

    func test_aRecordFromAnOlderBuildDecodesWithoutAThreadKey() throws {
        let old = #"{"callId":"c","direction":"incoming","outcome":"missed","peer":{"visitor":{"conv":"cv","pseudonymPub":"p"}},"video":false,"at":1,"durationMs":0}"#
        let r = try JSONDecoder().decode(VoiciCallRecord.self, from: Data(old.utf8))
        XCTAssertNil(r.threadPub)
    }

    func test_aboutCallBacksNamesThePageAndTheVisitorName() {
        let named = VoiciCallBackAbout.points(username: "brisk-quartz", visitorName: "Visitor 4F3A")
        XCTAssertEqual(named.count, 4)
        XCTAssertEqual(named[0], "brisk-quartz sees only your visitor name, Visitor 4F3A (or a nickname they gave you), never your account.")
        XCTAssertTrue(named[2].contains("brisk-quartz blocks you"))
        XCTAssertFalse(named.joined().contains("voi.ci/"))
        let unnamed = VoiciCallBackAbout.points(username: "brisk-quartz", visitorName: nil)
        XCTAssertEqual(unnamed[0], "brisk-quartz sees only a visitor name (or a nickname they gave you), never your account.")
    }
}
