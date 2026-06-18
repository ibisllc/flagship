import Foundation

/// Box-direct delivery for the owner-signed service uninstall.
///
/// Like the lock/power-off + front-page routes, `DELETE /api/services/:id` is a
/// SIGNATURE-authed `{ request, signature }` body — the daemon verifies the
/// Ed25519 signature against its config-pinned owner IRK (same trust root as
/// install / set-service-env), so no session token is needed:
///
///   DELETE https://<serverDomain>/api/services/<serviceId>
///       { request: { serverId, creator, slug, issuedAt }, signature }
///
/// The transport takes an already-built `request` dictionary + the hex
/// signature so this layer stays free of the FlagshipCore envelope types
/// (FlagshipCore depends on FlagshipAPI, not the reverse). The VM in
/// FlagshipUI builds the canonical bytes + signs, then hands the wire shape
/// here.
public protocol ServiceUninstallClient: Sendable {
    /// DELETE a signed uninstall to the box. Throws `ScreensClientError` on
    /// non-2xx (the daemon's 400 surfaces as `.http(400, …)`).
    func uninstallService(
        serverDomain: String,
        serviceId: String,
        request: [String: Any],
        signatureHex: String
    ) async throws
}

/// URLSession-backed implementation. Rides the BOX-pinned session (hard-fail
/// cert-fingerprint pinning, A′ phase 4) exactly like the screens client, so a
/// `.com` rogue cert can't intercept the uninstall in flight.
public final class LiveServiceUninstallClient: ServiceUninstallClient, @unchecked Sendable {
    private let urlSession: URLSession

    public init(urlSession: URLSession) {
        self.urlSession = urlSession
    }

    private static func baseUrl(_ serverDomain: String) -> String {
        let host = serverDomain.trimmingCharacters(in: CharacterSet(charactersIn: "/ "))
        return "https://\(host)"
    }

    public func uninstallService(
        serverDomain: String,
        serviceId: String,
        request: [String: Any],
        signatureHex: String
    ) async throws {
        // serviceId is `<creator>-<slug>`; percent-encode for the path so a
        // slug with a reserved char can't break the URL (the daemon
        // re-derives the id from the signed creator/slug and 400s on a
        // mismatch, so this only needs to be a faithful path segment).
        let encodedId = serviceId.addingPercentEncoding(
            withAllowedCharacters: .urlPathAllowed
        ) ?? serviceId
        guard let url = URL(string: Self.baseUrl(serverDomain) + "/api/services/" + encodedId) else {
            throw ScreensClientError.http(status: 0, message: "bad URL")
        }
        var req = URLRequest(url: url)
        req.httpMethod = "DELETE"
        req.setValue("application/json", forHTTPHeaderField: "content-type")
        req.httpBody = try JSONSerialization.data(
            withJSONObject: ["request": request, "signature": signatureHex], options: [])

        let data: Data
        let resp: URLResponse
        do {
            (data, resp) = try await urlSession.data(for: req)
        } catch {
            // UX-A — a hard-fail pin mismatch surfaces as a generic transport
            // error; if the pinning delegate just flagged this host, report
            // the distinct "someone may be intercepting" error.
            if let host = url.host,
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
    }
}

/// In-memory mock: records what was sent (so tests can assert the wire shape +
/// verify the signature) and optionally throws a configured error.
public final class MockServiceUninstallClient: ServiceUninstallClient, @unchecked Sendable {
    public struct Sent: Sendable {
        public let serverDomain: String
        public let serviceId: String
        /// The signed `request` map, flattened to strings for easy assertion.
        public let request: [String: String]
        public let signatureHex: String
    }

    private let lock = NSLock()
    private var _sent: [Sent] = []
    public var sent: [Sent] { lock.withLock { _sent } }

    /// Optional error to throw on the next call, then cleared.
    public var nextError: Error?

    public init() {}

    public func uninstallService(
        serverDomain: String,
        serviceId: String,
        request: [String: Any],
        signatureHex: String
    ) async throws {
        if let e = nextError { nextError = nil; throw e }
        var flat: [String: String] = [:]
        for (k, v) in request { flat[k] = String(describing: v) }
        lock.withLock {
            _sent.append(Sent(
                serverDomain: serverDomain,
                serviceId: serviceId,
                request: flat,
                signatureHex: signatureHex
            ))
        }
    }
}
