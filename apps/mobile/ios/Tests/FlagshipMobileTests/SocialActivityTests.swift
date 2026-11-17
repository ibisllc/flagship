import XCTest
@testable import FlagshipAPI
@testable import FlagshipCore
@testable import FlagshipUI

/// Calls and social entries on Activity (docs/activity-social.md): built from the call list, the conversations and the
/// published page; the same kinds as Android's SocialActivity and the webapp's lib/socialActivity.js.
final class SocialActivityTests: XCTestCase {
    private func msg(_ id: String, conv: String, owner: Bool, at: Int64) -> VoiciThreadMessage {
        VoiciThreadMessage(msgId: id, conv: conv, fromOwner: owner, from: "p", seq: 1, text: id, replyTo: nil, sentAt: at, receipt: .sent, envelope: .null)
    }

    private func conv(_ id: String, pseudonym: String, messages: [VoiciThreadMessage]) -> VoiciConversation {
        VoiciConversation(conv: id, pseudonymPub: pseudonym, threadPub: "", messages: messages, hasGap: false)
    }

    private func index(seq: Int64, at: Int64) -> VoiciPageIndex {
        VoiciPageIndex(username: "alice", pageId: String(repeating: "ab", count: 16), seq: seq, issuedAt: at, acceptsMessages: 1, inboxEpoch: 1,
                       inboxPub: "", ownerSignPub: "", pieces: [], signerKind: "admin-root")
    }

    private func build(calls: [VoiciCallRecord] = [], conversations: [VoiciConversation] = [], requests: Set<String> = [],
                       index: VoiciPageIndex? = nil, posts: [VoiciPost] = []) -> [SocialActivityEntry] {
        SocialActivity.build(calls: calls, conversations: conversations, isRequest: { requests.contains($0.conv) },
                             name: { "Name \($0)" }, index: index, posts: posts)
    }

    func test_callKindsFollowDirectionAndOutcome() {
        let calls = [
            VoiciCallRecord(callId: "1", direction: .incoming, outcome: .missed, peer: .visitor(conv: "c1", pseudonymPub: "p1"), video: false, at: 10),
            VoiciCallRecord(callId: "2", direction: .incoming, outcome: .answered, peer: .visitor(conv: "gone", pseudonymPub: "p2"), video: true, at: 20),
            VoiciCallRecord(callId: "3", direction: .incoming, outcome: .declined, peer: .visitor(conv: "c1", pseudonymPub: "p1"), video: false, at: 30),
            VoiciCallRecord(callId: "4", direction: .outgoing, outcome: .noAnswer, peer: .page(username: "bob", pageId: "x"), video: false, at: 40),
        ]
        let out = build(calls: calls, conversations: [conv("c1", pseudonym: "p1", messages: [msg("m", conv: "c1", owner: false, at: 5)])])
        let byId = Dictionary(uniqueKeysWithValues: out.map { ($0.id, $0) })
        XCTAssertEqual(byId["call:incoming|1"]?.kind, .callMissed)
        XCTAssertEqual(byId["call:incoming|1"]?.target, .thread(conv: "c1"))
        XCTAssertEqual(byId["call:incoming|2"]?.kind, .callAnswered)
        // Its conversation is gone (deleted): the call opens the Calls page instead.
        XCTAssertEqual(byId["call:incoming|2"]?.target, .calls)
        XCTAssertEqual(byId["call:incoming|3"]?.kind, .callDeclined)
        XCTAssertEqual(byId["call:outgoing|4"]?.kind, .callPlaced)
        XCTAssertEqual(byId["call:outgoing|4"]?.name, "bob")
        XCTAssertEqual(byId["call:incoming|1"]?.name, "Name p1")
        XCTAssertEqual(out.map(\.at), [40, 30, 20, 10, 5], "Newest first.")
        XCTAssertEqual(SocialActivity.detail(byId["call:incoming|2"]!), String(localized: "Video call"))
    }

    func test_answeredCallsShowTheirLength() {
        let calls = [
            VoiciCallRecord(callId: "1", direction: .incoming, outcome: .answered, peer: .visitor(conv: "c", pseudonymPub: "p"), video: false, at: 10, durationMs: 272_400),
            VoiciCallRecord(callId: "2", direction: .outgoing, outcome: .answered, peer: .page(username: "bob", pageId: "x"), video: true, at: 20, durationMs: 3_725_000),
            VoiciCallRecord(callId: "3", direction: .incoming, outcome: .missed, peer: .visitor(conv: "c", pseudonymPub: "p"), video: false, at: 30, durationMs: 9_000),
            VoiciCallRecord(callId: "4", direction: .incoming, outcome: .answered, peer: .visitor(conv: "c", pseudonymPub: "p"), video: false, at: 40),
        ]
        let byId = Dictionary(uniqueKeysWithValues: build(calls: calls).map { ($0.id, $0) })
        XCTAssertEqual(byId["call:incoming|1"]?.durationMs, 272_400)
        XCTAssertEqual(SocialActivity.detail(byId["call:incoming|1"]!), String(localized: "Answered · \("4:32")"))
        XCTAssertEqual(SocialActivity.detail(byId["call:outgoing|2"]!), String(localized: "Video call · \("1:02:05")"))
        // Only an answered call has a length; one with none recorded shows no detail.
        XCTAssertNil(byId["call:incoming|3"]?.durationMs)
        XCTAssertNil(SocialActivity.detail(byId["call:incoming|4"]!))
    }

    func test_callLengthIsTheLocalesClock() {
        let en = { () -> Calendar in var c = Calendar(identifier: .gregorian); c.locale = Locale(identifier: "en_US"); return c }()
        XCTAssertEqual(SocialActivity.callLength(5_000, calendar: en), "0:05")
        XCTAssertEqual(SocialActivity.callLength(65_000, calendar: en), "1:05")
        XCTAssertEqual(SocialActivity.callLength(272_999, calendar: en), "4:32")
        XCTAssertEqual(SocialActivity.callLength(754_000, calendar: en), "12:34")
        XCTAssertEqual(SocialActivity.callLength(3_725_000, calendar: en), "1:02:05")
        XCTAssertNil(SocialActivity.callLength(0, calendar: en))
        // Digits follow the locale (Eastern Arabic here; none of the shipped languages changes them).
        var ar = Calendar(identifier: .gregorian); ar.locale = Locale(identifier: "ar_EG")
        XCTAssertEqual(SocialActivity.callLength(272_000, calendar: ar), "\u{0664}:\u{0663}\u{0662}")
    }

    func test_conversationsAreNewOrRequestsAtTheirFirstMessage() {
        let accepted = conv("a", pseudonym: "pa", messages: [msg("1", conv: "a", owner: false, at: 100), msg("2", conv: "a", owner: true, at: 200)])
        let request = conv("r", pseudonym: "pr", messages: [msg("3", conv: "r", owner: false, at: 300)])
        let out = build(conversations: [accepted, request], requests: ["r"])
        XCTAssertEqual(out.map(\.kind), [.conversationRequest, .conversationNew])
        XCTAssertEqual(out.map(\.at), [300, 100])
        XCTAssertEqual(out.last?.target, .thread(conv: "a"))
        XCTAssertEqual(SocialActivity.title(out[0]), String(localized: "Message request from \("Name pr")"))
    }

    func test_pageEntriesOnlyWhilePublic() {
        XCTAssertTrue(build(index: nil, posts: []).isEmpty)
        let first = build(index: index(seq: 1, at: 50), posts: [VoiciPost(id: "p", createdAt: 49, editedAt: nil, text: "Hello.\nSecond line", links: [])])
        XCTAssertEqual(first.map(\.kind), [.pagePublished, .postPublished])
        XCTAssertEqual(first.last?.snippet, "Hello.")
        XCTAssertEqual(first.map(\.target), [.page, .page])
        XCTAssertEqual(build(index: index(seq: 4, at: 50)).map(\.kind), [.pageUpdated])
    }

    func test_aLongPostIsShortened() {
        let s = SocialActivity.snippet(String(repeating: "x", count: 200))
        XCTAssertEqual(s?.count, 80)
        XCTAssertNil(SocialActivity.snippet("  \n"))
    }
}
