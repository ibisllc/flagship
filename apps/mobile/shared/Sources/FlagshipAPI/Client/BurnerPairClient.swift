import Foundation

/// Phone-side peer of `wss://<host>/burner-pipe/<sid>?role=phone` — the
/// long-lived bidirectional session with the desktop burner (relay DO:
/// apps/com/src/burnerRelay.ts). Unlike `QrRelayClient` (one-shot
/// deliver-once), this stays open for the whole burn: the phone learns
/// the burner's pubkey, confirms the SAS, delivers the recipe, answers
/// consent requests, and keeps the socket alive with pings. A dropped
/// socket / `peer-gone` / `expired` ends the session (the burner re-locks).

/// Decoded inbound events the phone cares about.
public enum BurnerInbound: Sendable, Equatable {
    case peerPresent           // the burner was already connected when we joined
    case peerJoined            // the burner joined after us
    case burnerHello(burnerPkB64: String)
    case consentRequest(setting: String, serverDomain: String, warning: String)
    case peerGone
    case expired
    case relayError(String)
    case pong
}

/// Frames the phone sends to the burner (forwarded verbatim by the relay).
public enum BurnerOutbound: Sendable {
    case phoneHello(phonePkB64: String)
    case confirmPairing
    case deliver(ciphertextB64: String, nonceB64: String)
    case raw(json: String)     // consent-result etc.
}

public protocol BurnerPairClient: Sendable {
    /// Open the WS as role=phone and return a stream of inbound events.
    func connect(sid: String) async throws -> AsyncStream<BurnerInbound>
    func send(_ frame: BurnerOutbound) async
    func close() async
}

public enum BurnerPairError: Error, LocalizedError, Sendable {
    case connectionFailed(String)
    public var errorDescription: String? {
        switch self {
        case .connectionFailed(let m): return "Couldn't reach the relay: \(m)"
        }
    }
}

extension BurnerOutbound {
    var json: String {
        switch self {
        case .phoneHello(let pk):
            return Self.obj(["kind": "phone-hello", "phonePk": pk])
        case .confirmPairing:
            return Self.obj(["kind": "confirm-pairing"])
        case .deliver(let ct, let nonce):
            return Self.obj(["kind": "deliver", "ciphertext": ct, "nonce": nonce])
        case .raw(let json):
            return json
        }
    }
    private static func obj(_ d: [String: String]) -> String {
        (try? JSONSerialization.data(withJSONObject: d)).flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
    }
}

// MARK: - Live

public final class LiveBurnerPairClient: BurnerPairClient, @unchecked Sendable {
    public static var defaultHost: String { Endpoints.controlHost }

    private let urlSession: URLSession
    private let host: String
    private let scheme: String
    private var task: URLSessionWebSocketTask?
    private var continuation: AsyncStream<BurnerInbound>.Continuation?
    private var closed = false

    public init(urlSession: URLSession = .shared, host: String = defaultHost, secure: Bool = true) {
        self.urlSession = urlSession
        self.host = host
        self.scheme = secure ? "wss" : "ws"
    }

    public func connect(sid: String) async throws -> AsyncStream<BurnerInbound> {
        let encodedSid = sid.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? sid
        guard let url = URL(string: "\(scheme)://\(host)/burner-pipe/\(encodedSid)?role=phone") else {
            throw BurnerPairError.connectionFailed("bad URL")
        }
        let t = urlSession.webSocketTask(with: url)
        task = t
        t.resume()

        let stream = AsyncStream<BurnerInbound> { cont in
            self.continuation = cont
        }
        receiveLoop()
        startPing()
        return stream
    }

    public func send(_ frame: BurnerOutbound) async {
        guard let t = task else { return }
        try? await t.send(.string(frame.json))
    }

    public func close() async {
        if closed { return }
        closed = true
        continuation?.finish()
        continuation = nil
        task?.cancel(with: .normalClosure, reason: nil)
        task = nil
    }

    private func receiveLoop() {
        task?.receive { [weak self] result in
            guard let self = self, !self.closed else { return }
            switch result {
            case .failure:
                self.yield(.relayError("connection lost"))
                self.continuation?.finish()
                self.closed = true
            case .success(let message):
                if let ev = Self.decode(message) { self.yield(ev) }
                if !self.closed { self.receiveLoop() }
            }
        }
    }

    private func startPing() {
        Task { [weak self] in
            while true {
                try? await Task.sleep(nanoseconds: 20_000_000_000)
                guard let self = self, !self.closed, let t = self.task else { return }
                try? await t.send(.string("{\"kind\":\"ping\"}"))
            }
        }
    }

    private func yield(_ ev: BurnerInbound) { continuation?.yield(ev) }

    private static func decode(_ message: URLSessionWebSocketTask.Message) -> BurnerInbound? {
        let data: Data
        switch message {
        case .data(let d): data = d
        case .string(let s): data = Data(s.utf8)
        @unknown default: return nil
        }
        guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let kind = obj["kind"] as? String else { return nil }
        switch kind {
        case "accepted": return nil
        case "peer-present": return .peerPresent
        case "peer-joined": return .peerJoined
        case "peer-gone": return .peerGone
        case "expired": return .expired
        case "pong": return .pong
        case "error": return .relayError((obj["reason"] as? String) ?? "relay error")
        case "peer":
            guard let frame = obj["frame"] as? [String: Any],
                  let fkind = frame["kind"] as? String else { return nil }
            switch fkind {
            case "burner-hello":
                guard let pk = frame["burnerPk"] as? String else { return nil }
                return .burnerHello(burnerPkB64: pk)
            case "consent-request":
                let setting = (frame["setting"] as? String) ?? ""
                let serverDomain = (frame["serverDomain"] as? String) ?? ""
                let warning = (frame["warning"] as? String) ?? ""
                return .consentRequest(setting: setting, serverDomain: serverDomain, warning: warning)
            default:
                return nil
            }
        default:
            return nil
        }
    }
}

// MARK: - Mock

/// Scripted mock for tests. Push inbound events with `emit(_:)`; outbound
/// frames are captured in `sent`.
public final class MockBurnerPairClient: BurnerPairClient, @unchecked Sendable {
    public private(set) var connectedSid: String?
    public private(set) var sent: [BurnerOutbound] = []
    public private(set) var didClose = false
    private var continuation: AsyncStream<BurnerInbound>.Continuation?

    public init() {}

    public func connect(sid: String) async throws -> AsyncStream<BurnerInbound> {
        connectedSid = sid
        return AsyncStream { cont in self.continuation = cont }
    }

    public func send(_ frame: BurnerOutbound) async { sent.append(frame) }

    public func close() async { didClose = true; continuation?.finish(); continuation = nil }

    /// Test helper — emit an inbound event to the consumer.
    public func emit(_ ev: BurnerInbound) { continuation?.yield(ev) }

    /// Convenience accessors for assertions.
    public var sentJSON: [String] { sent.map { $0.json } }
}
