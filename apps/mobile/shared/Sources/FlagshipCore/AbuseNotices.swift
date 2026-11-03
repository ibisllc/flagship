import Foundation
import CryptoKit
import Observation
import FlagshipAPI

/// `flagship/abuse-notice-done/v1`: an account admin marks an operator's notice done (docs/abuse-handling.md §4).
/// Wire parity with packages/protocol/src/abuseNotice.ts; pinned by
/// packages/protocol/test-vectors/abuse-notice-done/vectors.json.
///
///   flagship/abuse-notice-done/v1|<username lowercase>|<noticeId>|<sha256 hex of the UTF-8 note>|<issuedAt>
public struct AbuseNoticeDone: Equatable, Sendable {
    public static let canonicalTag = "flagship/abuse-notice-done/v1"
    /// UTF-16 code units, as the protocol's `note.length`.
    public static let noteMax = 1000

    public struct Invalid: Error, Equatable { public let reason: String }

    public let username: String
    public let noticeId: String
    public let note: String
    public let issuedAt: Int64

    public init(username: String, noticeId: String, note: String, issuedAt: Int64) {
        self.username = username; self.noticeId = noticeId; self.note = note; self.issuedAt = issuedAt
    }

    public static func noteSha256Hex(_ note: String) -> String {
        SHA256.hash(data: Data(note.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    public func canonicalBytes() throws -> Data {
        let user = username.lowercased()
        guard user.range(of: #"^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$"#, options: .regularExpression) != nil else {
            throw Invalid(reason: "username")
        }
        guard noticeId.range(of: #"^[0-9a-f]{32}$"#, options: .regularExpression) != nil else { throw Invalid(reason: "noticeId") }
        guard note.utf16.count <= Self.noteMax else { throw Invalid(reason: "note") }
        guard issuedAt > 0 else { throw Invalid(reason: "issuedAt") }
        let parts = [Self.canonicalTag, user, noticeId, Self.noteSha256Hex(note), String(issuedAt)]
        return Data(parts.joined(separator: "|").utf8)
    }

    /// The signed request `.com` takes at `POST /api/users/<u>/abuse-notices/<id>/done`.
    public func request(signedWith key: Curve25519.Signing.PrivateKey) throws -> AbuseNoticeDoneRequest {
        let sig = try key.signature(for: canonicalBytes())
        return AbuseNoticeDoneRequest(
            request: .init(username: username.lowercased(), noticeId: noticeId, note: note, issuedAt: issuedAt),
            signature: sig.map { String(format: "%02x", $0) }.joined()
        )
    }
}

/// Every string the notice banner, the done sheet and the suspended screen show; the webapp's `ABUSE_COPY`.
public enum AbuseCopy {
    public static let bannerTitle = String(localized: "Action needed on your account")
    public static func reported(_ subject: String) -> String { String(localized: "We received a report about \(subject).") }
    public static func reason(_ label: String) -> String { String(localized: "Reason: \(label)") }
    public static let todoModify = String(localized: "What to do: change it so it follows our rules.")
    public static let todoTakeDown = String(localized: "What to do: take it down.")
    public static func deadline(_ date: String) -> String { String(localized: "Deadline: \(date)") }
    public static let warning = String(localized: "If it is still there after the deadline, this account can be suspended.")
    public static let done = String(localized: "I've done this")
    public static let appeal = String(localized: "Appeal")
    public static func markedDone(_ date: String) -> String { String(localized: "Marked done on \(date). We will check it.") }
    public static let doneTitle = String(localized: "Tell us what you changed")
    public static let doneNotePlaceholder = String(localized: "What you changed (optional)")
    public static let send = String(localized: "Send")
    public static let notAdmin = String(localized: "Only an admin device can do this.")
    public static let sendFailed = String(localized: "Couldn't send. Try again.")

    public static let suspendedTitle = String(localized: "This account was suspended")
    public static let suspendedOffline = String(localized: "Your servers are offline to the internet and the account can't add servers or change names until this is resolved.")
    public static let suspendedData = String(localized: "Your data stays on your own server. You can still back it up and move it over your home network, and start again under a new name.")
    public static let suspendedAppeal = String(localized: "If you think this is a mistake, write to abuse@flagship.services. We answer appeals within 14 days.")
    public static let continueToData = String(localized: "Continue to my data")
    public static let suspendedBanner = String(localized: "This account is suspended.")
    public static let details = String(localized: "Details")

    public static func categoryLabel(_ category: String) -> String {
        switch category {
        case "spam": return String(localized: "Spam")
        case "phishing": return String(localized: "Phishing")
        case "active-phishing": return String(localized: "Active phishing")
        case "malware": return String(localized: "Malware")
        case "csam": return String(localized: "Child sexual abuse material")
        case "harassment": return String(localized: "Harassment")
        case "impersonation": return String(localized: "Impersonation")
        case "copyright": return String(localized: "Copyright infringement")
        case "illegal": return String(localized: "Illegal content")
        default: return String(localized: "Other")
        }
    }

    public static let appealEmail = "abuse@flagship.services"

    /// `mailto:abuse@flagship.services?subject=Appeal%20(<username>)`.
    public static func appealURL(username: String?) -> URL {
        let name = (username ?? "").lowercased().filter { $0.isLetter || $0.isNumber || $0 == "-" }
        let subject = name.isEmpty ? "Appeal" : "Appeal%20(\(name))"
        return URL(string: "mailto:\(appealEmail)?subject=\(subject)")!
    }

    public static func formatDate(_ ms: Int64) -> String {
        Date(timeIntervalSince1970: TimeInterval(ms) / 1000).formatted(date: .abbreviated, time: .shortened)
    }
}

/// One notice banner, as plain strings, so a test reads exactly what the admin reads.
public struct AbuseNoticeBannerModel: Equatable, Identifiable {
    public let id: String
    public let title: String
    public let reported: String
    public let reason: String
    public let todo: String
    public let deadline: String
    public let warning: String
    /// The operator's own words, as they are; nil when there are none.
    public let detail: String?
    /// "Marked done on …" once the admin said so; then no "I've done this".
    public let doneLine: String?
    public var showsDoneButton: Bool { doneLine == nil }

    public init(notice n: AbuseNoticeWire, formatDate: (Int64) -> String = AbuseCopy.formatDate) {
        id = n.id
        title = AbuseCopy.bannerTitle
        reported = AbuseCopy.reported(n.subject)
        reason = AbuseCopy.reason(AbuseCopy.categoryLabel(n.category))
        todo = n.action == "take-down" ? AbuseCopy.todoTakeDown : AbuseCopy.todoModify
        deadline = AbuseCopy.deadline(formatDate(n.deadlineAt))
        warning = AbuseCopy.warning
        let d = n.detail?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        detail = d.isEmpty ? nil : d
        doneLine = n.doneAt.map { AbuseCopy.markedDone(formatDate($0)) }
    }

    /// The banners this device shows: notices go to admin devices only.
    public static func banners(_ notices: [AbuseNoticeWire], isAdminDevice: Bool,
                               formatDate: (Int64) -> String = AbuseCopy.formatDate) -> [AbuseNoticeBannerModel] {
        guard isAdminDevice else { return [] }
        return notices.sorted { $0.deadlineAt < $1.deadlineAt }.map { AbuseNoticeBannerModel(notice: $0, formatDate: formatDate) }
    }
}

/// "This account was suspended", as plain strings.
public struct AccountSuspendedModel: Equatable {
    public let title: String
    public let reason: String
    /// The operator's reason, as it is; nil when empty.
    public let operatorReason: String?
    public let offline: String
    public let data: String
    public let appeal: String
    public let appealButton: String
    public let continueButton: String
    public let appealURL: URL

    public init(suspension s: AbuseSuspensionWire, username: String?) {
        title = AbuseCopy.suspendedTitle
        reason = AbuseCopy.reason(AbuseCopy.categoryLabel(s.category))
        let r = s.reason.trimmingCharacters(in: .whitespacesAndNewlines)
        operatorReason = r.isEmpty ? nil : r
        offline = AbuseCopy.suspendedOffline
        data = AbuseCopy.suspendedData
        appeal = AbuseCopy.suspendedAppeal
        appealButton = AbuseCopy.appeal
        continueButton = AbuseCopy.continueToData
        appealURL = AbuseCopy.appealURL(username: username)
    }
}

/// Wakes the notice center (an `abuse-notice` push, a foreground).
public enum AbuseNoticeEvents {
    public static let refresh = Notification.Name("flagship.abuse-notices.refresh")
    @MainActor public static func post() { NotificationCenter.default.post(name: refresh, object: nil) }
}

/// This account's notices and suspension, as `.com` last said. Reads fail silently (the last answer stays).
@MainActor
@Observable
public final class AbuseNoticeCenter {
    public private(set) var notices: [AbuseNoticeWire] = []
    public private(set) var suspension: AbuseSuspensionWire?
    /// "Continue to my data" put the suspended screen aside for this session; the Home banner stays.
    public private(set) var suspendedScreenDismissed = false
    public private(set) var username: String?

    public init() {}

    public var isSuspended: Bool { suspension != nil }
    /// The full-screen view is up: suspended, and not put aside this session.
    public var showsSuspendedScreen: Bool { suspension != nil && !suspendedScreenDismissed }

    public func refresh(username: String?, client: any FlagshipServerClient) async {
        guard let username, !username.isEmpty else {
            reset()
            return
        }
        if username != self.username { reset() }
        self.username = username
        guard let r = try? await client.abuseNotices(username: username), self.username == username else { return }
        apply(r)
    }

    public func apply(_ r: AbuseNoticesResponse) {
        notices = r.notices
        if r.suspension == nil { suspendedScreenDismissed = false }
        suspension = r.suspension
    }

    public func dismissSuspendedScreen() { suspendedScreenDismissed = true }
    public func showSuspendedScreen() { suspendedScreenDismissed = false }

    public func reset() {
        notices = []
        suspension = nil
        suspendedScreenDismissed = false
        username = nil
    }

    public enum DoneOutcome: Equatable { case sent, notAdmin, failed }

    /// Sign and send "I've done this"; on success the notice is re-read.
    public func markDone(noticeId: String, note: String, key: Curve25519.Signing.PrivateKey,
                         client: any FlagshipServerClient, now: Int64 = Int64(Date().timeIntervalSince1970 * 1000)) async -> DoneOutcome {
        guard let username else { return .failed }
        let trimmed = String(note.trimmingCharacters(in: .whitespacesAndNewlines).prefix(AbuseNoticeDone.noteMax))
        do {
            let req = try AbuseNoticeDone(username: username, noticeId: noticeId, note: trimmed, issuedAt: now).request(signedWith: key)
            try await client.markAbuseNoticeDone(req)
        } catch ScreensClientError.http(let status, _) where status == 403 {
            // `.com` refuses a signature that isn't the admin root (or an admin device): `not-admin`.
            return .notAdmin
        } catch {
            return .failed
        }
        if let r = try? await client.abuseNotices(username: username) { apply(r) }
        return .sent
    }
}
