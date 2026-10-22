import Foundation

/// Custom voi.ci name client (`.com`, docs/named-links.md) — mirrors the
/// webapp's `lib/voiciName.js` wire calls exactly:
///
///   GET  /api/users/:u/voici-name-check?name=&service=   read token
///   GET  /api/users/:u/voici-names                       read token
///   POST /api/users/:u/apps/:id/voici-name               signed `{ order, signature }`
///
/// Wire types are pure; the view model signs via `FlagshipCore.VoiciNameOrder`.
public protocol VoiciNameClient: Sendable {
    func check(username: String, serviceId: String, name: String) async throws -> VoiciNameCheck
    func list(username: String) async throws -> [VoiciNameListed]
    func save(username: String, serviceId: String, body: VoiciNameSaveBody) async throws -> VoiciLinkState
}

/// A service's link state as `.com` sends it on `GET .../apps/:id/links` and
/// after a save: the custom `name` (nil while the random code shows), how many
/// names the account holds against its `limit`, and the change allowance.
public struct VoiciLinkState: Decodable, Equatable, Sendable {
    public let name: String?
    public let held: Int
    public let limit: Int
    public let changesLeft: Int
    public let nextChangeAt: Int64?
    public let releasesAt: Int64?
    public init(name: String?, held: Int, limit: Int, changesLeft: Int, nextChangeAt: Int64? = nil, releasesAt: Int64? = nil) {
        self.name = name; self.held = held; self.limit = limit; self.changesLeft = changesLeft
        self.nextChangeAt = nextChangeAt; self.releasesAt = releasesAt
    }
}

/// `.com`'s answer to a name check: `status` is one of available, current,
/// invalid, reserved, taken, dibs, dibs-unchecked; `domain` rides with `dibs`.
public struct VoiciNameCheck: Decodable, Equatable, Sendable {
    public let status: String
    public let domain: String?
    public init(status: String, domain: String? = nil) { self.status = status; self.domain = domain }
}

/// One live custom name of the account (the "Free one up" list).
public struct VoiciNameListed: Decodable, Equatable, Sendable, Identifiable {
    public let serviceId: String
    public let name: String
    public let setAt: Int64?
    public var id: String { serviceId }
    public init(serviceId: String, name: String, setAt: Int64? = nil) {
        self.serviceId = serviceId; self.name = name; self.setAt = setAt
    }
}

public struct VoiciNameOrderWire: Codable, Equatable, Sendable {
    public let user: String
    public let serviceId: String
    public let name: String
    public let op: String
    public let issuedAt: Int64
    public let nonce: String
    public init(user: String, serviceId: String, name: String, op: String, issuedAt: Int64, nonce: String) {
        self.user = user; self.serviceId = serviceId; self.name = name; self.op = op
        self.issuedAt = issuedAt; self.nonce = nonce
    }
}

public struct VoiciNameSaveBody: Encodable, Equatable, Sendable {
    public let order: VoiciNameOrderWire
    public let signature: String
    public init(order: VoiciNameOrderWire, signature: String) { self.order = order; self.signature = signature }
}

/// A refusal from `.com`: `code` says why (taken, reserved, invalid, dibs,
/// dibs-unchecked, change-limit, name-limit, rate-limited, not-admin, ...) and
/// the rest of the body rides along as typed fields.
public struct VoiciNameError: Error, Equatable, LocalizedError {
    public let status: Int
    public let code: String?
    public let message: String
    public let domain: String?
    public let limit: Int?
    public let nextChangeAt: Int64?
    public let retryAfterSec: Int?
    public var errorDescription: String? { message }

    public init(
        status: Int, code: String? = nil, message: String? = nil, domain: String? = nil,
        limit: Int? = nil, nextChangeAt: Int64? = nil, retryAfterSec: Int? = nil
    ) {
        self.status = status
        self.code = code
        self.message = message ?? "HTTP \(status)"
        self.domain = domain
        self.limit = limit
        self.nextChangeAt = nextChangeAt
        self.retryAfterSec = retryAfterSec
    }

    init(status: Int, body: Data) {
        let json = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any] ?? [:]
        self.init(
            status: status,
            code: json["code"] as? String,
            message: json["error"] as? String,
            domain: json["domain"] as? String,
            limit: (json["limit"] as? NSNumber)?.intValue,
            nextChangeAt: (json["nextChangeAt"] as? NSNumber)?.int64Value,
            retryAfterSec: (json["retryAfterSec"] as? NSNumber)?.intValue
        )
    }
}

// MARK: - Live

public final class LiveVoiciNameClient: VoiciNameClient, @unchecked Sendable {
    public static var defaultBaseUrl: URL { Endpoints.controlBaseUrl }
    private let urlSession: URLSession
    private let baseUrl: URL
    private let readTokens: (any AccountReadTokenSource)?

    public init(
        urlSession: URLSession = .shared,
        baseUrl: URL = defaultBaseUrl,
        readTokens: (any AccountReadTokenSource)? = nil
    ) {
        self.urlSession = urlSession
        self.baseUrl = baseUrl
        self.readTokens = readTokens
    }

    public func check(username: String, serviceId: String, name: String) async throws -> VoiciNameCheck {
        var query = [URLQueryItem(name: "name", value: name.lowercased())]
        if !serviceId.isEmpty { query.append(URLQueryItem(name: "service", value: serviceId)) }
        let req = try request(path: "/api/users/\(Self.segment(username))/voici-name-check", query: query)
        return try await read(req, username: username)
    }

    public func list(username: String) async throws -> [VoiciNameListed] {
        struct Listed: Decodable { let names: [VoiciNameListed]? }
        let req = try request(path: "/api/users/\(Self.segment(username))/voici-names")
        let body: Listed = try await read(req, username: username)
        return body.names ?? []
    }

    public func save(username: String, serviceId: String, body: VoiciNameSaveBody) async throws -> VoiciLinkState {
        struct Saved: Decodable { let link: VoiciLinkState }
        var req = try request(path: "/api/users/\(Self.segment(username))/apps/\(Self.segment(serviceId))/voici-name")
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "content-type")
        req.httpBody = try JSONEncoder().encode(body)
        let (data, resp) = try await urlSession.gatedData(for: req)
        let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else { throw VoiciNameError(status: status, body: data) }
        return try JSONDecoder().decode(Saved.self, from: data).link
    }

    private func read<Resp: Decodable>(_ req: URLRequest, username: String) async throws -> Resp {
        let (data, status) = try await sendAccountRead(req, username: username, tokens: readTokens) {
            try await self.urlSession.gatedData(for: $0)
        }
        guard (200..<300).contains(status) else { throw VoiciNameError(status: status, body: data) }
        return try JSONDecoder().decode(Resp.self, from: data)
    }

    private func request(path: String, query: [URLQueryItem] = []) throws -> URLRequest {
        guard var comps = URLComponents(string: baseUrl.absoluteString + path) else {
            throw VoiciNameError(status: 0, message: "bad voi.ci name URL")
        }
        if !query.isEmpty { comps.queryItems = query }
        guard let url = comps.url else { throw VoiciNameError(status: 0, message: "bad voi.ci name URL") }
        var req = URLRequest(url: url)
        req.cachePolicy = .reloadIgnoringLocalCacheData
        return req
    }

    private static func segment(_ s: String) -> String {
        s.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? s
    }
}

// MARK: - Mock

#if DEBUG
/// Scriptable `.com` for previews and tests. Records every call.
public final class MockVoiciNameClient: VoiciNameClient, @unchecked Sendable {
    /// Answer per lower-cased name; any other name is available.
    public var scriptedChecks: [String: VoiciNameCheck] = [:]
    public var checkError: VoiciNameError?
    public var scriptedNames: [VoiciNameListed] = []
    public var saveError: VoiciNameError?
    /// What a save answers; nil builds a state from the saved order.
    public var scriptedSaveResult: VoiciLinkState?
    public private(set) var checks: [String] = []
    public private(set) var saves: [VoiciNameSaveBody] = []
    public init() {}

    public func check(username: String, serviceId: String, name: String) async throws -> VoiciNameCheck {
        checks.append(name.lowercased())
        if let checkError { throw checkError }
        return scriptedChecks[name.lowercased()] ?? VoiciNameCheck(status: "available")
    }

    public func list(username: String) async throws -> [VoiciNameListed] { scriptedNames }

    public func save(username: String, serviceId: String, body: VoiciNameSaveBody) async throws -> VoiciLinkState {
        saves.append(body)
        if let saveError { throw saveError }
        if let scriptedSaveResult { return scriptedSaveResult }
        let name = body.order.op == "set" ? body.order.name : nil
        return VoiciLinkState(name: name, held: name == nil ? 0 : 1, limit: 5, changesLeft: 2)
    }
}
#endif
