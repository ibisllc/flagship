import Foundation

// App chat between owners (packages/server-daemon/src/chat/approvals.ts):
//   GET  /api/screens/chat/requests          -> { requests, always }
//   POST /api/screens/chat/answer              { requestId, kind, decision, issuedAt, signature }
//   POST /api/screens/chat/always/revoke       { author, slug } -> { ended }

/// `author/slug`. For the sender of an incoming request this is only what the remote machine claims.
public struct ChatAppIdentity: Codable, Equatable, Hashable, Sendable {
    public let author: String
    public let slug: String

    public init(author: String, slug: String) {
        self.author = author
        self.slug = slug
    }

    public var label: String { slug.isEmpty ? author : "\(author)/\(slug)" }
}

public struct ChatRequest: Codable, Equatable, Identifiable, Sendable {
    public let requestId: String
    /// "incoming": another owner's app wants to reach an app here. "outgoing": an app here wants to reach another owner's.
    public let kind: String
    public let claimedSender: ChatAppIdentity
    public let receiverApp: ChatAppIdentity
    /// A short phrase from the sender, shown to admins only. Whatever the remote machine chose to write.
    public let phrase: String?
    public let count: Int
    public let at: Int64

    public init(requestId: String, kind: String, claimedSender: ChatAppIdentity, receiverApp: ChatAppIdentity,
                phrase: String? = nil, count: Int = 1, at: Int64 = 0) {
        self.requestId = requestId
        self.kind = kind
        self.claimedSender = claimedSender
        self.receiverApp = receiverApp
        self.phrase = phrase
        self.count = count
        self.at = at
    }

    public var id: String { "\(kind)|\(requestId)" }
    public var isIncoming: Bool { kind == "incoming" }
}

/// One standing Always allow: a sending account's claimed app may reach an app here without asking.
public struct ChatAlwaysAllow: Codable, Equatable, Hashable, Identifiable, Sendable {
    public let receiverApp: ChatAppIdentity
    public let claimedSender: ChatAppIdentity

    public init(receiverApp: ChatAppIdentity, claimedSender: ChatAppIdentity) {
        self.receiverApp = receiverApp
        self.claimedSender = claimedSender
    }

    public var id: String { "\(claimedSender.label)>\(receiverApp.label)" }
}

/// The body of `POST /api/screens/chat/always/revoke`. No sender ends every Always allow to that app.
public struct ChatRevokeRequest: Codable, Equatable, Sendable {
    public let author: String
    public let slug: String
    public let sender: ChatAppIdentity?

    public init(receiverApp: ChatAppIdentity, sender: ChatAppIdentity?) {
        self.author = receiverApp.author
        self.slug = receiverApp.slug
        self.sender = sender
    }
}

public struct ChatRequestsResponse: Codable, Equatable, Sendable {
    public let requests: [ChatRequest]
    /// Each claimed sender that may reach an app here without asking.
    public let always: [ChatAlwaysAllow]

    public init(requests: [ChatRequest] = [], always: [ChatAlwaysAllow] = []) {
        self.requests = requests
        self.always = always
    }
}

/// The body of `POST /api/screens/chat/answer`: a `flagship/chat-approval/v1` signature by the sensitive-order key.
public struct ChatAnswerRequest: Codable, Equatable, Sendable {
    public let requestId: String
    public let kind: String
    public let decision: String
    public let issuedAt: Int64
    public let signature: String

    public init(requestId: String, kind: String, decision: String, issuedAt: Int64, signature: String) {
        self.requestId = requestId
        self.kind = kind
        self.decision = decision
        self.issuedAt = issuedAt
        self.signature = signature
    }
}

/// Raised when a box says an app chat waits for an admin (a `chat-request` frame on a screens socket). A
/// `generic` push raises `AppAccessEvents.requested`, which the chat alerts listen to as well.
public enum ChatRequestEvents {
    public static let requested = Notification.Name("flagship.chat.requested")
    public static let socketEvent = "chat-request"

    public static func post() {
        NotificationCenter.default.post(name: requested, object: nil)
    }

    public static func isRequestFrame(_ data: Data) -> Bool {
        guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return false }
        return ["kind", "type", "event"].contains { obj[$0] as? String == socketEvent }
    }
}

// MARK: - AI-run consent (packages/server-daemon/src/buildmodes/adaptConsent.ts)

/// What the box says one AI run may cost: a range in tokens, the provider and who pays.
public struct AiCostEstimate: Codable, Equatable, Sendable {
    public let provider: String
    /// "byok": the owner's own key pays. "promo": Flagship Inference credits.
    public let source: String
    public let operation: String
    public let lowTokens: Int64
    public let highTokens: Int64
    public let unit: String?

    public init(provider: String, source: String, operation: String, lowTokens: Int64, highTokens: Int64, unit: String? = "tokens") {
        self.provider = provider
        self.source = source
        self.operation = operation
        self.lowTokens = lowTokens
        self.highTokens = highTokens
        self.unit = unit
    }
}

/// The box's 428 (no consent yet) or 403 (the consent sent was not enough):
/// `{ error, code: "ai-consent", estimate }`.
public struct AiConsentRequired: Equatable, Sendable {
    public let status: Int
    public let reason: String?
    public let estimate: AiCostEstimate

    public init(status: Int, reason: String?, estimate: AiCostEstimate) {
        self.status = status
        self.reason = reason
        self.estimate = estimate
    }

    private struct Body: Decodable {
        let error: String?
        let code: String?
        let estimate: AiCostEstimate?
    }

    public static func from(_ error: Error) -> AiConsentRequired? {
        guard case let ScreensClientError.http(status, message) = error, status == 428 || status == 403,
              let body = try? JSONDecoder().decode(Body.self, from: Data(message.utf8)),
              body.code == "ai-consent", let estimate = body.estimate else { return nil }
        return AiConsentRequired(status: status, reason: body.error, estimate: estimate)
    }
}

/// The `consent` object an adapt request carries once the owner agreed.
public struct AiConsentBody: Codable, Equatable, Sendable {
    public let issuedAt: Int64
    public let provider: String
    public let source: String
    public let highTokens: Int64
    public let signature: String

    public init(issuedAt: Int64, provider: String, source: String, highTokens: Int64, signature: String) {
        self.issuedAt = issuedAt
        self.provider = provider
        self.source = source
        self.highTokens = highTokens
        self.signature = signature
    }
}
