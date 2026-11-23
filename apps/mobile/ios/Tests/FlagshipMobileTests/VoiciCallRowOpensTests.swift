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
}
