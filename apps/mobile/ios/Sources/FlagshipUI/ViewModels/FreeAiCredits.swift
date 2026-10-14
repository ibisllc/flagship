import Foundation
import Observation
import CryptoKit
import Flagship
import FlagshipAPI

/// Free AI credits (docs/build-modes.md): signs the account's
/// `flagship/llm-promo-issue/v1` request with the IRK (the same key and
/// biometric path as push registration) and asks `.com` for the balance or a
/// short-lived credential for one box. The credential is never saved: every
/// send that uses free AI mints a fresh one (they last 12 h).
///
/// MIRRORS the webapp `lib/freeAi.js` and Android `core/FreeAiCredits.kt`.
@MainActor
public final class FreeAiCreditsService {
    public typealias Signer = @MainActor (Data) async throws -> Data

    private let client: any FlagshipServerClient
    private let username: @MainActor () -> String?
    private let sign: Signer
    private let now: () -> Int64

    public init(
        client: any FlagshipServerClient,
        username: @escaping @MainActor () -> String?,
        sign: Signer? = nil,
        now: @escaping () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) }
    ) {
        self.client = client
        self.username = username
        self.sign = sign ?? { bytes in
            let irk = try await Keystore.deriveIRK(reason: "Use Flagship Inference")
            return try irk.signature(for: bytes)
        }
        self.now = now
    }

    private func signed(serverFqdn: String) async throws -> FreeAiSignedRequest {
        guard let user = username(), !user.isEmpty else {
            throw FreeAiError.unavailable(message: FreeAiCopy.unavailable)
        }
        let req = FreeAiIssueRequest(username: user, serverFqdn: serverFqdn, issuedAt: now())
        let sig = try await sign(req.canonicalBytes())
        return FreeAiSignedRequest(request: req, signature: sig.map { String(format: "%02x", $0) }.joined())
    }

    public func status() async throws -> FreeAiStatusResponse {
        try await client.freeAiStatus(signed(serverFqdn: ""))
    }

    /// A fresh free-AI credential for the box `serverFqdn`, with the model
    /// the box should ask for.
    public func mint(serverFqdn: String) async throws -> FreeAiTokenResponse {
        try await client.freeAiToken(signed(serverFqdn: serverFqdn))
    }
}

/// The build sessions driven by free AI, so a later reply or deploy re-mints
/// instead of sending a saved key. Kept in UserDefaults so a reopened session
/// still knows (bounded; the oldest fall off).
@MainActor
public enum FreeAiSessions {
    private static let key = "flagship.freeAi.sessions.v1"
    private static let limit = 50
    static var defaults: UserDefaults = .standard

    public static func mark(_ sessionId: String) {
        var ids = defaults.stringArray(forKey: key) ?? []
        ids.removeAll { $0 == sessionId }
        ids.append(sessionId)
        if ids.count > limit { ids.removeFirst(ids.count - limit) }
        defaults.set(ids, forKey: key)
    }

    public static func isFreeAi(_ sessionId: String) -> Bool {
        (defaults.stringArray(forKey: key) ?? []).contains(sessionId)
    }

    public static func clear() { defaults.removeObject(forKey: key) }
}

/// The Settings → AI keys "Flagship Inference" entry: always shown, disabled
/// with the reason when free AI can't be used. MIRRORS the webapp
/// `freeAiEntryHtml`.
@MainActor
@Observable
public final class FreeAiCreditsCardModel {
    public private(set) var state: FreeAiEntryState = .loading
    private let service: FreeAiCreditsService?

    public init(service: FreeAiCreditsService?) {
        self.service = service
    }

    public func load() async {
        guard let service else { state = .of(nil as FreeAiStatusResponse?); return }
        do {
            state = Self.state(for: try await service.status())
        } catch let e as FreeAiError {
            state = .of(e)
        } catch {
            state = .of(nil as FreeAiStatusResponse?)
        }
    }

    static func state(for s: FreeAiStatusResponse?) -> FreeAiEntryState { .of(s) }
}
