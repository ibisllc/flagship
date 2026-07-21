import Foundation

/// #91 — the daemon→phone alert outbox (`GET /api/phone/alerts`).
///
/// Flagship's trust model has the phone always *initiating* contact — the box
/// never pushes. So an "alert" is an event the daemon queued, waiting for the
/// next time the phone-paired session drains the queue. The app polls
/// `/api/phone/alerts?since=<cursor>` on a foreground interval and ACKs the
/// drained range via `POST /api/phone/alerts/ack { throughId }`.
///
/// This is the iOS mirror of `packages/server-daemon/src/phoneAlerts.ts`. We
/// model only the AI-chat variant the app acts on today (`ai-chat-needs-you`);
/// other kinds (browser-input-needed, membership-reissued, lineage-break, …)
/// decode to `.other` so an unknown/forward-compatible alert never fails the
/// whole response.
public enum PhoneAlert: Sendable, Equatable {
    /// The AI build chat paused and is waiting on the owner. Value-free: the
    /// session id, what the AI is waiting on, and the pending tool-use id. The
    /// human-readable question / env-var name is fetched over the paired-session
    /// BFF when the owner opens the chat.
    case aiChatNeedsYou(sessionId: String, request: AiChatRequest, toolUseId: String)
    /// Any other daemon alert kind — surfaced by its own feature, not here.
    case other(kind: String)

    public enum AiChatRequest: String, Sendable, Equatable {
        case requestEnvVar
        case talkToUser
    }

    public var aiChat: (sessionId: String, request: AiChatRequest, toolUseId: String)? {
        if case let .aiChatNeedsYou(sessionId, request, toolUseId) = self {
            return (sessionId, request, toolUseId)
        }
        return nil
    }
}

/// One envelope in the alert queue: the monotonic id + when it was queued + the
/// alert. The id is the ACK cursor.
public struct PhoneAlertEnvelope: Sendable, Equatable {
    public let id: Int
    public let emittedAt: Int
    public let alert: PhoneAlert

    public init(id: Int, emittedAt: Int, alert: PhoneAlert) {
        self.id = id
        self.emittedAt = emittedAt
        self.alert = alert
    }
}

/// `GET /api/phone/alerts` response shape.
public struct PhoneAlertsResponse: Sendable, Equatable {
    public let events: [PhoneAlertEnvelope]
    public let size: Int

    public init(events: [PhoneAlertEnvelope], size: Int) {
        self.events = events
        self.size = size
    }
}

// MARK: - Decoding (lenient on unknown kinds)

extension PhoneAlert: Decodable {
    private enum CodingKeys: String, CodingKey {
        case kind, serviceId, request, toolUseId
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let kind = try c.decode(String.self, forKey: .kind)
        switch kind {
        case "ai-chat-needs-you":
            let sessionId = try c.decode(String.self, forKey: .serviceId)
            let requestRaw = try c.decode(String.self, forKey: .request)
            let toolUseId = try c.decodeIfPresent(String.self, forKey: .toolUseId) ?? ""
            let request = AiChatRequest(rawValue: requestRaw) ?? .talkToUser
            self = .aiChatNeedsYou(sessionId: sessionId, request: request, toolUseId: toolUseId)
        default:
            self = .other(kind: kind)
        }
    }
}

extension PhoneAlertEnvelope: Decodable {
    private enum CodingKeys: String, CodingKey {
        case id, emittedAt, alert
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.id = try c.decode(Int.self, forKey: .id)
        self.emittedAt = try c.decodeIfPresent(Int.self, forKey: .emittedAt) ?? 0
        self.alert = try c.decode(PhoneAlert.self, forKey: .alert)
    }
}

extension PhoneAlertsResponse: Decodable {
    private enum CodingKeys: String, CodingKey {
        case events, size
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.events = try c.decodeIfPresent([PhoneAlertEnvelope].self, forKey: .events) ?? []
        self.size = try c.decodeIfPresent(Int.self, forKey: .size) ?? self.events.count
    }
}
