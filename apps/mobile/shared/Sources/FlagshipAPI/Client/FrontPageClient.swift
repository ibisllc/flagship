import Foundation

/// Box-direct delivery for the owner-assignable apex ("front page").
///
/// Two unauthenticated reads + one signature-authed write, all on the box's
/// pinned canonical pipe (same trust posture as LockPowerClient):
///
///   GET  https://<serverDomain>/api/front-page   → { label, active }
///   GET  https://<serverDomain>/api/services     → { apps: [{ urlLabel, name, … }] }
///   POST https://<serverDomain>/api/front-page   (set-front-page PhoneOrder envelope)
///
/// The transport takes an already-built `request` dictionary + the hex
/// signature so this layer stays free of the FlagshipCore envelope types
/// (FlagshipCore depends on FlagshipAPI, not the reverse).
public protocol FrontPageClient: Sendable {
    func getFrontPage(serverDomain: String) async throws -> FrontPageState
    func listFrontPageOptions(serverDomain: String) async throws -> [FrontPageOption]
    /// POST a signed `set-front-page` PhoneOrder. Throws on non-2xx.
    func setFrontPage(serverDomain: String, request: [String: Any], signatureHex: String) async throws
}

public struct FrontPageState: Equatable, Sendable {
    /// Assigned service url-label; nil = default Flagship page.
    public let label: String?
    /// Whether the assigned label currently resolves to an installed service.
    public let active: Bool
    public init(label: String?, active: Bool) {
        self.label = label
        self.active = active
    }
}

public struct FrontPageOption: Equatable, Sendable, Identifiable {
    public let urlLabel: String
    public let name: String
    public var id: String { urlLabel }
    public init(urlLabel: String, name: String) {
        self.urlLabel = urlLabel
        self.name = name
    }
}

/// URLSession-backed implementation. Rides the BOX-pinned session (hard-fail
/// cert-fingerprint pinning) exactly like the screens client.
public final class LiveFrontPageClient: FrontPageClient, @unchecked Sendable {
    private let urlSession: URLSession

    public init(urlSession: URLSession) {
        self.urlSession = urlSession
    }

    private static func baseUrl(_ serverDomain: String) -> String {
        let host = serverDomain.trimmingCharacters(in: CharacterSet(charactersIn: "/ "))
        return "https://\(host)"
    }

    private func send(_ req: URLRequest) async throws -> Data {
        let data: Data
        let resp: URLResponse
        do {
            (data, resp) = try await urlSession.data(for: req)
        } catch {
            if let host = req.url?.host,
               CertPinMismatchSink.shared.consumeRecentMismatch(host: host) {
                throw ScreensClientError.certPinMismatch(host: host)
            }
            throw error
        }
        guard let http = resp as? HTTPURLResponse else {
            throw ScreensClientError.http(status: 0, message: "no response")
        }
        if !(200..<300).contains(http.statusCode) {
            let text = String(data: data, encoding: .utf8) ?? ""
            throw ScreensClientError.http(status: http.statusCode, message: text)
        }
        return data
    }

    private func get(serverDomain: String, path: String) async throws -> Data {
        guard let url = URL(string: Self.baseUrl(serverDomain) + path) else {
            throw ScreensClientError.http(status: 0, message: "bad URL")
        }
        return try await send(URLRequest(url: url))
    }

    public func getFrontPage(serverDomain: String) async throws -> FrontPageState {
        let data = try await get(serverDomain: serverDomain, path: "/api/front-page")
        let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        let label = obj?["label"] as? String
        let active = (obj?["active"] as? Bool) ?? false
        return FrontPageState(label: label, active: active)
    }

    public func listFrontPageOptions(serverDomain: String) async throws -> [FrontPageOption] {
        let data = try await get(serverDomain: serverDomain, path: "/api/services")
        let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        let apps = (obj?["apps"] as? [[String: Any]]) ?? []
        return apps.compactMap { a in
            guard let label = a["urlLabel"] as? String else { return nil }
            return FrontPageOption(urlLabel: label, name: (a["name"] as? String) ?? label)
        }
    }

    public func setFrontPage(serverDomain: String, request: [String: Any], signatureHex: String) async throws {
        guard let url = URL(string: Self.baseUrl(serverDomain) + "/api/front-page") else {
            throw ScreensClientError.http(status: 0, message: "bad URL")
        }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "content-type")
        req.httpBody = try JSONSerialization.data(
            withJSONObject: ["request": request, "signature": signatureHex], options: [])
        _ = try await send(req)
    }
}

/// In-memory mock: records what was set (so tests can assert wire shapes)
/// and returns configurable state + options.
public final class MockFrontPageClient: FrontPageClient, @unchecked Sendable {
    public struct Sent: Sendable {
        public let serverDomain: String
        public let request: [String: String]
        public let signatureHex: String
    }

    private let lock = NSLock()
    private var _sent: [Sent] = []
    public var sent: [Sent] { lock.withLock { _sent } }

    public var state = FrontPageState(label: nil, active: false)
    public var options: [FrontPageOption] = []
    /// Optional error to throw on the next call (any path), then cleared.
    public var nextError: Error?

    public init() {}

    private func maybeThrow() throws {
        if let e = nextError { nextError = nil; throw e }
    }

    public func getFrontPage(serverDomain: String) async throws -> FrontPageState {
        try maybeThrow()
        return state
    }

    public func listFrontPageOptions(serverDomain: String) async throws -> [FrontPageOption] {
        try maybeThrow()
        return options
    }

    public func setFrontPage(serverDomain: String, request: [String: Any], signatureHex: String) async throws {
        try maybeThrow()
        var flat: [String: String] = [:]
        for (k, v) in request { flat[k] = String(describing: v) }
        let label = flat["label"] ?? ""
        lock.withLock { _sent.append(Sent(serverDomain: serverDomain, request: flat, signatureHex: signatureHex)) }
        state = FrontPageState(label: label.isEmpty ? nil : label, active: !label.isEmpty)
    }
}
