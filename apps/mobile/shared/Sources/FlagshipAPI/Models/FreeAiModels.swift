import Foundation

/// Flagship Inference: AI Flagship hosts so an owner can try building apps
/// without their own AI key. `.com` mints a short-lived token for the
/// account (`POST /api/free-ai/token`); the box calls Flagship's inference
/// endpoint with it. MIRRORS the webapp `lib/freeAi.js` and Android
/// `core/FreeAiCredits.kt`.

/// The account's free AI allowance, in weighted tokens: a weekly top-up
/// (spent first; resets Monday 00:00 UTC, the rest doesn't carry over) and a
/// one-time starter reserve. `week` / `starter` and the credit fields are
/// absent from an older `.com`; the token totals are always there. The apps
/// show credits: one credit is 1,000 weighted tokens.
public struct FreeAiCredits: Codable, Equatable, Sendable {
    public struct Week: Codable, Equatable, Sendable {
        public let used: Int64
        public let allowance: Int64
        public let remaining: Int64
        /// Epoch ms of the next top-up (Monday 00:00 UTC).
        public let resetsAt: Int64?
        public init(used: Int64, allowance: Int64, remaining: Int64, resetsAt: Int64? = nil) {
            self.used = used
            self.allowance = allowance
            self.remaining = remaining
            self.resetsAt = resetsAt
        }
    }

    public struct Starter: Codable, Equatable, Sendable {
        public let used: Int64
        public let allowance: Int64
        public let remaining: Int64
        public init(used: Int64, allowance: Int64, remaining: Int64) {
            self.used = used
            self.allowance = allowance
            self.remaining = remaining
        }
    }

    public let week: Week?
    public let starter: Starter?
    public let usedTokens: Int64
    public let allowanceTokens: Int64
    public let remainingTokens: Int64
    /// The week's and the starter's credits left together.
    public let remainingCredits: Int64?
    /// The weekly top-up in credits.
    public let weeklyCredits: Int64?
    public let tokensPerCredit: Int64?
    public init(usedTokens: Int64, allowanceTokens: Int64, remainingTokens: Int64,
                week: Week? = nil, starter: Starter? = nil,
                remainingCredits: Int64? = nil, weeklyCredits: Int64? = nil, tokensPerCredit: Int64? = nil) {
        self.usedTokens = usedTokens
        self.allowanceTokens = allowanceTokens
        self.remainingTokens = remainingTokens
        self.week = week
        self.starter = starter
        self.remainingCredits = remainingCredits
        self.weeklyCredits = weeklyCredits
        self.tokensPerCredit = tokensPerCredit
    }

    /// One credit is this many weighted tokens.
    public static let defaultTokensPerCredit: Int64 = 1000

    private var perCredit: Int64 {
        if let t = tokensPerCredit, t > 0 { return t }
        return Self.defaultTokensPerCredit
    }

    /// Credits left: `.com`'s number, or converted from tokens (older `.com`).
    public var creditsLeft: Int64 {
        if let r = remainingCredits { return max(0, r) }
        return max(0, remainingTokens) / perCredit
    }

    /// The weekly top-up in credits, nil when `.com` doesn't say.
    public var creditsPerWeek: Int64? {
        if let w = weeklyCredits { return max(0, w) }
        if let w = week { return max(0, w.allowance) / perCredit }
        return nil
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

/// `POST /api/free-ai/status` → 200. `ended` (the promotion is over: hide
/// free AI), `reason` ("no-server" / "busy-today": why it can't be used right
/// now) and `message` are absent from an older `.com`.
public struct FreeAiStatusResponse: Codable, Equatable, Sendable {
    public let available: Bool
    public let ended: Bool?
    public let reason: String?
    public let message: String?
    public let credits: FreeAiCredits?
    public init(available: Bool, credits: FreeAiCredits?, ended: Bool? = nil,
                reason: String? = nil, message: String? = nil) {
        self.available = available
        self.credits = credits
        self.ended = ended
        self.reason = reason
        self.message = message
    }
}

/// A refusal body: `{ error, code, credits? }`.
public struct FreeAiErrorBody: Codable, Equatable, Sendable {
    public let error: String?
    public let code: String?
    public let credits: FreeAiCredits?
}

public enum FreeAiError: Error, Equatable, LocalizedError {
    /// 429 `free-ai-used-up`: this week's top-up and the reserve are spent.
    case usedUp(message: String, credits: FreeAiCredits?)
    /// 429 `free-ai-busy-today`: every account together hit today's cap.
    case busyToday(message: String)
    /// 403 `free-ai-no-server`: no running server on the account.
    case noServer(message: String)
    /// 410 `free-ai-ended`: the promotion is over.
    case ended(message: String)
    /// 503 `free-ai-unavailable` (or not offered by this client).
    case unavailable(message: String)
    /// 400 `free-ai-too-long`: the build is bigger than the model's context.
    case tooLong(message: String)
    /// 429 `rate-limited`: too many tries; says when to try again.
    case rateLimited(RateLimitedRefusal)

    public var errorDescription: String? { message }

    public var message: String {
        switch self {
        case .usedUp(let m, _), .busyToday(let m), .noServer(let m), .ended(let m), .unavailable(let m),
             .tooLong(let m): return m
        case .rateLimited(let r): return r.message
        }
    }

    /// At the start of a build, every refusal but "unavailable" sends the
    /// owner to add their own key.
    public var opensAddKey: Bool {
        if case .unavailable = self { return false }
        return true
    }

    /// Map a non-2xx answer from `/api/free-ai/*` onto a FreeAiError by its
    /// `code` (the status only when there's none), or nil when it isn't a
    /// documented refusal.
    public static func from(status: Int, body: Data) -> FreeAiError? {
        if let r = RateLimitedRefusal.from(status: status, body: body) { return .rateLimited(r) }
        let parsed = try? JSONDecoder().decode(FreeAiErrorBody.self, from: body)
        switch parsed?.code {
        case "free-ai-used-up": return .usedUp(message: parsed?.error ?? FreeAiCopy.usedUp, credits: parsed?.credits)
        case "free-ai-busy-today": return .busyToday(message: parsed?.error ?? FreeAiCopy.busyToday)
        case "free-ai-no-server": return .noServer(message: parsed?.error ?? FreeAiCopy.noServer)
        case "free-ai-ended": return .ended(message: parsed?.error ?? FreeAiCopy.ended)
        case "free-ai-unavailable": return .unavailable(message: parsed?.error ?? FreeAiCopy.unavailable)
        case "free-ai-too-long": return .tooLong(message: parsed?.error ?? FreeAiCopy.tooLong)
        default: break
        }
        switch status {
        case 429: return .usedUp(message: parsed?.error ?? FreeAiCopy.usedUp, credits: parsed?.credits)
        case 410: return .ended(message: parsed?.error ?? FreeAiCopy.ended)
        case 503: return .unavailable(message: parsed?.error ?? FreeAiCopy.unavailable)
        default: return nil
        }
    }
}

/// What free AI shows for a status read. MIRRORS the webapp `freeAiView`.
public enum FreeAiDisplay: Equatable, Sendable {
    /// Unreadable, or the promotion has ended: show nothing.
    case hidden
    /// Can be used now.
    case usable(FreeAiCredits)
    /// Can't be used now: why, and whether to offer "Add your own key".
    case blocked(message: String, offerOwnKey: Bool)

    public static func of(_ s: FreeAiStatusResponse?) -> FreeAiDisplay {
        guard let s, s.ended != true else { return .hidden }
        guard s.available else { return .blocked(message: FreeAiCopy.unavailable, offerOwnKey: true) }
        switch s.reason {
        case "no-server": return .blocked(message: FreeAiCopy.noServer, offerOwnKey: false)
        case "busy-today": return .blocked(message: FreeAiCopy.busyToday, offerOwnKey: true)
        case let r? where !r.isEmpty: return .blocked(message: s.message ?? FreeAiCopy.unavailable, offerOwnKey: true)
        default: break
        }
        guard let c = s.credits else { return .hidden }
        return c.remainingTokens > 0 ? .usable(c) : .blocked(message: FreeAiCopy.usedUp, offerOwnKey: true)
    }
}

/// The Flagship Inference entry in the key lists: always present, never
/// deletable. Unlike `FreeAiDisplay`, an unreadable status or an ended
/// promotion still shows the entry, disabled, with the reason.
/// MIRRORS the webapp `freeAiEntryState` and Android `FreeAiCopy.entry`.
public enum FreeAiEntryState: Equatable, Sendable {
    case loading
    case usable(FreeAiCredits)
    case disabled(message: String, offerOwnKey: Bool)

    public var isUsable: Bool {
        if case .usable = self { return true }
        return false
    }

    public static func of(_ s: FreeAiStatusResponse?) -> FreeAiEntryState {
        guard let s else { return .disabled(message: FreeAiCopy.unavailable, offerOwnKey: true) }
        if s.ended == true { return .disabled(message: FreeAiCopy.ended, offerOwnKey: true) }
        switch FreeAiDisplay.of(s) {
        case .usable(let c): return .usable(c)
        case .blocked(let m, let offer): return .disabled(message: m, offerOwnKey: offer)
        case .hidden: return .disabled(message: FreeAiCopy.unavailable, offerOwnKey: true)
        }
    }

    /// A refusal from `.com` while reading or minting.
    public static func of(_ e: FreeAiError) -> FreeAiEntryState {
        switch e {
        case .ended: return .disabled(message: FreeAiCopy.ended, offerOwnKey: true)
        case .noServer(let m): return .disabled(message: m, offerOwnKey: false)
        default: return .disabled(message: e.message, offerOwnKey: true)
        }
    }
}

/// The words, shared with the webapp and Android. Nothing here is sold, so
/// none of it says buy, upgrade or purchase.
public enum FreeAiCopy {
    public static let title = "Flagship Inference"
    /// The built-in provider entry, first in every key list.
    public static let providerTitle = "Flagship Inference"
    public static let providerSubtitle = "We use third-party providers and anonymize your requests."
    public static let builtInAccessibility = "Built-in provider. It can't be removed."
    public static let useButton = "Use Flagship Inference →"
    public static let tooLong = "This build is too big for Flagship Inference. Try a smaller change, or use your own AI key."
    public static let note = "Used automatically when you build with AI and haven't added your own key."
    public static let usedUp = "You've used this week's Flagship Inference credits. More arrive on Monday, or add your own AI key to keep building."
    public static let busyToday = "Flagship Inference is busy today. Try again tomorrow, or use your own AI key."
    public static let noServer = "Flagship Inference starts once one of your servers is running."
    public static let ended = "The free building period has ended — use your own AI key."
    public static let unavailable = "Flagship Inference isn't available right now. You can add your own AI key."
    public static let couldNotMint = "Couldn't reach Flagship Inference. Try again, or add your own AI key."
    public static let addOwnKey = "Add your own key"

    /// A whole number with the locale's thousands separators: 1840 → "1,840".
    public static func credits(_ n: Int64, locale: Locale = .current) -> String {
        let f = NumberFormatter()
        f.locale = locale
        f.numberStyle = .decimal
        f.maximumFractionDigits = 0
        return f.string(from: NSNumber(value: max(0, n))) ?? String(max(0, n))
    }

    /// "1,840 free credits left · 500 added each week" ("1,840 free credits
    /// left" from an older `.com` without the weekly split). The only line
    /// that says "free", so it can go when the promotion ends. Settings and
    /// the key step show the same line.
    public static func balance(_ c: FreeAiCredits, locale: Locale = .current) -> String {
        let left = "\(credits(c.creditsLeft, locale: locale)) free credits left"
        guard let weekly = c.creditsPerWeek else { return left }
        return "\(left) · \(credits(weekly, locale: locale)) added each week"
    }
}
