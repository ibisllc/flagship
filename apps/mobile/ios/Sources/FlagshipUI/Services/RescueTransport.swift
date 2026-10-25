import Foundation
import CryptoKit
import Network
import FlagshipAPI
import FlagshipCore

/// How this phone reaches its box over the local network with `.com` and the relay out of reach
/// (docs/data-sovereignty.md): by address, the server's name as SNI, and trust by KEY, never by DNS
/// or a certificate authority. The TLS layer accepts whatever certificate the box presents and
/// reports its SHA-256; the box's signed hello must name that same certificate, so a machine in the
/// middle is caught before anything is signed. Once the hello checks out, every later connection of
/// the session must present that same certificate.
public struct RescueEndpoint: Hashable, Sendable {
    public let host: String
    public let port: Int
    public init(host: String, port: Int = 443) { self.host = host; self.port = port }
    public var display: String { host.contains(":") ? "[\(host)]:\(port)" : (port == 443 ? host : "\(host):\(port)") }
}

/// The hello as it arrived, with what this phone's own TLS stack saw on that connection.
public struct RescueHelloReply: Sendable {
    public let hello: Rescue.Exchange
    public let signature: Data
    public let pqSignature: SignatureEnvelope?
    /// SHA-256 of the leaf certificate the connection presented.
    public let seenCertSha256: String
    /// Whether that certificate would pass ordinary web checks (an expired one does not; rescue
    /// never needs it to).
    public let certificateTrusted: Bool
}

public struct RescueServerApp: Codable, Equatable, Sendable, Identifiable {
    public let serviceId: String
    public let name: String
    /// `running` | `starting` | `stopped` | `unknown`
    public let state: String
    public var id: String { serviceId }
    public init(serviceId: String, name: String, state: String) { self.serviceId = serviceId; self.name = name; self.state = state }
}

public struct RescueServerStatus: Codable, Equatable, Sendable {
    public let version: String?
    public let startedAt: Int64?
    public let certValidUntil: Int64?
    public let cpuPercent: Double?
    public let memUsedBytes: Int64?
    public let memTotalBytes: Int64?
    public let diskUsedBytes: Int64?
    public let diskTotalBytes: Int64?
    public init(version: String? = nil, startedAt: Int64? = nil, certValidUntil: Int64? = nil, cpuPercent: Double? = nil,
                memUsedBytes: Int64? = nil, memTotalBytes: Int64? = nil, diskUsedBytes: Int64? = nil, diskTotalBytes: Int64? = nil) {
        self.version = version; self.startedAt = startedAt; self.certValidUntil = certValidUntil; self.cpuPercent = cpuPercent
        self.memUsedBytes = memUsedBytes; self.memTotalBytes = memTotalBytes; self.diskUsedBytes = diskUsedBytes; self.diskTotalBytes = diskTotalBytes
    }
}

/// `GET /api/rescue/server`.
public struct RescueServerSnapshot: Codable, Equatable, Sendable {
    public let serverDomain: String
    public let apps: [RescueServerApp]
    public let status: RescueServerStatus?
    /// The offline controls this box offers (older boxes: none).
    public let controls: [String]?
    /// The box nonce this session answered: what every offline order names.
    public let sessionNonce: String?
    public let sessionEndsAt: Int64?
    public init(serverDomain: String, apps: [RescueServerApp], status: RescueServerStatus?, controls: [String]?, sessionNonce: String?, sessionEndsAt: Int64?) {
        self.serverDomain = serverDomain; self.apps = apps; self.status = status; self.controls = controls
        self.sessionNonce = sessionNonce; self.sessionEndsAt = sessionEndsAt
    }
}

public enum RescueTransportError: Error, Equatable, LocalizedError {
    /// The box answered with a refusal: its own sentence.
    case box(status: Int, message: String, code: String?)
    /// Nothing answered at that address on this network.
    case unreachable
    /// A later connection of this session presented another certificate than the one the hello named.
    case certificateChanged
    case malformed

    public var errorDescription: String? {
        switch self {
        case let .box(_, message, _): return Self.sentence(message)
        case .unreachable: return String(localized: "The server didn't answer on this network. Check that this phone is on the same Wi-Fi as the server.")
        case .certificateChanged: return String(localized: "The connection changed to another certificate partway through, so this phone stopped. Try again on a network you trust.")
        case .malformed: return String(localized: "The server's answer couldn't be read.")
        }
    }

    /// The box's words, as a sentence.
    static func sentence(_ s: String) -> String {
        guard let first = s.first else { return s }
        let t = first.uppercased() + s.dropFirst()
        return t.hasSuffix(".") ? t : t + "."
    }
}

/// One rescue connection to one box: the hello, then a session, then what the session opens.
public protocol RescueConnection: AnyObject, Sendable {
    func hello(clientNonce: String) async throws -> RescueHelloReply
    /// After a good hello: only connections that present this certificate are accepted.
    func pin(certSha256: String)
    func openSession(order: Rescue.Exchange, signatureHex: String, pqSignature: PqSignatureWire?) async throws -> Int64
    func server() async throws -> RescueServerSnapshot
    func control(order: OfflineControlOrder, signatureHex: String, pqSignature: PqSignatureWire?) async throws
    func archiveStart(_ req: ServerArchiveStartRequest) async throws
    func archiveStatus() async throws -> ServerArchiveStatus?
    func bundle(offset: Int64) async throws -> Data
    func archiveForget() async throws
    func close()
}

public protocol RescueConnector: Sendable {
    func connect(endpoint: RescueEndpoint, serverDomain: String) -> RescueConnection
}

// MARK: - Live

/// Accepts whatever certificate is presented and records its hash; once pinned, refuses any other.
final class RescueTrustDelegate: NSObject, URLSessionDelegate, @unchecked Sendable {
    private let lock = NSLock()
    private var seen: (sha: String, trusted: Bool)?
    private var pinned: String?
    private var changed = false
    let serverDomain: String

    init(serverDomain: String) { self.serverDomain = serverDomain }

    func lastSeen() -> (sha: String, trusted: Bool)? { lock.withLock { seen } }
    func pin(_ sha: String) { lock.withLock { pinned = sha.lowercased() } }
    var sawAnotherCertificate: Bool { lock.withLock { changed } }

    func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge,
                    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              let trust = challenge.protectionSpace.serverTrust,
              let leaf = (SecTrustCopyCertificateChain(trust) as? [SecCertificate])?.first
        else { return completionHandler(.performDefaultHandling, nil) }
        let der = SecCertificateCopyData(leaf) as Data
        let sha = SHA256.hash(data: der).map { String(format: "%02x", $0) }.joined()
        SecTrustSetPolicies(trust, SecPolicyCreateSSL(true, serverDomain as CFString))
        let trusted = SecTrustEvaluateWithError(trust, nil)
        let accept: Bool = lock.withLock {
            if let pinned, pinned != sha {
                changed = true
                return false
            }
            seen = (sha, trusted)
            return true
        }
        if accept { completionHandler(.useCredential, URLCredential(trust: trust)) } else { completionHandler(.cancelAuthenticationChallenge, nil) }
    }
}

public final class LiveRescueConnection: RescueConnection, @unchecked Sendable {
    private let endpoint: RescueEndpoint
    private let serverDomain: String
    private let delegate: RescueTrustDelegate
    private let session: URLSession
    private let lock = NSLock()
    private var token: String?

    init(endpoint: RescueEndpoint, serverDomain: String) {
        self.endpoint = endpoint
        self.serverDomain = serverDomain.lowercased()
        delegate = RescueTrustDelegate(serverDomain: self.serverDomain)
        let cfg = URLSessionConfiguration.ephemeral
        cfg.httpMaximumConnectionsPerHost = 1
        cfg.timeoutIntervalForRequest = 30
        cfg.waitsForConnectivity = false
        cfg.urlCache = nil
        if let port = NWEndpoint.Port(rawValue: UInt16(clamping: endpoint.port)) {
            // The box's LAN listener answers an HTTP CONNECT for a name in its own zone and pipes it
            // into its TLS server (lanDirect.ts): the URL, SNI and certificate stay the server's own.
            cfg.proxyConfigurations = [ProxyConfiguration(httpCONNECTProxy: .hostPort(host: NWEndpoint.Host(endpoint.host), port: port), tlsOptions: nil)]
        }
        session = URLSession(configuration: cfg, delegate: delegate, delegateQueue: nil)
    }

    public func pin(certSha256: String) { delegate.pin(certSha256) }

    private func request(_ path: String, method: String = "GET", json: Any? = nil, timeout: TimeInterval = 30) async throws -> (Data, HTTPURLResponse) {
        guard let url = URL(string: "https://\(serverDomain)\(path)") else { throw RescueTransportError.malformed }
        var req = URLRequest(url: url, timeoutInterval: timeout)
        req.httpMethod = method
        if let token = lock.withLock({ token }) { req.setValue(token, forHTTPHeaderField: "x-flagship-rescue") }
        if let json {
            req.httpBody = try JSONSerialization.data(withJSONObject: json)
            req.setValue("application/json", forHTTPHeaderField: "content-type")
        }
        let data: Data
        let resp: URLResponse
        do {
            (data, resp) = try await session.data(for: req)
        } catch {
            if delegate.sawAnotherCertificate { throw RescueTransportError.certificateChanged }
            throw RescueTransportError.unreachable
        }
        guard let http = resp as? HTTPURLResponse else { throw RescueTransportError.malformed }
        if !(200..<300).contains(http.statusCode) {
            let body = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
            throw RescueTransportError.box(status: http.statusCode, message: (body?["error"] as? String) ?? HTTPURLResponse.localizedString(forStatusCode: http.statusCode),
                                          code: body?["code"] as? String)
        }
        return (data, http)
    }

    public func hello(clientNonce: String) async throws -> RescueHelloReply {
        let (data, _) = try await request("/api/rescue/hello", method: "POST", json: ["clientNonce": clientNonce], timeout: 15)
        struct Wire: Decodable { let hello: Rescue.Exchange; let signatureHex: String; let pqSignature: SignatureEnvelope? }
        guard let w = try? JSONDecoder().decode(Wire.self, from: data), let sig = HexUtil.decode(w.signatureHex),
              let seen = delegate.lastSeen() else { throw RescueTransportError.malformed }
        return RescueHelloReply(hello: w.hello, signature: sig, pqSignature: w.pqSignature, seenCertSha256: seen.sha, certificateTrusted: seen.trusted)
    }

    public func openSession(order: Rescue.Exchange, signatureHex: String, pqSignature: PqSignatureWire?) async throws -> Int64 {
        var body: [String: Any] = [
            "order": ["serverDomain": order.serverDomain, "clientNonce": order.clientNonce, "boxNonce": order.boxNonce,
                      "certSha256": order.certSha256, "issuedAt": order.issuedAt],
            "signatureHex": signatureHex,
        ]
        if let pq = pqSignature { body["pqSignature"] = ["suite": pq.suite, "signature": pq.signature] }
        let (data, _) = try await request("/api/rescue/session", method: "POST", json: body)
        guard let o = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any], let t = o["token"] as? String else { throw RescueTransportError.malformed }
        lock.withLock { token = t }
        return (o["expiresAt"] as? NSNumber)?.int64Value ?? 0
    }

    public func server() async throws -> RescueServerSnapshot {
        let (data, _) = try await request("/api/rescue/server")
        guard let s = try? JSONDecoder().decode(RescueServerSnapshot.self, from: data) else { throw RescueTransportError.malformed }
        return s
    }

    public func control(order: OfflineControlOrder, signatureHex: String, pqSignature: PqSignatureWire?) async throws {
        var body: [String: Any] = [
            "order": ["serverDomain": order.serverDomain, "sessionNonce": order.sessionNonce, "action": order.action,
                      "target": order.target, "nonce": order.nonce, "issuedAt": order.issuedAt],
            "signatureHex": signatureHex,
        ]
        if let pq = pqSignature { body["pqSignature"] = ["suite": pq.suite, "signature": pq.signature] }
        _ = try await request("/api/rescue/control", method: "POST", json: body, timeout: 120)
    }

    public func archiveStart(_ req: ServerArchiveStartRequest) async throws {
        let json = try JSONSerialization.jsonObject(with: JSONEncoder().encode(req))
        _ = try await request("/api/rescue/archive/start", method: "POST", json: json)
    }

    public func archiveStatus() async throws -> ServerArchiveStatus? {
        let (data, _) = try await request("/api/rescue/archive")
        return (try? JSONDecoder().decode(ServerArchiveStatusResponse.self, from: data))?.archive
    }

    public func bundle(offset: Int64) async throws -> Data {
        try await request("/api/rescue/archive/bundle?offset=\(offset)", timeout: 120).0
    }

    public func archiveForget() async throws {
        _ = try await request("/api/rescue/archive", method: "DELETE")
    }

    public func close() { session.invalidateAndCancel() }
}

public struct LiveRescueConnector: RescueConnector {
    public init() {}
    public func connect(endpoint: RescueEndpoint, serverDomain: String) -> RescueConnection {
        LiveRescueConnection(endpoint: endpoint, serverDomain: serverDomain)
    }
}
