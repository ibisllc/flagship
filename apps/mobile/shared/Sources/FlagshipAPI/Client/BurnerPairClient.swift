import Foundation

/// Phone-side peer of `wss://<host>/burner-pipe/<sid>?role=phone` — the
/// bidirectional deposit session with the desktop burner (relay DO:
/// apps/com/src/burnerRelay.ts). The phone learns the burner's pubkey,
/// confirms the SAS, and delivers the recipe. A brief phone-side socket loss
/// reconnects to the same relay slot while pairing; once the burner returns a
/// successful staging receipt, the phone has no further role.

/// Decoded inbound events the phone cares about.
public enum BurnerInbound: Sendable, Equatable {
    case accepted
    case peerPresent           // the burner was already connected when we joined
    case peerJoined            // the burner joined after us
    case burnerHello(burnerPkB64: String)
    case recipeAccepted        // the burner successfully staged the recipe
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
    func send(_ frame: BurnerOutbound) async throws
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
    private let stateLock = NSLock()
    private var task: URLSessionWebSocketTask?
    private var continuation: AsyncStream<BurnerInbound>.Continuation?
    private var connectionID: UUID?

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
        var streamContinuation: AsyncStream<BurnerInbound>.Continuation!
        let stream = AsyncStream<BurnerInbound> { cont in
            streamContinuation = cont
        }
        let id = UUID()
        let previous = replaceConnection(task: t, continuation: streamContinuation, id: id)
        previous.continuation?.finish()
        previous.task?.cancel(with: .goingAway, reason: nil)
        t.resume()
        receiveLoop(task: t, id: id)
        startPing(task: t, id: id)
        return stream
    }

    public func send(_ frame: BurnerOutbound) async throws {
        guard let t = currentTask() else {
            throw BurnerPairError.connectionFailed("the connection is closed")
        }
        do {
            try await t.send(.string(frame.json))
        } catch {
            throw BurnerPairError.connectionFailed(Self.describe(error))
        }
    }

    public func close() async {
        let previous = clearConnection()
        previous.continuation?.finish()
        previous.task?.cancel(with: .normalClosure, reason: nil)
    }

    private func receiveLoop(task: URLSessionWebSocketTask, id: UUID) {
        task.receive { [weak self] result in
            guard let self, self.isCurrent(id) else { return }
            switch result {
            case .failure(let error):
                self.finishConnection(id: id, event: .relayError(Self.describe(error)))
            case .success(let message):
                if let ev = Self.decode(message) { self.yield(ev, id: id) }
                if self.isCurrent(id) { self.receiveLoop(task: task, id: id) }
            }
        }
    }

    private func startPing(task: URLSessionWebSocketTask, id: UUID) {
        Task { [weak self] in
            while true {
                try? await Task.sleep(nanoseconds: 20_000_000_000)
                guard let self, self.isCurrent(id) else { return }
                do {
                    try await task.send(.string("{\"kind\":\"ping\"}"))
                } catch {
                    self.finishConnection(id: id, event: .relayError(Self.describe(error)))
                    return
                }
            }
        }
    }

    private typealias Connection = (
        task: URLSessionWebSocketTask?,
        continuation: AsyncStream<BurnerInbound>.Continuation?
    )

    private func replaceConnection(
        task newTask: URLSessionWebSocketTask,
        continuation newContinuation: AsyncStream<BurnerInbound>.Continuation,
        id: UUID
    ) -> Connection {
        stateLock.lock()
        defer { stateLock.unlock() }
        let previous = (task, continuation)
        task = newTask
        continuation = newContinuation
        connectionID = id
        return previous
    }

    private func clearConnection() -> Connection {
        stateLock.lock()
        defer { stateLock.unlock() }
        let previous = (task, continuation)
        task = nil
        continuation = nil
        connectionID = nil
        return previous
    }

    private func currentTask() -> URLSessionWebSocketTask? {
        stateLock.lock()
        defer { stateLock.unlock() }
        return task
    }

    private func isCurrent(_ id: UUID) -> Bool {
        stateLock.lock()
        defer { stateLock.unlock() }
        return connectionID == id
    }

    private func yield(_ ev: BurnerInbound, id: UUID) {
        stateLock.lock()
        let current = connectionID == id ? continuation : nil
        stateLock.unlock()
        current?.yield(ev)
    }

    private func finishConnection(id: UUID, event: BurnerInbound) {
        stateLock.lock()
        guard connectionID == id else {
            stateLock.unlock()
            return
        }
        let current = continuation
        task = nil
        continuation = nil
        connectionID = nil
        stateLock.unlock()
        current?.yield(event)
        current?.finish()
    }

    private static func describe(_ error: Error) -> String {
        let ns = error as NSError
        return "Connection lost (\(ns.domain) \(ns.code)): \(ns.localizedDescription)"
    }

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
        case "accepted": return .accepted
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
            case "recipe-accepted":
                return .recipeAccepted
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
    public private(set) var connectCount = 0
    public private(set) var sent: [BurnerOutbound] = []
    public private(set) var didClose = false
    private var continuation: AsyncStream<BurnerInbound>.Continuation?

    public init() {}

    public func connect(sid: String) async throws -> AsyncStream<BurnerInbound> {
        connectedSid = sid
        connectCount += 1
        return AsyncStream { cont in self.continuation = cont }
    }

    public func send(_ frame: BurnerOutbound) async throws { sent.append(frame) }

    public func close() async { didClose = true; continuation?.finish(); continuation = nil }

    /// Test helper — emit an inbound event to the consumer.
    public func emit(_ ev: BurnerInbound) { continuation?.yield(ev) }

    /// Convenience accessors for assertions.
    public var sentJSON: [String] { sent.map { $0.json } }
}
