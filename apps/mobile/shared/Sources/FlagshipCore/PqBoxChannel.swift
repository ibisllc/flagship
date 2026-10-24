import Foundation
import FlagshipAPI

/// The phone's side of `flagship/pq-session/v1` (docs/architecture-v2/pq-suites.md §13): for a
/// server this device holds as strict, every request goes inside a session opened with this
/// device's hybrid key to the server's pinned ML-DSA key. A request is never sent in the clear to
/// a strict server: without a pinned key or a usable device key it fails with a sentence.
public final class PqBoxChannelTunnel: PqBoxTunnel, @unchecked Sendable {
    public struct Identity: Sendable {
        public let binding: VerifiedPqKeyBinding
        public let sign: @Sendable (_ purpose: String, _ payload: [UInt8]) throws -> [UInt8]
        public init(binding: VerifiedPqKeyBinding, sign: @escaping @Sendable (_ purpose: String, _ payload: [UInt8]) throws -> [UInt8]) {
            self.binding = binding; self.sign = sign
        }
    }

    public enum TunnelError: Error, Equatable, LocalizedError {
        case notReady(String)
        case refused(String)
        public var errorDescription: String? {
            switch self {
            case .notReady(let s), .refused(let s): return s
            }
        }
    }

    private let isStrict: @Sendable (String) -> Bool
    private let responder: @Sendable (String) -> VerifiedPqKeyBinding?
    private let identity: @Sendable () async -> Identity?
    private let now: @Sendable () -> Int64
    private let lock = NSLock()
    private var open: [String: (channel: PqSession.Channel, id: String)] = [:]

    public init(isStrict: @escaping @Sendable (String) -> Bool,
                responder: @escaping @Sendable (String) -> VerifiedPqKeyBinding?,
                identity: @escaping @Sendable () async -> Identity?,
                now: @escaping @Sendable () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) }) {
        self.isStrict = isStrict; self.responder = responder; self.identity = identity; self.now = now
    }

    public func carries(host: String) -> Bool { isStrict(host.lowercased()) }

    /// Forget every session (sign out, a key change).
    public func reset() {
        lock.lock(); defer { lock.unlock() }
        for (_, s) in open { s.channel.close() }
        open.removeAll()
    }

    private func cached(_ host: String) -> (channel: PqSession.Channel, id: String)? {
        lock.lock(); defer { lock.unlock() }
        return open[host]
    }

    private func store(_ host: String, _ s: (channel: PqSession.Channel, id: String)?) {
        lock.lock(); defer { lock.unlock() }
        open[host] = s
    }

    private static func post(_ base: URL, _ path: String, _ body: [String: Any]) throws -> URLRequest {
        var r = URLRequest(url: base.appendingPathComponent(path))
        r.httpMethod = "POST"
        r.setValue("application/json", forHTTPHeaderField: "content-type")
        r.httpBody = try JSONSerialization.data(withJSONObject: body)
        return r
    }

    private func connect(_ base: URL, _ host: String, _ transport: @Sendable (URLRequest) async throws -> (Data, URLResponse)) async throws -> (channel: PqSession.Channel, id: String) {
        guard let pinned = responder(host) else {
            throw TunnelError.notReady("This server is quantum-safe, but this device hasn't checked its post-quantum key yet. Open the server once while online.")
        }
        guard let me = await identity() else {
            throw TunnelError.notReady("This server only accepts quantum-safe connections, and this device's post-quantum key isn't ready. Unlock the app and try again.")
        }
        let st = try PqSession.Initiator(responder: pinned, initiatorRole: "device", identity: me.binding, now: now())
        let (hd, hr) = try await transport(Self.post(base, "/api/pq-session/hello", ["hello": st.hello.jsonObject]))
        guard (hr as? HTTPURLResponse)?.statusCode == 200, let hb = try JSONSerialization.jsonObject(with: hd) as? [String: Any],
              let handshake = hb["handshake"] as? String else {
            throw TunnelError.refused("The server refused this device's quantum-safe connection. Check that the device is still on the account.")
        }
        let (fin, channel) = try st.finish(accept: hb["accept"], now: now(), sign: me.sign)
        let (fd, fr) = try await transport(Self.post(base, "/api/pq-session/finish", ["handshake": handshake, "finish": fin]))
        guard (fr as? HTTPURLResponse)?.statusCode == 200, let fb = try JSONSerialization.jsonObject(with: fd) as? [String: Any],
              fb["session"] as? String == channel.sessionIdHex else {
            throw TunnelError.refused("The server's quantum-safe connection did not complete.")
        }
        let s = (channel: channel, id: channel.sessionIdHex)
        store(host, s)
        return s
    }

    public func send(_ request: URLRequest, host: String,
                     transport: @escaping @Sendable (URLRequest) async throws -> (Data, URLResponse)) async throws -> (Data, URLResponse) {
        guard let url = request.url, let scheme = url.scheme, let base = URL(string: "\(scheme)://\(url.host ?? host)\(url.port.map { ":\($0)" } ?? "")") else {
            throw TunnelError.refused("bad URL")
        }
        var headers: [String: String] = [:]
        for (k, v) in request.allHTTPHeaderFields ?? [:] { headers[k.lowercased()] = v }
        var path = url.path.isEmpty ? "/" : url.path
        if let q = url.query { path += "?\(q)" }
        let inner: [String: Any] = ["method": request.httpMethod ?? "GET", "path": path, "headers": headers,
                                    "body": (request.httpBody ?? Data()).base64EncodedString()]
        let plain = [UInt8](try JSONSerialization.data(withJSONObject: inner))
        let h = host.lowercased()
        for _ in 0..<2 {
            let s: (channel: PqSession.Channel, id: String)
            if let c = cached(h) { s = c } else { s = try await connect(base, h, transport) }
            let (seq, record) = try s.channel.sealRequest(plain, now: now())
            let (data, resp) = try await transport(Self.post(base, "/api/pq-session/call", ["session": s.id, "record": Data(record).base64EncodedString()]))
            let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
            if status == 410 { store(h, nil); continue }
            guard status == 200, let o = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let rec = (o["record"] as? String).flatMap({ Data(base64Encoded: $0) }) else { return (data, resp) }
            let answer = try s.channel.openResponse(seq: seq, record: [UInt8](rec))
            guard let a = try JSONSerialization.jsonObject(with: Data(answer)) as? [String: Any],
                  let st = a["status"] as? Int, let b64 = a["body"] as? String, let body = Data(base64Encoded: b64) else {
                throw TunnelError.refused("The server's quantum-safe answer could not be read.")
            }
            let hdrs = (a["headers"] as? [String: String]) ?? [:]
            let http = HTTPURLResponse(url: url, statusCode: st, httpVersion: "HTTP/1.1", headerFields: hdrs)!
            return (body, http)
        }
        throw TunnelError.refused("The server keeps closing the quantum-safe connection. Try again.")
    }
}
