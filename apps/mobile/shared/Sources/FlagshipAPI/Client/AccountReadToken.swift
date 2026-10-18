import Foundation

/// Account read tokens (docs/account-read-token.md). `.com` serves an
/// account's servers (`/pods`, `/stream`), device history (`/audit`) and app
/// names (`/apps/aliases`, `/apps/<id>/links`) only with
/// `Authorization: Bearer <token>`; demo accounts need none.
public protocol AccountReadTokenSource: Sendable {
    /// A token for `username`, or nil to send none (a demo account, or no
    /// key at hand without a prompt).
    func token(for username: String) async -> String?
    /// `.com` refused the last token: a fresh one if it can be minted
    /// without a prompt, else nil.
    func tokenAfterRejection(for username: String) async -> String?
}

public struct AccountReadTokenResponse: Codable, Equatable, Sendable {
    public let token: String
    public let expiresAt: Int64
    public init(token: String, expiresAt: Int64) {
        self.token = token
        self.expiresAt = expiresAt
    }
}

/// What a read token is minted with: this device's signed account-directory
/// request over `POST /api/accounts/<u>/read-token`, or an IRK-signed
/// device-endpoint claim labelled `account-read-token`.
public enum AccountReadTokenCredential: Sendable {
    case device(AccountDirectoryAuthorization)
    case irk(MailboxAuthEnvelope)

    public static let irkEndpointLabel = "account-read-token"

    public static func path(username: String) -> String {
        "/api/accounts/\(username.lowercased())/read-token"
    }
}

public protocol AccountReadTokenMinting: Sendable {
    func mintAccountReadToken(username: String, credential: AccountReadTokenCredential) async throws -> AccountReadTokenResponse
}

public final class LiveAccountReadTokenMinter: AccountReadTokenMinting, @unchecked Sendable {
    private let urlSession: URLSession
    private let baseUrl: URL

    public init(urlSession: URLSession = .shared, baseUrl: URL = Endpoints.controlBaseUrl) {
        self.urlSession = urlSession
        self.baseUrl = baseUrl
    }

    public func mintAccountReadToken(username: String, credential: AccountReadTokenCredential) async throws -> AccountReadTokenResponse {
        guard let url = URL(string: baseUrl.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
            + AccountReadTokenCredential.path(username: username)) else {
            throw ScreensClientError.http(status: 0, message: "bad read-token URL")
        }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "content-type")
        req.cachePolicy = .reloadIgnoringLocalCacheData
        switch credential {
        case .device(let a):
            req.setValue(a.deviceId, forHTTPHeaderField: "x-flagship-device-id")
            req.setValue(a.signerPubHex, forHTTPHeaderField: "x-flagship-device-pub")
            req.setValue(a.requestId, forHTTPHeaderField: "x-flagship-request-id")
            req.setValue(String(a.issuedAt), forHTTPHeaderField: "x-flagship-issued-at")
            req.setValue(a.signatureHex, forHTTPHeaderField: "x-flagship-signature")
            req.httpBody = Data("{}".utf8)
        case .irk(let envelope):
            req.httpBody = try JSONEncoder().encode(envelope)
        }
        let (data, resp) = try await urlSession.gatedData(for: req)
        let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            throw ScreensClientError.http(status: status, message: String(data: data, encoding: .utf8) ?? "")
        }
        return try JSONDecoder().decode(AccountReadTokenResponse.self, from: data)
    }
}

/// Send one private per-account read: with the account's read token, and on
/// a 401 once more with a fresh one when it can be had without a prompt.
public func sendAccountRead(
    _ request: URLRequest,
    username: String,
    tokens: (any AccountReadTokenSource)?,
    send: (URLRequest) async throws -> (Data, URLResponse)
) async throws -> (data: Data, status: Int) {
    var req = request
    if let token = await tokens?.token(for: username) {
        req.setValue("Bearer \(token)", forHTTPHeaderField: "authorization")
    }
    var (data, resp) = try await send(req)
    var status = (resp as? HTTPURLResponse)?.statusCode ?? 0
    if status == 401, let tokens, let fresh = await tokens.tokenAfterRejection(for: username) {
        req.setValue("Bearer \(fresh)", forHTTPHeaderField: "authorization")
        (data, resp) = try await send(req)
        status = (resp as? HTTPURLResponse)?.statusCode ?? 0
    }
    return (data, status)
}
