import Foundation

/// Name dibs client (`.com`) — mirrors the webapp's `lib/nameDibs.js` wire
/// bodies exactly:
///
///   GET  /api/name-dibs/window     public
///   POST /api/name-dibs/initiate   IRK-signed `{ request, signature }`
///   POST /api/name-dibs/verify     IRK-signed `{ request, signature }`
///
/// Wire types are pure; the view model signs with the IRK via `FlagshipCore`.
public protocol NameDibsClient: Sendable {
    func window() async throws -> DibsWindow
    func initiate(_ body: DibsInitiateBody) async throws -> DibsClaim
    func verify(_ body: DibsVerifyBody) async throws -> DibsVerifyResult
}

public struct DibsWindow: Decodable, Equatable, Sendable {
    public let configured: Bool
    public let open: Bool
    public let start: Int64?
    public let end: Int64?
    public let priceUsd: Int?
    public init(configured: Bool, open: Bool, start: Int64?, end: Int64?, priceUsd: Int? = 20) {
        self.configured = configured; self.open = open; self.start = start; self.end = end; self.priceUsd = priceUsd
    }
}

public struct DibsInitiateRequest: Codable, Equatable, Sendable {
    public let username: String
    public let name: String
    public let irkPubHex: String
    public let issuedAt: Int64
    public init(username: String, name: String, irkPubHex: String, issuedAt: Int64) {
        self.username = username; self.name = name; self.irkPubHex = irkPubHex; self.issuedAt = issuedAt
    }
}

public struct DibsInitiateBody: Encodable, Equatable, Sendable {
    public let request: DibsInitiateRequest
    public let signature: String
    public init(request: DibsInitiateRequest, signature: String) { self.request = request; self.signature = signature }
}

public struct DibsVerifyRequest: Codable, Equatable, Sendable {
    public let username: String
    public let name: String
    public let nonce: String
    public let issuedAt: Int64
    public init(username: String, name: String, nonce: String, issuedAt: Int64) {
        self.username = username; self.name = name; self.nonce = nonce; self.issuedAt = issuedAt
    }
}

public struct DibsVerifyBody: Encodable, Equatable, Sendable {
    public let request: DibsVerifyRequest
    public let signature: String
    public init(request: DibsVerifyRequest, signature: String) { self.request = request; self.signature = signature }
}

/// `.com`'s answer to initiate: what to publish and where.
public struct DibsClaim: Decodable, Equatable, Sendable {
    public struct PublishAt: Decodable, Equatable, Sendable {
        public struct Dns: Decodable, Equatable, Sendable { public let name: String; public let type: String }
        public struct Https: Decodable, Equatable, Sendable { public let url: String }
        public let dns: Dns
        public let https: Https
    }
    public let name: String
    public let nonce: String
    public let challenge: String
    public let record: String
    public let publishAt: PublishAt
    public let expiresAt: Int64
    public let verified: Bool
}

public struct DibsVerifyResult: Decodable, Equatable, Sendable {
    public let name: String
    public let verified: Bool
    public let method: String?
}

/// `.com` refusals carry `{ error }`; surface that text as the message.
public struct DibsClientError: Error, Equatable, LocalizedError {
    public let status: Int
    public let message: String
    public var errorDescription: String? { message }
}

// MARK: - Live

public final class LiveNameDibsClient: NameDibsClient, @unchecked Sendable {
    public static var defaultBaseUrl: URL { Endpoints.controlBaseUrl }
    private let urlSession: URLSession
    private let baseUrl: URL

    public init(urlSession: URLSession = .shared, baseUrl: URL = defaultBaseUrl) {
        self.urlSession = urlSession
        self.baseUrl = baseUrl
    }

    public func window() async throws -> DibsWindow {
        try await send(path: "/api/name-dibs/window", body: nil)
    }
    public func initiate(_ body: DibsInitiateBody) async throws -> DibsClaim {
        try await send(path: "/api/name-dibs/initiate", body: try JSONEncoder().encode(body))
    }
    public func verify(_ body: DibsVerifyBody) async throws -> DibsVerifyResult {
        try await send(path: "/api/name-dibs/verify", body: try JSONEncoder().encode(body))
    }

    private func send<Resp: Decodable>(path: String, body: Data?) async throws -> Resp {
        guard let url = URL(string: baseUrl.absoluteString + path) else {
            throw DibsClientError(status: 0, message: "bad dibs URL")
        }
        var req = URLRequest(url: url)
        if let body {
            req.httpMethod = "POST"
            req.setValue("application/json", forHTTPHeaderField: "content-type")
            req.httpBody = body
        }
        let (data, resp) = try await urlSession.data(for: req)
        let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            let message = (try? JSONDecoder().decode([String: String].self, from: data))?["error"]
            throw DibsClientError(status: status, message: message ?? "HTTP \(status)")
        }
        return try JSONDecoder().decode(Resp.self, from: data)
    }
}

// MARK: - Mock

/// Scriptable dibs broker for previews and tests. Records every signed body.
public final class MockNameDibsClient: NameDibsClient, @unchecked Sendable {
    public var scriptedWindow = DibsWindow(configured: false, open: false, start: nil, end: nil)
    public var initiateError: DibsClientError?
    public var verifyError: DibsClientError?
    public private(set) var initiates: [DibsInitiateBody] = []
    public private(set) var verifies: [DibsVerifyBody] = []
    public init() {}

    public func window() async throws -> DibsWindow { scriptedWindow }

    public func initiate(_ body: DibsInitiateBody) async throws -> DibsClaim {
        initiates.append(body)
        if let initiateError { throw initiateError }
        let name = body.request.name
        let json = """
        {"name":"\(name)","nonce":"\(String(repeating: "0", count: 63))1","challenge":"mock-challenge",
         "record":"flagship-claim:mock-challenge",
         "publishAt":{"dns":{"name":"_flagship-claim.\(name).com","type":"TXT"},"https":{"url":"https://\(name).com/.well-known/flagship-claim"}},
         "expiresAt":0,"verified":false}
        """
        return try JSONDecoder().decode(DibsClaim.self, from: Data(json.utf8))
    }

    public func verify(_ body: DibsVerifyBody) async throws -> DibsVerifyResult {
        verifies.append(body)
        if let verifyError { throw verifyError }
        return DibsVerifyResult(name: body.request.name, verified: true, method: "dns")
    }
}
