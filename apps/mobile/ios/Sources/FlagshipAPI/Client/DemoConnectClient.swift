import Foundation

/// Plan A — client for the `/api/dev/sample-user/{username}/connect`
/// endpoint pair. When the typed username matches a `demo_users` row
/// (i.e. `/api/users/check` returns a `demoServer` block), tapping
/// "Connect" on the rendered single device POSTs `/connect` (no auth,
/// no body) and then polls `/api/users/check` until the lifecycle
/// flips to `up`. See docs/sample-users.md §10.5 + Phase D in
/// docs/sample-user-vps-plan.md.
///
/// The two methods are deliberately split so a host (e.g. a SwiftUI
/// view-model) can drive its own UI state between the POST and the
/// poll, and so tests can stub one half while exercising the other.
public protocol DemoConnectClient: Sendable {
    /// POST `/api/dev/sample-user/{username}/connect` with an empty
    /// body. 200 = the Worker observed (or already had) a
    /// `provisioning` / `up` row; non-2xx surfaces as an error so the
    /// caller can show a clear message. The endpoint is rate-limited
    /// on the Worker (10/min/IP, 30/min/u) — a 429 surfaces as
    /// `ScreensClientError.http(status: 429, ...)`.
    func connect(username: String) async throws

    /// Poll `/api/users/check` every `pollIntervalSeconds` seconds
    /// until the embedded `demoServer.status` flips to `"up"`. Returns
    /// the final `DemoServerBlock`. Throws if no `demoServer` block is
    /// present (i.e. the row was deleted under us) or if the
    /// `timeoutSeconds` budget elapses first.
    func pollUntilUp(
        username: String,
        pollIntervalSeconds: Double,
        timeoutSeconds: Double
    ) async throws -> DemoServerBlock
}

/// Errors specific to the demo-connect flow. Surfaced to the host so
/// it can render a precise message ("still booting after 5 min", "the
/// demo went away while we were waiting") without parsing strings.
public enum DemoConnectError: Error, Equatable, Sendable {
    /// `pollUntilUp` exhausted its budget before `demoServer.status`
    /// flipped to `"up"`. Carries the last status the Worker reported
    /// so a UI can decide whether to surface "still booting" vs. a
    /// less hopeful message.
    case timedOut(lastStatus: String)
    /// The Worker stopped returning a `demoServer` block mid-poll —
    /// likely the operator ran `delete-sample-user` while a client
    /// was waiting. The connect-CTA flow should bounce to onboarding.
    case demoServerWentAway
}

// MARK: - Live

public final class LiveDemoConnectClient: DemoConnectClient, @unchecked Sendable {
    private let server: any FlagshipServerClient
    private let urlSession: URLSession
    private let baseUrl: URL

    public init(
        server: any FlagshipServerClient,
        urlSession: URLSession = .shared,
        baseUrl: URL = LiveFlagshipServerClient.defaultBaseUrl
    ) {
        self.server = server
        self.urlSession = urlSession
        self.baseUrl = baseUrl
    }

    public func connect(username: String) async throws {
        let encoded = username.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? username
        var req = URLRequest(url: baseUrl.appendingPathComponent("/api/dev/sample-user/\(encoded)/connect"))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "content-type")
        req.httpBody = Data("{}".utf8)
        let (data, resp) = try await urlSession.data(for: req)
        let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
        // 200 is the standard happy path. 409 ("not yet provisioned")
        // is surfaced so the caller can show a precise error; 429 is
        // surfaced for back-off; the rest collapse to the generic
        // ScreensClientError.http for caller-side logging.
        guard (200..<300).contains(status) else {
            let text = String(data: data, encoding: .utf8) ?? ""
            throw ScreensClientError.http(status: status, message: text)
        }
    }

    public func pollUntilUp(
        username: String,
        pollIntervalSeconds: Double = 3.0,
        timeoutSeconds: Double = 300.0
    ) async throws -> DemoServerBlock {
        let deadline = Date().addingTimeInterval(timeoutSeconds)
        var lastStatus = "provisioning"
        while Date() < deadline {
            let resp = try await server.usernameAvailable(username)
            guard let block = resp.demoServer else {
                throw DemoConnectError.demoServerWentAway
            }
            lastStatus = block.status
            if block.lifecycle == .up {
                return block
            }
            // Sleep before the next poll. Use a Task.sleep so a
            // cancelled task stops promptly.
            try await Task.sleep(nanoseconds: UInt64(pollIntervalSeconds * 1_000_000_000))
        }
        throw DemoConnectError.timedOut(lastStatus: lastStatus)
    }
}

// MARK: - Mock

public final class MockDemoConnectClient: DemoConnectClient, @unchecked Sendable {
    private let server: MockFlagshipServerClient
    public var simulatedConnectLatency: TimeInterval = 0
    /// Number of seconds the mock pretends the provisioner takes before
    /// it flips its demoServer status to `up`. Default 0 so unit tests
    /// don't hang; integration tests can crank this up.
    public var simulatedProvisioningSeconds: TimeInterval = 0
    /// Tracks the usernames that received a `connect()` call so tests
    /// can assert wire round-trips happened.
    public private(set) var connectCalls: [String] = []

    public init(server: MockFlagshipServerClient) {
        self.server = server
    }

    public func connect(username: String) async throws {
        if simulatedConnectLatency > 0 {
            try? await Task.sleep(nanoseconds: UInt64(simulatedConnectLatency * 1_000_000_000))
        }
        connectCalls.append(username)
        let lower = username.lowercased()
        guard let block = server.demoServers[lower] else {
            // Mirror the Worker's 404 for "no such demo user".
            throw ScreensClientError.http(status: 404, message: "no such demo user")
        }
        // Flip the mock row to `provisioning` on first connect (mirrors
        // the Worker's state-machine: `none → provisioning`).
        if block.lifecycle == .none {
            server.demoServers[lower] = DemoServerBlock(
                fqdn: block.fqdn,
                status: "provisioning",
                ttlIdleMinutes: block.ttlIdleMinutes
            )
        }
        // Schedule a flip to `up` after the configured delay.
        let target = lower
        let delay = simulatedProvisioningSeconds
        if delay > 0 {
            Task { [weak server = self.server] in
                try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
                guard let server, let cur = server.demoServers[target] else { return }
                server.demoServers[target] = DemoServerBlock(
                    fqdn: cur.fqdn,
                    status: "up",
                    ttlIdleMinutes: cur.ttlIdleMinutes
                )
            }
        } else {
            // Synchronous flip — useful for tight unit tests that
            // immediately call pollUntilUp.
            if let cur = server.demoServers[target] {
                server.demoServers[target] = DemoServerBlock(
                    fqdn: cur.fqdn,
                    status: "up",
                    ttlIdleMinutes: cur.ttlIdleMinutes
                )
            }
        }
    }

    public func pollUntilUp(
        username: String,
        pollIntervalSeconds: Double = 0.05,
        timeoutSeconds: Double = 5.0
    ) async throws -> DemoServerBlock {
        let deadline = Date().addingTimeInterval(timeoutSeconds)
        var lastStatus = "provisioning"
        while Date() < deadline {
            let resp = try await server.usernameAvailable(username)
            guard let block = resp.demoServer else {
                throw DemoConnectError.demoServerWentAway
            }
            lastStatus = block.status
            if block.lifecycle == .up { return block }
            try await Task.sleep(nanoseconds: UInt64(pollIntervalSeconds * 1_000_000_000))
        }
        throw DemoConnectError.timedOut(lastStatus: lastStatus)
    }
}
