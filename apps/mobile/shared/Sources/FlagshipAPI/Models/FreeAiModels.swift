import Foundation

/// Free AI credits: tokens Flagship hosts so an owner can try building apps
/// without their own AI key. `.com` mints a short-lived token for the
/// account (`POST /api/free-ai/token`); the box calls Flagship's inference
/// endpoint with it. MIRRORS the webapp `lib/freeAi.js` and Android
/// `core/FreeAiCredits.kt`.

/// The account's free AI allowance, in tokens.
public struct FreeAiCredits: Codable, Equatable, Sendable {
    public let usedTokens: Int64
    public let allowanceTokens: Int64
    public let remainingTokens: Int64
    public init(usedTokens: Int64, allowanceTokens: Int64, remainingTokens: Int64) {
        self.usedTokens = usedTokens
        self.allowanceTokens = allowanceTokens
        self.remainingTokens = remainingTokens
    }
}

/// The IRK-signed request both `/api/free-ai/token` and `/api/free-ai/status`
/// take (`flagship/llm-promo-issue/v1`). Free AI always sends provider
/// "flagship" and both caps 0; `serverFqdn` is the box the build runs on, or
/// empty for a status read.
///
/// packages/protocol/test-vectors/llm-promo-issue/vectors.json is the
/// reference; FreeAiVectorTests runs every case.
public struct FreeAiIssueRequest: Codable, Equatable, Sendable {
    public static let canonicalTag = "flagship/llm-promo-issue/v1"
    public static let provider = "flagship"

    public let username: String
    public let serverFqdn: String
    public let provider: String
    public let desiredDailyInputTokenCap: Int64
    public let desiredDailyOutputTokenCap: Int64
    public let issuedAt: Int64

    public init(username: String, serverFqdn: String, issuedAt: Int64,
                provider: String = FreeAiIssueRequest.provider,
                desiredDailyInputTokenCap: Int64 = 0, desiredDailyOutputTokenCap: Int64 = 0) {
        self.username = username
        self.serverFqdn = serverFqdn
        self.provider = provider
        self.desiredDailyInputTokenCap = desiredDailyInputTokenCap
        self.desiredDailyOutputTokenCap = desiredDailyOutputTokenCap
        self.issuedAt = issuedAt
    }

    public func canonicalBytes() -> Data {
        Data([
            Self.canonicalTag, username, serverFqdn, provider,
            String(desiredDailyInputTokenCap), String(desiredDailyOutputTokenCap), String(issuedAt),
        ].joined(separator: "|").utf8)
    }
}

public struct FreeAiSignedRequest: Codable, Equatable, Sendable {
    public let request: FreeAiIssueRequest
    /// Ed25519 signature over `request.canonicalBytes()`, lowercase hex.
    public let signature: String
    public init(request: FreeAiIssueRequest, signature: String) {
        self.request = request
        self.signature = signature
    }
}

/// `POST /api/free-ai/token` → 200.
public struct FreeAiTokenResponse: Codable, Equatable, Sendable {
    public let ok: Bool?
    /// provider "flagship", the scoped token as apiKey, the endpoint as
    /// baseUrl, source "promo", relay on.
    public let credential: LlmProviderCredential
    public let model: String?
    public let expiresAt: Int64?
    public let credits: FreeAiCredits?
    public init(ok: Bool? = true, credential: LlmProviderCredential, model: String?,
                expiresAt: Int64?, credits: FreeAiCredits?) {
        self.ok = ok
        self.credential = credential
        self.model = model
        self.expiresAt = expiresAt
        self.credits = credits
    }
}

/// `POST /api/free-ai/status` → 200.
public struct FreeAiStatusResponse: Codable, Equatable, Sendable {
    public let available: Bool
    public let credits: FreeAiCredits?
    public init(available: Bool, credits: FreeAiCredits?) {
        self.available = available
        self.credits = credits
    }
}

/// The 429 / 503 body: `{ error, code, credits? }`.
public struct FreeAiErrorBody: Codable, Equatable, Sendable {
    public let error: String?
    public let code: String?
    public let credits: FreeAiCredits?
}

public enum FreeAiError: Error, Equatable, LocalizedError {
    /// 429 `free-ai-used-up`: nothing left; bring your own key.
    case usedUp(message: String, credits: FreeAiCredits?)
    /// 503 `free-ai-unavailable` (or not offered by this client).
    case unavailable(message: String)

    public var errorDescription: String? {
        switch self {
        case .usedUp(let m, _): return m
        case .unavailable(let m): return m
        }
    }

    /// Map a non-2xx answer from `/api/free-ai/*` onto a FreeAiError, or nil
    /// when it isn't one of the two documented refusals.
    public static func from(status: Int, body: Data) -> FreeAiError? {
        let parsed = try? JSONDecoder().decode(FreeAiErrorBody.self, from: body)
        if status == 429 || parsed?.code == "free-ai-used-up" {
            return .usedUp(message: parsed?.error ?? FreeAiCopy.usedUp, credits: parsed?.credits)
        }
        if status == 503 || parsed?.code == "free-ai-unavailable" {
            return .unavailable(message: parsed?.error ?? FreeAiCopy.unavailable)
        }
        return nil
    }
}

/// The words, shared with the webapp and Android. Nothing here is sold, so
/// none of it says buy, upgrade or purchase.
public enum FreeAiCopy {
    public static let title = "Free AI credits"
    public static let note = "Used automatically when you build with AI and haven't added your own key."
    public static let usedUp = "Your free AI credits are used up. Add your own AI key to keep building."
    public static let usedUpSettings = "You've used your free AI credits. Add your own AI key to keep building."
    public static let unavailable = "Free AI credits aren't available right now. You can add your own AI key."
    public static let addOwnKey = "Add your own key"

    /// 820000 → "820k", 1000000 → "1M", 1500000 → "1.5M", 999 → "999".
    public static func tokens(_ n: Int64) -> String {
        let v = max(0, n)
        if v < 1_000 { return String(v) }
        if v < 1_000_000 { return "\(Int64((Double(v) / 1_000).rounded()))k" }
        var s = String(format: "%.1f", Double(v) / 1_000_000)
        if s.hasSuffix(".0") { s.removeLast(2) }
        return s + "M"
    }

    /// "820k of 1M free AI tokens left".
    public static func balance(_ c: FreeAiCredits) -> String {
        "\(tokens(c.remainingTokens)) of \(tokens(c.allowanceTokens)) free AI tokens left"
    }

    /// The key-step row's subtitle: "820k left".
    public static func left(_ c: FreeAiCredits) -> String { "\(tokens(c.remainingTokens)) left" }
}
