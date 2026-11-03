import Foundation

/// An operator's notice to this account about a reported app, page, link or server, and the account's suspension
/// (docs/abuse-handling.md §4-§5). Read with the account read token from `GET /api/users/<u>/abuse-notices`.
public struct AbuseNoticeWire: Codable, Equatable, Sendable, Identifiable {
    public let id: String
    /// `app`, `page`, `link` or `box`.
    public let subjectKind: String
    /// The reported host or voi.ci address, as the operator wrote it.
    public let subject: String
    public let serviceId: String?
    public let category: String
    /// `modify` or `take-down`.
    public let action: String
    /// The operator's own words, shown as they are.
    public let detail: String?
    public let deadlineAt: Int64
    public let issuedAt: Int64
    public let doneAt: Int64?
    public let doneNote: String?

    public init(
        id: String, subjectKind: String, subject: String, serviceId: String? = nil, category: String, action: String,
        detail: String? = nil, deadlineAt: Int64, issuedAt: Int64, doneAt: Int64? = nil, doneNote: String? = nil
    ) {
        self.id = id; self.subjectKind = subjectKind; self.subject = subject; self.serviceId = serviceId
        self.category = category; self.action = action; self.detail = detail; self.deadlineAt = deadlineAt
        self.issuedAt = issuedAt; self.doneAt = doneAt; self.doneNote = doneNote
    }
}

public struct AbuseSuspensionWire: Codable, Equatable, Sendable {
    public let suspendedAt: Int64
    public let category: String
    /// The operator's reason, shown as it is.
    public let reason: String
    public let appealEmail: String?
    public let appealUrl: String?

    public init(suspendedAt: Int64, category: String, reason: String, appealEmail: String? = nil, appealUrl: String? = nil) {
        self.suspendedAt = suspendedAt; self.category = category; self.reason = reason
        self.appealEmail = appealEmail; self.appealUrl = appealUrl
    }
}

public struct AbuseNoticesResponse: Codable, Equatable, Sendable {
    public let notices: [AbuseNoticeWire]
    public let suspension: AbuseSuspensionWire?

    public init(notices: [AbuseNoticeWire] = [], suspension: AbuseSuspensionWire? = nil) {
        self.notices = notices; self.suspension = suspension
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        notices = try c.decodeIfPresent([AbuseNoticeWire].self, forKey: .notices) ?? []
        suspension = try c.decodeIfPresent(AbuseSuspensionWire.self, forKey: .suspension)
    }
}

/// `POST /api/users/<u>/abuse-notices/<id>/done`: the admin's signed "I've done this" note
/// (`flagship/abuse-notice-done/v1`, FlagshipCore.AbuseNoticeDone), signed with the sensitive-order key.
public struct AbuseNoticeDoneRequest: Codable, Equatable, Sendable {
    public struct Inner: Codable, Equatable, Sendable {
        public let username: String
        public let noticeId: String
        public let note: String
        public let issuedAt: Int64
        public init(username: String, noticeId: String, note: String, issuedAt: Int64) {
            self.username = username; self.noticeId = noticeId; self.note = note; self.issuedAt = issuedAt
        }
    }
    public let request: Inner
    public let signature: String
    public init(request: Inner, signature: String) {
        self.request = request; self.signature = signature
    }
}

extension FlagshipServerClient {
    public func abuseNotices(username: String) async throws -> AbuseNoticesResponse {
        throw ScreensClientError.http(status: 404, message: "")
    }
    public func markAbuseNoticeDone(_ req: AbuseNoticeDoneRequest) async throws {
        throw ScreensClientError.http(status: 404, message: "")
    }
}
