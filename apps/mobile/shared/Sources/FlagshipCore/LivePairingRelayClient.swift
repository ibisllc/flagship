import Foundation
import CryptoKit
import FlagshipAPI

/// One end of a `/qr-pipe/<sid>?role=…` WebSocket, as plain text frames.
/// A seam so the choreography below is testable without a network.
public protocol PairingSocket: AnyObject, Sendable {
    func send(_ text: String) async throws
    func receive() async throws -> String
    func close()
    var closedLocally: Bool { get }
}

public protocol PairingSocketFactory: Sendable {
    func connect(sid: String, role: String) throws -> any PairingSocket
}

final class URLSessionPairingSocket: PairingSocket, @unchecked Sendable {
    private let task: URLSessionWebSocketTask
    private let lock = NSLock()
    private var closed = false

    init(task: URLSessionWebSocketTask) {
        self.task = task
        task.resume()
    }

    func send(_ text: String) async throws {
        try await task.send(.string(text))
    }

    func receive() async throws -> String {
        switch try await task.receive() {
        case .string(let s): return s
        case .data(let d): return String(decoding: d, as: UTF8.self)
        @unknown default: throw PairingRelayError.transport("unknown frame type")
        }
    }

    func close() {
        lock.withLock { closed = true }
        task.cancel(with: .normalClosure, reason: nil)
    }

    var closedLocally: Bool { lock.withLock { closed } }
}

public final class URLSessionPairingSocketFactory: PairingSocketFactory, @unchecked Sendable {
    private let urlSession: URLSession
    private let host: String
    private let scheme: String

    public init(urlSession: URLSession = .shared, host: String = Endpoints.controlHost, secure: Bool = true) {
        self.urlSession = urlSession
        self.host = host
        self.scheme = secure ? "wss" : "ws"
    }

    public func connect(sid: String, role: String) throws -> any PairingSocket {
        let encodedSid = sid.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? sid
        guard let url = URL(string: "\(scheme)://\(host)/qr-pipe/\(encodedSid)?role=\(role)") else {
            throw PairingRelayError.transport("bad relay URL")
        }
        return URLSessionPairingSocket(task: try urlSession.gatedWebSocketTask(with: url))
    }
}

/// Live `/qr-pipe` transport for cross-device pairing (Add a device / Join an
/// account). Byte-for-byte the choreography of `webapp/lib/pairingRelay.js`:
///
///   leg 1 (sid from the QR)   admin = role browser, incoming = role phone.
///     The incoming's ONE deliver carries, sealed under the SAS-verified key,
///     { devicePubHex, deviceId, returnSid, returnPkB64u }.
///   leg 2 (sid minted by the incoming)   incoming = role browser (opened and
///     listening BEFORE leg 1 is sent), admin = role phone. The admin delivers
///     the bundle sealed under the SAME leg-1 key, so leg 2's own handshake is
///     not a trust input.
public final class LivePairingRelayClient: PairingRelayClient, @unchecked Sendable {
    private static let deliverDeadline: TimeInterval = 20

    private let factory: any PairingSocketFactory
    private let lock = NSLock()
    private var sockets: [any PairingSocket] = []
    private var returnSid: String?

    public init(factory: any PairingSocketFactory = URLSessionPairingSocketFactory()) {
        self.factory = factory
    }

    // MARK: - Admin

    /// Superseded by the private-key overload: a network relay must derive the
    /// leg-1 key itself, which a throwaway key cannot do.
    public func adminAwaitDevicePubkey(sid: String, aeadKey: SymmetricKey) async throws -> Data {
        throw PairingRelayError.transport("unsupported call")
    }

    public func adminAwaitDevicePubkey(
        sid: String,
        adminPrivateKey: Curve25519.KeyAgreement.PrivateKey
    ) async throws -> Data {
        try await closingOnError { () async throws -> Data in
            let socket = try factory.connect(sid: sid, role: "browser")
            track(socket)
            lock.withLock { returnSid = nil }

            var handshakePk: Data?
            var key: SymmetricKey?
            while true {
                let frame = try await Self.nextFrame(socket)
                switch frame.kind {
                case "peer-hello":
                    guard let pk = frame.phonePk.flatMap(Base64URL.decode), pk.count == 32,
                          let material = try? QrRelay.deriveMaterial(
                              phonePrivateKey: adminPrivateKey,
                              browserPublicKey: pk
                          )
                    else { continue }
                    handshakePk = pk
                    key = material.aeadKey
                case "peer-deliver":
                    guard let handshakePk, let key,
                          let ct = frame.ciphertext, let nonce = frame.nonce,
                          let plain = Self.aeadOpen(key: key, ciphertextBase64Url: ct, nonceBase64Url: nonce),
                          let obj = try? JSONSerialization.jsonObject(with: plain) as? [String: Any],
                          let pubHex = (obj["devicePubHex"] as? String)?
                              .trimmingCharacters(in: .whitespacesAndNewlines).lowercased(),
                          let idHex = (obj["deviceId"] as? String)?
                              .trimmingCharacters(in: .whitespacesAndNewlines).lowercased(),
                          Self.isHex(pubHex, length: 64), Self.isHex(idHex, length: 32),
                          let pub = HexUtil.decode(pubHex), let id = HexUtil.decode(idHex)
                    else { continue }
                    let announced = obj["returnSid"] as? String
                    lock.withLock { returnSid = announced }
                    socket.close()
                    return handshakePk + pub + id
                case "rebind":
                    throw PairingRelayError.sessionInvalidated
                case "expired":
                    throw PairingRelayError.sessionExpired
                case "error":
                    throw PairingRelayError.transport(frame.reason ?? "unspecified")
                default:
                    continue
                }
            }
        }
    }

    public func adminDeliverBundle(sid: String, ciphertextBase64Url: String, nonceBase64Url: String) async throws {
        try await closingOnError { () async throws -> Void in
            guard let target = lock.withLock({ returnSid }), !target.isEmpty else {
                throw PairingRelayError.peerMissing
            }
            let socket = try factory.connect(sid: target, role: "phone")
            track(socket)
            try await Self.withDeadline(Self.deliverDeadline, onTimeout: { socket.close() }) {
                let throwaway = Curve25519.KeyAgreement.PrivateKey().publicKey.rawRepresentation
                try await socket.send(Self.json(["kind": "hello", "phonePk": Base64URL.encode(throwaway)]))
                while true {
                    let frame = try await Self.nextFrame(socket)
                    switch frame.kind {
                    case "ack":
                        try await socket.send(Self.json([
                            "kind": "deliver",
                            "ciphertext": ciphertextBase64Url,
                            "nonce": nonceBase64Url,
                        ]))
                    case "delivered":
                        return
                    case "peer-missing":
                        throw PairingRelayError.peerMissing
                    case "expired":
                        throw PairingRelayError.sessionExpired
                    case "error":
                        throw PairingRelayError.transport(frame.reason ?? "unspecified")
                    default:
                        continue
                    }
                }
            }
            socket.close()
        }
    }

    // MARK: - Incoming

    /// Superseded by the handshake-key overload: the hello frame must carry
    /// return-channel coordinates only this client can mint.
    public func incomingSendPubkeyAwaitBundle(
        sid: String,
        devicePubCiphertextBase64Url: String,
        devicePubNonceBase64Url: String
    ) async throws -> (ciphertextBase64Url: String, nonceBase64Url: String) {
        throw PairingRelayError.transport("unsupported call")
    }

    public func incomingSendPubkeyAwaitBundle(
        sid: String,
        handshakePublicKey: Data,
        aeadKey: SymmetricKey,
        devicePubRaw: Data
    ) async throws -> (ciphertextBase64Url: String, nonceBase64Url: String) {
        guard devicePubRaw.count == 80, handshakePublicKey.count == 32 else {
            throw PairingRelayError.transport("malformed device payload")
        }
        let devicePubHex = HexUtil.encode(devicePubRaw.dropFirst(32).prefix(32))
        let deviceIdHex = HexUtil.encode(devicePubRaw.suffix(16))

        return try await closingOnError { () async throws -> (ciphertextBase64Url: String, nonceBase64Url: String) in
            let newReturnSid = Base64URL.encode(Data((0..<16).map { _ in UInt8.random(in: 0...255) }))
            let returnPk = Curve25519.KeyAgreement.PrivateKey().publicKey.rawRepresentation
            let returnSocket = try factory.connect(sid: newReturnSid, role: "browser")
            track(returnSocket)
            try await Self.withDeadline(Self.deliverDeadline, onTimeout: { returnSocket.close() }) {
                while true {
                    let frame = try await Self.nextFrame(returnSocket)
                    switch frame.kind {
                    case "accepted": return
                    case "rebind": throw PairingRelayError.sessionInvalidated
                    case "expired": throw PairingRelayError.sessionExpired
                    case "error": throw PairingRelayError.transport(frame.reason ?? "unspecified")
                    default: continue
                    }
                }
            }

            let leg1 = try factory.connect(sid: sid, role: "phone")
            track(leg1)
            try await leg1.send(Self.json(["kind": "hello", "phonePk": Base64URL.encode(handshakePublicKey)]))
            sendLoop: while true {
                let frame = try await Self.nextFrame(leg1)
                switch frame.kind {
                case "ack":
                    let hello = try JSONSerialization.data(withJSONObject: [
                        "devicePubHex": devicePubHex,
                        "deviceId": deviceIdHex,
                        "returnSid": newReturnSid,
                        "returnPkB64u": Base64URL.encode(returnPk),
                    ])
                    let sealed = try QrRelay.seal(payload: hello, with: aeadKey)
                    try await leg1.send(Self.json([
                        "kind": "deliver",
                        "ciphertext": sealed.ciphertextBase64Url,
                        "nonce": sealed.nonceBase64Url,
                    ]))
                case "delivered":
                    break sendLoop
                case "peer-missing":
                    throw PairingRelayError.peerMissing
                case "expired":
                    throw PairingRelayError.sessionExpired
                case "error":
                    throw PairingRelayError.transport(frame.reason ?? "unspecified")
                default:
                    continue
                }
            }
            leg1.close()

            while true {
                let frame = try await Self.nextFrame(returnSocket)
                switch frame.kind {
                case "peer-deliver":
                    guard let ct = frame.ciphertext, let nonce = frame.nonce else { continue }
                    returnSocket.close()
                    return (ct, nonce)
                case "rebind":
                    throw PairingRelayError.sessionInvalidated
                case "expired":
                    throw PairingRelayError.sessionExpired
                case "error":
                    throw PairingRelayError.transport(frame.reason ?? "unspecified")
                default:
                    continue
                }
            }
        }
    }

    public func close() async {
        closeAll()
    }

    // MARK: - Internals

    private func track(_ socket: any PairingSocket) {
        lock.withLock { sockets.append(socket) }
    }

    private func closeAll() {
        let open: [any PairingSocket] = lock.withLock {
            let s = sockets
            sockets.removeAll()
            return s
        }
        for s in open { s.close() }
    }

    private func closingOnError<T>(_ body: () async throws -> T) async throws -> T {
        do {
            return try await body()
        } catch {
            closeAll()
            throw error
        }
    }

    struct Frame {
        let kind: String
        let reason: String?
        let phonePk: String?
        let ciphertext: String?
        let nonce: String?
    }

    /// Next well-formed relay frame; unparseable ones are skipped exactly as
    /// the web client ignores them. A socket this client closed itself maps
    /// to `sessionInvalidated`, any other drop to a transport error.
    static func nextFrame(_ socket: any PairingSocket) async throws -> Frame {
        while true {
            let text: String
            do {
                text = try await socket.receive()
            } catch {
                if socket.closedLocally { throw PairingRelayError.sessionInvalidated }
                throw PairingRelayError.transport(error.localizedDescription)
            }
            guard let data = text.data(using: .utf8),
                  let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let kind = obj["kind"] as? String
            else { continue }
            return Frame(
                kind: kind,
                reason: obj["reason"] as? String,
                phonePk: obj["phonePk"] as? String,
                ciphertext: obj["ciphertext"] as? String,
                nonce: obj["nonce"] as? String
            )
        }
    }

    static func json(_ object: [String: String]) throws -> String {
        let data = try JSONSerialization.data(withJSONObject: object)
        return String(decoding: data, as: UTF8.self)
    }

    static func isHex(_ s: String, length: Int) -> Bool {
        s.utf8.count == length && s.utf8.allSatisfy {
            ($0 >= 0x30 && $0 <= 0x39) || ($0 >= 0x61 && $0 <= 0x66)
        }
    }

    /// Opens `ciphertext || tag` (base64url) under AES-256-GCM, the inverse of
    /// `QrRelay.seal` and of the web's `aeadSeal`. Nil on any tag/format failure.
    public static func aeadOpen(key: SymmetricKey, ciphertextBase64Url: String, nonceBase64Url: String) -> Data? {
        guard let ct = Base64URL.decode(ciphertextBase64Url),
              let nonceData = Base64URL.decode(nonceBase64Url),
              ct.count >= 16,
              let nonce = try? AES.GCM.Nonce(data: nonceData),
              let box = try? AES.GCM.SealedBox(nonce: nonce, ciphertext: ct.dropLast(16), tag: ct.suffix(16))
        else { return nil }
        return try? AES.GCM.open(box, using: key)
    }

    private final class TimeoutFlag: @unchecked Sendable {
        private let lock = NSLock()
        private var fired = false
        func fire() { lock.withLock { fired = true } }
        var didFire: Bool { lock.withLock { fired } }
    }

    /// Runs `operation`, closing the socket(s) via `onTimeout` when the
    /// deadline passes (a pending WebSocket receive does not honour task
    /// cancellation, so closing is what unblocks it).
    private static func withDeadline(
        _ seconds: TimeInterval,
        onTimeout: @escaping @Sendable () -> Void,
        _ operation: @escaping @Sendable () async throws -> Void
    ) async throws {
        let flag = TimeoutFlag()
        do {
            try await withThrowingTaskGroup(of: Void.self) { group in
                group.addTask { try await operation() }
                group.addTask {
                    try await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
                    flag.fire()
                    onTimeout()
                }
                _ = try await group.next()
                group.cancelAll()
            }
        } catch {
            if flag.didFire { throw PairingRelayError.transport("timed out") }
            throw error
        }
        if flag.didFire { throw PairingRelayError.transport("timed out") }
    }
}
