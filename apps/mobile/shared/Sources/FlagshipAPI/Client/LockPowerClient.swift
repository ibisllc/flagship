import Foundation

/// Box-direct delivery for the lock / power-off + dead-man envelopes.
///
/// Unlike the screens BFF (session-token-authed at `/api/screens/*`), these
/// three daemon routes are SIGNATURE-authed `{ request, signature }` bodies —
/// the daemon verifies the Ed25519 signature against its config-pinned owner
/// key, so no session token is needed:
///
///   POST https://<serverDomain>/api/power               (power-off PhoneOrder)
///   POST https://<serverDomain>/api/deadman/policy      (SetDeadManPolicy)
///   POST https://<serverDomain>/api/deadman/affirm      (DeadManAffirmation)
///
/// The transport takes an already-built `request` dictionary + the hex
/// signature so this layer stays free of the FlagshipCore envelope types
/// (FlagshipCore depends on FlagshipAPI, not the reverse). The VM in
/// FlagshipUI builds the canonical bytes + signs, then hands the wire shape
/// here.
public protocol LockPowerClient: Sendable {
    /// POST a signed `power-off` PhoneOrder to the box. Throws on non-2xx.
    func sendPowerOff(serverDomain: String, request: [String: Any], signatureHex: String) async throws

    /// POST a signed `SetDeadManPolicy`. Returns the daemon's `{ ok, enabled }`.
    func setDeadManPolicy(serverDomain: String, request: [String: Any], signatureHex: String) async throws -> DeadManPolicyResult

    /// POST a signed `DeadManAffirmation`. Returns `{ ok, leaseExpiry }` —
    /// `leaseExpiry` is the new lease deadline in ms (the phone tracks
    /// time-remaining + schedules its reminders off it).
    func affirmDeadMan(serverDomain: String, request: [String: Any], signatureHex: String) async throws -> DeadManAffirmResult

    /// POST a signed `JournalRequest` to `/api/journal`. Returns the daemon's
    /// `{ ok, unit, lines }` — the trailing journal lines for diagnostics.
    func readJournal(serverDomain: String, request: [String: Any], signatureHex: String) async throws -> JournalResult
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

public struct DeadManPolicyResult: Equatable, Sendable {
    public let ok: Bool
    public let enabled: Bool
    public init(ok: Bool, enabled: Bool) { self.ok = ok; self.enabled = enabled }
}

public struct DeadManAffirmResult: Equatable, Sendable {
    public let ok: Bool
    /// New lease deadline in ms since epoch.
    public let leaseExpiry: Int64
    public init(ok: Bool, leaseExpiry: Int64) { self.ok = ok; self.leaseExpiry = leaseExpiry }
}

/// URLSession-backed implementation. Rides the BOX-pinned session (hard-fail
/// cert-fingerprint pinning, A′ phase 4) exactly like the screens client, so
/// a `.com` rogue cert can't intercept a power-off / affirmation in flight.
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
            throw ScreensClientError.http(status: 0, message: "bad URL")
        }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "content-type")
        req.httpBody = try JSONSerialization.data(withJSONObject: body, options: [])

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
        return data
    }

    public func sendPowerOff(serverDomain: String, request: [String: Any], signatureHex: String) async throws {
        _ = try await post(serverDomain: serverDomain, path: "/api/power", request: request, signatureHex: signatureHex)
    }

    public func setDeadManPolicy(serverDomain: String, request: [String: Any], signatureHex: String) async throws -> DeadManPolicyResult {
        let data = try await post(serverDomain: serverDomain, path: "/api/deadman/policy", request: request, signatureHex: signatureHex)
        let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        let ok = (obj?["ok"] as? Bool) ?? false
        let enabled = (obj?["enabled"] as? Bool) ?? false
        return DeadManPolicyResult(ok: ok, enabled: enabled)
    }

    public func affirmDeadMan(serverDomain: String, request: [String: Any], signatureHex: String) async throws -> DeadManAffirmResult {
        let data = try await post(serverDomain: serverDomain, path: "/api/deadman/affirm", request: request, signatureHex: signatureHex)
        let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        let ok = (obj?["ok"] as? Bool) ?? false
        let expiry = numberToInt64(obj?["leaseExpiry"])
        return DeadManAffirmResult(ok: ok, leaseExpiry: expiry)
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

private func numberToInt64(_ v: Any?) -> Int64 {
    if let n = v as? Int64 { return n }
    if let n = v as? Int { return Int64(n) }
    if let n = v as? Double { return Int64(n) }
    if let n = v as? NSNumber { return n.int64Value }
    return 0
}

/// In-memory mock: records what was sent (so tests can assert wire shapes)
/// and returns controllable results. The affirm path is NOT automatic — it
/// only returns the configured `leaseExpiry` when the VM explicitly drives an
/// affirmation, mirroring the security invariant that nothing auto-affirms.
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

    /// Result the mock returns for `setDeadManPolicy`; defaults to echoing
    /// the request's `enabled`.
    public var policyResultOverride: DeadManPolicyResult?
    /// Lease expiry the mock returns for `affirmDeadMan`. The mock never
    /// affirms on its own — a test must call the affirm path to get this.
    public var affirmLeaseExpiry: Int64 = 0
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
        try record(serverDomain, "/api/power", request, signatureHex)
    }

    public func setDeadManPolicy(serverDomain: String, request: [String: Any], signatureHex: String) async throws -> DeadManPolicyResult {
        try record(serverDomain, "/api/deadman/policy", request, signatureHex)
        if let o = policyResultOverride { return o }
        let enabled = (request["enabled"] as? Bool) ?? false
        return DeadManPolicyResult(ok: true, enabled: enabled)
    }

    public func affirmDeadMan(serverDomain: String, request: [String: Any], signatureHex: String) async throws -> DeadManAffirmResult {
        try record(serverDomain, "/api/deadman/affirm", request, signatureHex)
        return DeadManAffirmResult(ok: true, leaseExpiry: affirmLeaseExpiry)
    }

    /// Lines the mock returns for `readJournal`.
    public var journalLines: [String] = []

    public func readJournal(serverDomain: String, request: [String: Any], signatureHex: String) async throws -> JournalResult {
        try record(serverDomain, "/api/journal", request, signatureHex)
        let unit = (request["unit"] as? String) ?? "flagship-daemon"
        return JournalResult(ok: true, unit: unit, lines: journalLines)
    }
}
