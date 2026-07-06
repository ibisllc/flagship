import Foundation

/// #91 — drains the daemon→phone alert outbox over the paired-session pinned
/// pipe (`GET /api/phone/alerts` + `POST /api/phone/alerts/ack`). Same auth as
/// the screens client (the 32-byte hex session token in `x-flagship-session`);
/// the box terminates TLS, so flagshipserver.com never sees these.
public protocol PhoneAlertClient: Sendable {
    /// Fetch alerts queued after `since` (the last-seen id; 0 = from the start).
    func fetchAlerts(since: Int) async throws -> PhoneAlertsResponse
    /// Acknowledge / drop alerts through `throughId` so they aren't re-delivered.
    func ackAlerts(throughId: Int) async throws
}

/// URLSession-backed `PhoneAlertClient`, mirroring `LiveScreensClient`'s
/// request shape (and reusing its `SessionStoring` + the box-pinned session).
public final class LivePhoneAlertClient: PhoneAlertClient, @unchecked Sendable {
    private let urlSession: URLSession
    private let store: any SessionStoring

    public init(urlSession: URLSession = .shared, store: any SessionStoring) {
        self.urlSession = urlSession
        self.store = store
    }

    public func fetchAlerts(since: Int) async throws -> PhoneAlertsResponse {
        try await request("/api/phone/alerts?since=\(since)")
    }

    public func ackAlerts(throughId: Int) async throws {
        let body = try JSONSerialization.data(withJSONObject: ["throughId": throughId])
        let _: AckResponse = try await request("/api/phone/alerts/ack", method: "POST", body: body)
    }

    private struct AckResponse: Decodable { let ok: Bool? }

    private func request<T: Decodable>(_ path: String, method: String = "GET", body: Data? = nil) async throws -> T {
        guard let base = await store.podBaseUrl else { throw ScreensClientError.notPaired }
        guard let token = await store.sessionToken else { throw ScreensClientError.noSessionToken }
        guard let url = URL(string: base.trimmingCharacters(in: CharacterSet(charactersIn: "/")) + path) else {
            throw ScreensClientError.http(status: 0, message: "bad URL")
        }

        var req = URLRequest(url: url)
        req.httpMethod = method
        req.setValue(token, forHTTPHeaderField: "x-flagship-session")
        if let body {
            req.httpBody = body
            req.setValue("application/json", forHTTPHeaderField: "content-type")
        }

        let (data, resp) = try await urlSession.data(for: req)
        guard let http = resp as? HTTPURLResponse else {
            throw ScreensClientError.http(status: 0, message: "no response")
        }
        if !(200..<300).contains(http.statusCode) {
            throw ScreensClientError.http(status: http.statusCode, message: String(data: data, encoding: .utf8) ?? "")
        }
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw ScreensClientError.decoding(String(describing: error))
        }
    }
}
