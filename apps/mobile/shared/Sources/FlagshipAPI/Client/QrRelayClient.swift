import Foundation

/// Phone-side peer of `wss://flagshipserver.com/qr-pipe/<sid>?role=phone`
/// (relay-v2). Wraps a URLSessionWebSocketTask + the small JSON-line
/// frame protocol shared with the browser counterpart in
/// `apps/web/public/heroQr.js` + `webapp/views/create-server.js`.
///
/// Frame protocol (subset the phone cares about):
///   ← from relay
///     { kind: "ack" }                  // server received our hello
///     { kind: "delivered" }            // browser AEAD-opened our payload
///     { kind: "peer-missing" }         // browser isn't on the other side
///     { kind: "expired" }              // sid TTL elapsed
///     { kind: "error", reason: ... }
///   → to relay
///     { kind: "hello", phonePk: <b64u> }
///     { kind: "deliver", ciphertext: <b64u>, nonce: <b64u> }
public protocol QrRelayClient: Sendable {
    /// Open the WS, send hello, await ack. Throws on close-before-ack.
    func openAndHello(sid: String, phonePkBase64Url: String) async throws

    /// Push a sealed payload and await the browser's AEAD-open ack.
    /// `phonePkBase64Url` is sent again inside the frame because the
    /// browser may have refreshed since hello.
    func deliver(ciphertextBase64Url: String, nonceBase64Url: String) async throws

    /// Cleanly close the WS. Idempotent.
    func close() async
}

public enum QrRelayError: Error, LocalizedError, Sendable {
    case connectionFailed(String)
    case relayClosedBeforeAck
    case peerMissing
    case sessionExpired
    case relayError(String)
    case unexpectedFrame(String)
    case notImplemented(String)

    public var errorDescription: String? {
        switch self {
        case .connectionFailed(let m): return "Couldn't reach the relay: \(m)"
        case .relayClosedBeforeAck:    return "The relay closed before the browser acknowledged."
        case .peerMissing:             return "The browser at flagshipserver.com isn't connected — reload it and try again."
        case .sessionExpired:          return "Session expired — refresh the homepage and try again."
        case .relayError(let m):       return "Relay: \(m)"
        case .unexpectedFrame(let m):  return "Unexpected frame from relay: \(m)"
        case .notImplemented(let f):   return "Not implemented yet: \(f)"
        }
    }
}

// MARK: - Live (URLSessionWebSocketTask)

public final class LiveQrRelayClient: QrRelayClient, @unchecked Sendable {
    public static var defaultHost: String { Endpoints.controlHost }

    private let urlSession: URLSession
    private let host: String
    private let scheme: String   // "wss" or "ws"
    private var task: URLSessionWebSocketTask?

    public init(urlSession: URLSession = .shared, host: String = defaultHost, secure: Bool = true) {
        self.urlSession = urlSession
        self.host = host
        self.scheme = secure ? "wss" : "ws"
    }

    public func openAndHello(sid: String, phonePkBase64Url: String) async throws {
        guard task == nil else { return }
        let encodedSid = sid.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? sid
        guard let url = URL(string: "\(scheme)://\(host)/qr-pipe/\(encodedSid)?role=phone") else {
            throw QrRelayError.connectionFailed("bad URL")
        }
        let t = urlSession.webSocketTask(with: url)
        task = t
        t.resume()

        // Send hello.
        let helloPayload = try JSONSerialization.data(withJSONObject: [
            "kind": "hello",
            "phonePk": phonePkBase64Url
        ])
        try await t.send(.data(helloPayload))

        // Wait for ack (or peer-missing / expired / error).
        while true {
            let msg = try await t.receive()
            let frame = try Self.decode(msg)
            switch frame.kind {
            case "ack":
                return
            case "peer-missing":
                throw QrRelayError.peerMissing
            case "expired":
                throw QrRelayError.sessionExpired
            case "error":
                throw QrRelayError.relayError(frame.reason ?? "unspecified")
            default:
                throw QrRelayError.unexpectedFrame("expected ack, got \(frame.kind)")
            }
        }
    }

    public func deliver(ciphertextBase64Url: String, nonceBase64Url: String) async throws {
        guard let t = task else { throw QrRelayError.connectionFailed("not open") }
        let payload = try JSONSerialization.data(withJSONObject: [
            "kind": "deliver",
            "ciphertext": ciphertextBase64Url,
            "nonce": nonceBase64Url
        ])
        try await t.send(.data(payload))
        while true {
            let msg = try await t.receive()
            let frame = try Self.decode(msg)
            switch frame.kind {
            case "delivered":
                return
            case "peer-missing":
                throw QrRelayError.peerMissing
            case "expired":
                throw QrRelayError.sessionExpired
            case "error":
                throw QrRelayError.relayError(frame.reason ?? "unspecified")
            default:
                throw QrRelayError.unexpectedFrame("expected delivered, got \(frame.kind)")
            }
        }
    }

    public func close() async {
        task?.cancel(with: .normalClosure, reason: nil)
        task = nil
    }

    private struct Frame {
        let kind: String
        let reason: String?
    }

    private static func decode(_ message: URLSessionWebSocketTask.Message) throws -> Frame {
        let data: Data
        switch message {
        case .data(let d): data = d
        case .string(let s): data = Data(s.utf8)
        @unknown default: throw QrRelayError.unexpectedFrame("unknown message type")
        }
        guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let kind = obj["kind"] as? String else {
            throw QrRelayError.unexpectedFrame(String(data: data, encoding: .utf8) ?? "(non-text)")
        }
        return Frame(kind: kind, reason: obj["reason"] as? String)
    }
}

// MARK: - Mock

/// Scripted mock relay for unit + UI tests. `scriptedSequence` controls
/// what frames the consumer will see in order. Default flow: ack on
/// openAndHello, delivered on deliver.
public final class MockQrRelayClient: QrRelayClient, @unchecked Sendable {
    public enum Behavior: Sendable { case ackThenDelivered, peerMissing, sessionExpired, relayError(String) }
    public var behavior: Behavior = .ackThenDelivered
    public private(set) var lastHello: (sid: String, phonePk: String)?
    public private(set) var lastDeliver: (ciphertext: String, nonce: String)?
    public var simulatedLatency: TimeInterval = 0

    public init() {}

    public func openAndHello(sid: String, phonePkBase64Url: String) async throws {
        if simulatedLatency > 0 {
            try? await Task.sleep(nanoseconds: UInt64(simulatedLatency * 1_000_000_000))
        }
        lastHello = (sid, phonePkBase64Url)
        switch behavior {
        case .ackThenDelivered:  return
        case .peerMissing:        throw QrRelayError.peerMissing
        case .sessionExpired:     throw QrRelayError.sessionExpired
        case .relayError(let r):  throw QrRelayError.relayError(r)
        }
    }

    public func deliver(ciphertextBase64Url: String, nonceBase64Url: String) async throws {
        if simulatedLatency > 0 {
            try? await Task.sleep(nanoseconds: UInt64(simulatedLatency * 1_000_000_000))
        }
        lastDeliver = (ciphertextBase64Url, nonceBase64Url)
        switch behavior {
        case .ackThenDelivered:   return
        case .peerMissing:         throw QrRelayError.peerMissing
        case .sessionExpired:      throw QrRelayError.sessionExpired
        case .relayError(let r):   throw QrRelayError.relayError(r)
        }
    }

    public func close() async {}
}
