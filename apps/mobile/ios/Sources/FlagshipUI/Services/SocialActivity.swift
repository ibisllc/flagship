import Foundation
import FlagshipCore

/// One call or social entry on the Activity tab (docs/activity-social.md). Built on this device, every time Activity
/// draws, from what the app already holds: the call list, the conversations in MessagesStore and the published page.
/// Nothing is stored or sent for it, so deleting a conversation (which drops its messages, missed calls and call
/// records on every device, §10.1.1) removes its entries here too. Same kinds on Android (`SocialActivity.kt`) and the
/// webapp (`lib/socialActivity.js`); parity row `activity-social`.
public struct SocialActivityEntry: Identifiable, Equatable, Sendable {
    public enum Kind: String, Sendable {
        case callMissed = "call.missed"
        case callDeclined = "call.declined"
        case callAnswered = "call.answered"
        case callPlaced = "call.placed"
        case conversationNew = "conversation.new"
        case conversationRequest = "conversation.request"
        case pagePublished = "page.published"
        case pageUpdated = "page.updated"
        case postPublished = "post.published"
        // Comments and reactions on the owner's posts are not built yet (docs/social-tab.md §3.3). When they are, add
        // "comment.new" and "reaction.new" here, built from the same data that feeds SocialBadges.profile.
    }

    /// What a tap opens.
    public enum Target: Equatable, Hashable, Sendable {
        case thread(conv: String)
        case calls
        case page
    }

    public var id: String
    public var kind: Kind
    public var at: Int64
    /// The other side's name (a nickname, the visitor's pseudonym name, or a page's username); "" for the page.
    public var name: String
    /// A post's first line; nil otherwise.
    public var snippet: String?
    public var video: Bool
    public var target: Target
    /// How long an answered call lasted, in milliseconds; nil for every other entry.
    public var durationMs: Int64? = nil
}

public enum SocialActivity {
    /// Every entry, newest first. `conversations` are the ones the Inbox and Requests show (deleted, archived and
    /// blocked ones are not in it); `index` is the published page (nil while it isn't public).
    public static func build(
        calls: [VoiciCallRecord],
        conversations: [VoiciConversation],
        isRequest: (VoiciConversation) -> Bool,
        name: (String) -> String,
        index: VoiciPageIndex?,
        posts: [VoiciPost]
    ) -> [SocialActivityEntry] {
        var out: [SocialActivityEntry] = []
        let convs = Set(conversations.map(\.conv))
        for r in calls {
            let kind: SocialActivityEntry.Kind
            switch (r.direction, r.outcome) {
            case (.outgoing, _): kind = .callPlaced
            case (.incoming, .answered): kind = .callAnswered
            case (.incoming, .declined): kind = .callDeclined
            case (.incoming, _): kind = .callMissed
            }
            let who: String
            let target: SocialActivityEntry.Target
            switch r.peer {
            case .page(let username, _):
                who = username
                target = .calls
            case .visitor(let conv, let pseudonymPub):
                who = name(pseudonymPub)
                target = convs.contains(conv) ? .thread(conv: conv) : .calls
            }
            out.append(SocialActivityEntry(id: "call:\(r.id)", kind: kind, at: r.at, name: who, snippet: nil, video: r.video, target: target,
                                           durationMs: r.outcome == .answered && r.durationMs > 0 ? r.durationMs : nil))
        }
        for c in conversations {
            guard let first = c.messages.first(where: { !$0.fromOwner }) ?? c.messages.first else { continue }
            out.append(SocialActivityEntry(id: "conv:\(c.conv)", kind: isRequest(c) ? .conversationRequest : .conversationNew,
                                           at: first.sentAt, name: name(c.pseudonymPub), snippet: nil, video: false,
                                           target: .thread(conv: c.conv)))
        }
        if let index {
            out.append(SocialActivityEntry(id: "page:\(index.seq)", kind: index.seq <= 1 ? .pagePublished : .pageUpdated,
                                           at: index.issuedAt, name: "", snippet: nil, video: false, target: .page))
            for p in posts {
                out.append(SocialActivityEntry(id: "post:\(p.id)", kind: .postPublished, at: p.createdAt, name: "",
                                               snippet: snippet(p.text), video: false, target: .page))
            }
        }
        return out.sorted { $0.at == $1.at ? $0.id < $1.id : $0.at > $1.at }
    }

    /// A post's first line, shortened to 80 characters.
    static func snippet(_ text: String) -> String? {
        let line = text.split(whereSeparator: \.isNewline).first.map(String.init)?.trimmingCharacters(in: .whitespaces) ?? ""
        if line.isEmpty { return nil }
        return line.count > 80 ? String(line.prefix(79)) + "…" : line
    }

    public static func title(_ e: SocialActivityEntry) -> String {
        switch e.kind {
        case .callMissed: return String(localized: "Missed call from \(e.name)")
        case .callDeclined: return String(localized: "Declined a call from \(e.name)")
        case .callAnswered: return String(localized: "Call with \(e.name)")
        case .callPlaced: return String(localized: "You called \(e.name)")
        case .conversationNew: return String(localized: "New conversation with \(e.name)")
        case .conversationRequest: return String(localized: "Message request from \(e.name)")
        case .pagePublished: return String(localized: "Your page went public")
        case .pageUpdated: return String(localized: "Your page was updated")
        case .postPublished: return String(localized: "You posted on your page")
        }
    }

    public static func detail(_ e: SocialActivityEntry) -> String? {
        if e.kind == .postPublished { return e.snippet }
        if let ms = e.durationMs, let length = callLength(ms) {
            return e.video ? String(localized: "Video call · \(length)") : String(localized: "Answered · \(length)")
        }
        if e.video { return String(localized: "Video call") }
        return nil
    }

    /// An answered call's length as the locale writes a clock ("4:32", "1:02:05" over an hour, digits localized);
    /// nil for no length. Also used by the Calls list.
    public static func callLength(_ ms: Int64, calendar: Calendar = .autoupdatingCurrent) -> String? {
        guard ms > 0 else { return nil }
        let seconds = TimeInterval(ms / 1000)
        let f = DateComponentsFormatter()
        f.unitsStyle = .positional
        f.calendar = calendar
        if seconds >= 3600 {
            f.allowedUnits = [.hour, .minute, .second]
            return f.string(from: seconds)
        }
        // Padded gives "04:32" and "00:05"; one leading zero of the minutes is dropped to read "4:32" and "0:05".
        f.allowedUnits = [.minute, .second]
        f.zeroFormattingBehavior = .pad
        guard let s = f.string(from: seconds) else { return nil }
        return seconds < 600 ? String(s.dropFirst()) : s
    }

    public static func symbol(_ e: SocialActivityEntry) -> String {
        switch e.kind {
        case .callMissed, .callDeclined: return "phone.down.fill"
        case .callAnswered: return e.video ? "video.fill" : "phone.fill"
        case .callPlaced: return e.video ? "video.fill" : "phone.arrow.up.right.fill"
        case .conversationNew: return "bubble.left.and.bubble.right.fill"
        case .conversationRequest: return "tray.and.arrow.down.fill"
        case .pagePublished, .pageUpdated: return "globe"
        case .postPublished: return "square.and.pencil"
        }
    }

    /// Missed calls show as warnings.
    public static func isAlert(_ e: SocialActivityEntry) -> Bool { e.kind == .callMissed }
}

extension MessagesStore {
    /// The account's call and social entries for Activity (empty for a sample account or with no account here).
    public var socialActivity: [SocialActivityEntry] {
        guard hasAccount, !isSampleReadOnly else { return [] }
        let posts = isPublic ? (published?.chunks.flatMap { $0 } ?? []) : []
        return SocialActivity.build(
            calls: VoiciCallHistory.shared.entries(missed: missedCalls),
            conversations: visibleConversations,
            isRequest: isRequest,
            name: { self.name(pseudonymPub: $0) },
            index: isPublic ? index : nil,
            posts: posts
        )
    }
}
