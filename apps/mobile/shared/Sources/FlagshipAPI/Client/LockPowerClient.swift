import Foundation

/// Box-direct delivery for the lock / power-off envelopes.
///
/// Unlike the screens BFF (session-token-authed at `/api/screens/*`), these
/// daemon routes are SIGNATURE-authed `{ request, signature }` bodies —
/// the daemon verifies the Ed25519 signature against its config-pinned owner
/// key, so no session token is needed:
///
///   POST https://<serverDomain>/api/power               (power-off PhoneOrder)
///
/// The transport takes an already-built `request` dictionary + the hex
/// signature so this layer stays free of the FlagshipCore envelope types
/// (FlagshipCore depends on FlagshipAPI, not the reverse). The VM in
/// FlagshipUI builds the canonical bytes + signs, then hands the wire shape
/// here.
///
/// The pod-pairing mint (`add-paired-session` → `/api/orders-from-user`) also
/// rides here: it is the SAME box-direct, signature-authed shape (the daemon
/// verifies it against the config-pinned owner IRK), and reusing this client
/// keeps the pairing POST on the box-pinned session so a rogue `.com` cert
/// can't intercept the minted session token in flight.
public protocol LockPowerClient: Sendable {
    /// POST a signed `power-off` PhoneOrder to the box. Throws on non-2xx.
    func sendPowerOff(serverDomain: String, request: [String: Any], signatureHex: String) async throws

    /// Like `sendPowerOff`, but returns what the box actually did. A restart the
    /// box could not lock at the boot service becomes a shutdown; the result
    /// says so, and the screen must report it. Older boxes answer only
    /// `{ ok, mode }`.
    func sendPower(serverDomain: String, request: [String: Any], signatureHex: String) async throws -> PowerOffResult

    /// POST a signed `add-paired-session` PhoneOrder to `/api/orders-from-user`
    /// to mint the box's paired-session token. Throws on non-2xx — the caller
    /// only persists the token after this returns.
    func pairSession(serverDomain: String, request: [String: Any], signatureHex: String) async throws

    /// POST a signed `JournalRequest` to `/api/journal`. Returns the daemon's
    /// `{ ok, unit, lines }` — the trailing journal lines for diagnostics.
    func readJournal(serverDomain: String, request: [String: Any], signatureHex: String) async throws -> JournalResult
}

/// What a power order came to on the box (`POST /api/power`).
public struct PowerOffResult: Equatable, Sendable {
    /// What the host was told to do: "off" or "restart".
    public let mode: String
    /// "confirmed", "unconfirmed" or "unavailable"; nil from a box that predates the lock.
    public let suspension: String?
    public init(mode: String, suspension: String? = nil) {
        self.mode = mode
        self.suspension = suspension
    }
}

public extension LockPowerClient {
    func sendPower(serverDomain: String, request: [String: Any], signatureHex: String) async throws -> PowerOffResult {
        try await sendPowerOff(serverDomain: serverDomain, request: request, signatureHex: signatureHex)
        return PowerOffResult(mode: (request["mode"] as? String) ?? "off")
    }
}

public struct JournalResult: Equatable, Sendable {
    public let ok: Bool
    public let unit: String
    public let lines: [String]
    public init(ok: Bool, unit: String, lines: [String]) {
        self.ok = ok
        self.unit = unit
        self.lines = lines
    }
}

/// URLSession-backed implementation. Rides the BOX-pinned session (hard-fail
/// cert-fingerprint pinning, A′ phase 4) exactly like the screens client, so
/// a `.com` rogue cert can't intercept a power-off in flight.
public final class LiveLockPowerClient: LockPowerClient, @unchecked Sendable {
    private let urlSession: URLSession

    public init(urlSession: URLSession) {
        self.urlSession = urlSession
    }

    private static func baseUrl(_ serverDomain: String) -> String {
        let host = serverDomain.trimmingCharacters(in: CharacterSet(charactersIn: "/ "))
        return "https://\(host)"
    }

    private func post(
        serverDomain: String,
        path: String,
        request: [String: Any],
        signatureHex: String
    ) async throws -> Data {
        let body: [String: Any] = ["request": request, "signature": signatureHex]
        guard let url = URL(string: Self.baseUrl(serverDomain) + path) else {
            throw ScreensClientError.http(status: 0, message: String(localized: "bad URL"))
        }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "content-type")
        req.httpBody = try JSONSerialization.data(withJSONObject: body, options: [])

        let data: Data
        let resp: URLResponse
        do {
            (data, resp) = try await urlSession.gatedData(for: req)
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
            throw ScreensClientError.http(status: 0, message: String(localized: "no response"))
        }
        if !(200..<300).contains(http.statusCode) {
            let text = String(data: data, encoding: .utf8) ?? ""
            throw ScreensClientError.http(status: http.statusCode, message: text)
        }
        return data
    }

    public func sendPowerOff(serverDomain: String, request: [String: Any], signatureHex: String) async throws {
        _ = try await post(serverDomain: serverDomain, path: "/api/power", request: request, signatureHex: signatureHex)
    }

    public func sendPower(serverDomain: String, request: [String: Any], signatureHex: String) async throws -> PowerOffResult {
        let data = try await post(serverDomain: serverDomain, path: "/api/power", request: request, signatureHex: signatureHex)
        let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        return PowerOffResult(
            mode: (obj?["mode"] as? String) ?? (request["mode"] as? String) ?? "off",
            suspension: obj?["suspension"] as? String
        )
    }

    public func pairSession(serverDomain: String, request: [String: Any], signatureHex: String) async throws {
        _ = try await post(serverDomain: serverDomain, path: "/api/orders-from-user", request: request, signatureHex: signatureHex)
    }

    public func readJournal(serverDomain: String, request: [String: Any], signatureHex: String) async throws -> JournalResult {
        let data = try await post(serverDomain: serverDomain, path: "/api/journal", request: request, signatureHex: signatureHex)
        let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        let ok = (obj?["ok"] as? Bool) ?? false
        let unit = (obj?["unit"] as? String) ?? ""
        let lines = (obj?["lines"] as? [String]) ?? []
        return JournalResult(ok: ok, unit: unit, lines: lines)
    }
}

#if DEBUG
/// In-memory mock: records what was sent (so tests can assert wire shapes)
/// and returns controllable results.
public final class MockLockPowerClient: LockPowerClient, @unchecked Sendable {
    public struct Sent: Sendable {
        public let serverDomain: String
        public let path: String
        public let request: [String: String]
        public let signatureHex: String
    }

    private let lock = NSLock()
    private var _sent: [Sent] = []
    public var sent: [Sent] { lock.withLock { _sent } }

    /// Optional error to throw on the next call (any path), then cleared.
    public var nextError: Error?

    public init() {}

    private func record(_ serverDomain: String, _ path: String, _ request: [String: Any], _ sig: String) throws {
        if let e = nextError { nextError = nil; throw e }
        var flat: [String: String] = [:]
        for (k, v) in request { flat[k] = String(describing: v) }
        lock.withLock { _sent.append(Sent(serverDomain: serverDomain, path: path, request: flat, signatureHex: sig)) }
    }

    public func sendPowerOff(serverDomain: String, request: [String: Any], signatureHex: String) async throws {
        try MockOrderSigners.shared.require(.sensitive, kind: "power-off", signatureHex: signatureHex, payload: request)
        try record(serverDomain, "/api/power", request, signatureHex)
    }

    public func pairSession(serverDomain: String, request: [String: Any], signatureHex: String) async throws {
        try record(serverDomain, "/api/orders-from-user", request, signatureHex)
    }

    /// Lines the mock returns for `readJournal`.
    public var journalLines: [String] = []

    public func readJournal(serverDomain: String, request: [String: Any], signatureHex: String) async throws -> JournalResult {
        try MockOrderSigners.shared.require(.sensitive, kind: "journal", signatureHex: signatureHex, payload: request)
        try record(serverDomain, "/api/journal", request, signatureHex)
        let unit = (request["unit"] as? String) ?? "flagship-daemon"
        return JournalResult(ok: true, unit: unit, lines: journalLines)
    }
}
#endif
