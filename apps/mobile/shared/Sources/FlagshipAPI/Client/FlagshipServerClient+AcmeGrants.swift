import Foundation

// #28 — ACME account-key grant mint POST.
//
// Wire contract mirrored from packages/control-plane/src/acmeAccountKeys.ts
// (`handleMintAcmeAccountKeyGrant`), served by apps/com:
//
//   POST /api/users/<u>/acme-account-keys
//   body: { grant: { grantId, username, accountKeyId,
//                    recipientPubKey: <hex32>, sealedAccountKey: <hex>,
//                    issuedAt, expiresAt },
//           signature: <hex64> }            // Ed25519 by account IRK
//   200:  { ok, grantId, username, accountKeyId, recipientPubKey, expiresAt }
//
// THE SEALED KEY IS DELIVERED IN THE REQUEST, never echoed in the reply. The
// envelope is built + IRK-signed on-device by `AcmeAccountKeyGrantProducer`
// (Flagship module); this file is purely the transport. It lives in a
// SEPARATE file from FlagshipServerClient.swift on purpose — that file is
// owned by another worker.
//
// These wire types deliberately re-declare the grant fields as primitive
// (hex) strings rather than importing the Flagship-module `AcmeAccountKeyGrant`
// struct: FlagshipAPI is the LEAF package (FlagshipCore depends on it, not the
// reverse), so it cannot see the producer's types. The caller hexifies the
// signed grant and hands it here.

/// Request body for `POST /api/users/:u/acme-account-keys`.
public struct AcmeAccountKeyGrantMintRequest: Codable, Equatable, Sendable {
    public struct Grant: Codable, Equatable, Sendable {
        public let grantId: String
        public let username: String
        /// sha256-hex of the ACME account PUBLIC key.
        public let accountKeyId: String
        /// The recipient box STK Ed25519 pubkey, lowercased hex (32 bytes).
        public let recipientPubKey: String
        /// The ACME account key sealed to `recipientPubKey`, lowercased hex.
        public let sealedAccountKey: String
        public let issuedAt: Int64
        public let expiresAt: Int64

        public init(
            grantId: String,
            username: String,
            accountKeyId: String,
            recipientPubKey: String,
            sealedAccountKey: String,
            issuedAt: Int64,
            expiresAt: Int64
        ) {
            self.grantId = grantId
            self.username = username
            self.accountKeyId = accountKeyId
            self.recipientPubKey = recipientPubKey
            self.sealedAccountKey = sealedAccountKey
            self.issuedAt = issuedAt
            self.expiresAt = expiresAt
        }
    }

    public let grant: Grant
    /// Lowercased hex; Ed25519 by the account IRK over the grant's canonical
    /// bytes (`flagship/acme-account-key-grant/v1|...`).
    public let signature: String

    public init(grant: Grant, signature: String) {
        self.grant = grant
        self.signature = signature
    }
}

/// Success body for `POST /api/users/:u/acme-account-keys`. PUBLIC fields
/// only — the sealed key is intentionally absent (a read is not a delivery
/// channel).
public struct AcmeAccountKeyGrantMintResponse: Codable, Equatable, Sendable {
    public let ok: Bool
    public let grantId: String
    public let username: String
    public let accountKeyId: String
    public let recipientPubKey: String
    public let expiresAt: Int64

    public init(
        ok: Bool,
        grantId: String,
        username: String,
        accountKeyId: String,
        recipientPubKey: String,
        expiresAt: Int64
    ) {
        self.ok = ok
        self.grantId = grantId
        self.username = username
        self.accountKeyId = accountKeyId
        self.recipientPubKey = recipientPubKey
        self.expiresAt = expiresAt
    }
}

public extension LiveFlagshipServerClient {
    /// POST a signed, box-sealed ACME account-key grant to `.com`.
    ///
    /// The full request body is built on-device by
    /// `AcmeAccountKeyGrantProducer` and hexified into
    /// `AcmeAccountKeyGrantMintRequest`. A non-2xx is surfaced as
    /// `ScreensClientError.http` (a 403 collapses "bad signature" and "bad
    /// envelope" — the Worker never distinguishes them to a network peer).
    ///
    /// `baseUrl` / `urlSession` are passed in (defaulting to the production
    /// host + shared session) because the live client's stored properties are
    /// private; this extension lives in a separate file owned by a different
    /// worker, so it cannot reach them. Callers that constructed the client
    /// with a non-default base URL should pass the same one here.
    func mintAcmeAccountKeyGrant(
        username: String,
        body: AcmeAccountKeyGrantMintRequest,
        baseUrl: URL = LiveFlagshipServerClient.defaultBaseUrl,
        urlSession: URLSession = .shared
    ) async throws -> AcmeAccountKeyGrantMintResponse {
        let encoded = username.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? username
        let url = baseUrl.appendingPathComponent("/api/users/\(encoded)/acme-account-keys")
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "content-type")
        req.httpBody = try JSONEncoder().encode(body)
        let (data, resp) = try await urlSession.data(for: req)
        let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            let text = String(data: data, encoding: .utf8) ?? ""
            throw ScreensClientError.http(status: status, message: text)
        }
        return try JSONDecoder().decode(AcmeAccountKeyGrantMintResponse.self, from: data)
    }
}
