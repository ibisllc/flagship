import Foundation
import Network
import Security
import CryptoKit
import FlagshipAPI
import FlagshipCore

/// The phone's own TLS key for its bare `<account>.<apex>` name (plan H2, docs/architecture-v2/phone-route.md §4).
///
/// A P-256 key made on the phone and never exported. Secure Enclave first (a permanent `SecKey` with
/// `kSecAttrTokenIDSecureEnclave`, so the Keychain can pair it with the certificate into a `SecIdentity` the TLS stack
/// signs with); where that is unavailable (Simulator, no Enclave) a Keychain key with
/// `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`. No user presence: handshakes happen without a prompt.
/// `backing` says which one was used.
public struct PhoneTlsKey {
    public let privateKey: SecKey
    public let publicUncompressed: Data
    public let backing: String

    public enum Failure: Error { case keychain(OSStatus), unusable }

    static func tag(_ account: String) -> Data { Data("com.flagship.phone-tls.\(account.lowercased())".utf8) }

    public static func loadOrCreate(account: String) throws -> PhoneTlsKey {
        if let k = load(account: account) { return k }
        do {
            return try create(account: account, enclave: true)
        } catch {
            return try create(account: account, enclave: false)
        }
    }

    static func load(account: String) -> PhoneTlsKey? {
        var out: CFTypeRef?
        let q: [String: Any] = [
            kSecClass as String: kSecClassKey,
            kSecAttrApplicationTag as String: tag(account),
            kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
            kSecReturnRef as String: true,
            kSecReturnAttributes as String: true,
        ]
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let attrs = out as? [String: Any],
              let ref = attrs[kSecValueRef as String] else { return nil }
        let key = ref as! SecKey
        let token = attrs[kSecAttrTokenID as String] as? String
        return wrap(key, backing: token == (kSecAttrTokenIDSecureEnclave as String) ? "secure-enclave" : "keychain")
    }

    private static func create(account: String, enclave: Bool) throws -> PhoneTlsKey {
        var error: Unmanaged<CFError>?
        guard let access = SecAccessControlCreateWithFlags(kCFAllocatorDefault, kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
                                                           enclave ? .privateKeyUsage : [], &error) else { throw Failure.unusable }
        var attrs: [String: Any] = [
            kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
            kSecAttrKeySizeInBits as String: 256,
            kSecPrivateKeyAttrs as String: [
                kSecAttrIsPermanent as String: true,
                kSecAttrApplicationTag as String: tag(account),
                kSecAttrAccessControl as String: access,
            ] as [String: Any],
        ]
        if enclave { attrs[kSecAttrTokenID as String] = kSecAttrTokenIDSecureEnclave }
        guard let key = SecKeyCreateRandomKey(attrs as CFDictionary, &error), let wrapped = wrap(key, backing: enclave ? "secure-enclave" : "keychain") else {
            throw Failure.unusable
        }
        return wrapped
    }

    private static func wrap(_ key: SecKey, backing: String) -> PhoneTlsKey? {
        guard let pub = SecKeyCopyPublicKey(key), let raw = SecKeyCopyExternalRepresentation(pub, nil) as Data?, raw.count == 65 else { return nil }
        return PhoneTlsKey(privateKey: key, publicUncompressed: raw, backing: backing)
    }

    /// DER ECDSA-SHA256 over `message` (what the CSR carries).
    public func signDer(_ message: Data) throws -> Data {
        var error: Unmanaged<CFError>?
        guard let sig = SecKeyCreateSignature(privateKey, .ecdsaSignatureMessageX962SHA256, message as CFData, &error) as Data? else {
            throw Failure.unusable
        }
        return sig
    }

    public static func delete(account: String) {
        SecItemDelete([kSecClass as String: kSecClassKey, kSecAttrApplicationTag as String: tag(account)] as CFDictionary)
        SecItemDelete([kSecClass as String: kSecClassCertificate, kSecAttrLabel as String: certLabel(account)] as CFDictionary)
    }

    static func certLabel(_ account: String) -> String { "com.flagship.phone-tls-cert.\(account.lowercased())" }

    // MARK: the certificate and the identity

    public static func certificates(pem: String) -> [SecCertificate] {
        pem.components(separatedBy: "-----BEGIN CERTIFICATE-----").dropFirst().compactMap { block in
            let b64 = block.components(separatedBy: "-----END CERTIFICATE-----").first?.filter { !$0.isWhitespace } ?? ""
            return Data(base64Encoded: b64).flatMap { SecCertificateCreateWithData(nil, $0 as CFData) }
        }
    }

    /// The uncompressed point of the first certificate in `pem` (to refuse a chain issued for another key).
    public static func leafKey(pem: String) -> Data? {
        guard let leaf = certificates(pem: pem).first, let key = SecCertificateCopyKey(leaf) else { return nil }
        return SecKeyCopyExternalRepresentation(key, nil) as Data?
    }

    /// The TLS identity: the leaf stored next to the key, so the Keychain pairs them, plus the rest of the chain.
    public func identity(account: String, chainPem: String) throws -> sec_identity_t {
        let certs = Self.certificates(pem: chainPem)
        guard let leaf = certs.first else { throw Failure.unusable }
        SecItemDelete([kSecClass as String: kSecClassCertificate, kSecAttrLabel as String: Self.certLabel(account)] as CFDictionary)
        let add = SecItemAdd([
            kSecClass as String: kSecClassCertificate,
            kSecValueRef as String: leaf,
            kSecAttrLabel as String: Self.certLabel(account),
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ] as CFDictionary, nil)
        guard add == errSecSuccess || add == errSecDuplicateItem else { throw Failure.keychain(add) }
        var out: CFTypeRef?
        let st = SecItemCopyMatching([
            kSecClass as String: kSecClassIdentity,
            kSecAttrApplicationTag as String: Self.tag(account),
            kSecReturnRef as String: true,
        ] as CFDictionary, &out)
        guard st == errSecSuccess, let ref = out else { throw Failure.keychain(st) }
        let id = ref as! SecIdentity
        guard let identity = sec_identity_create_with_certificates(id, Array(certs.dropFirst()) as CFArray) else { throw Failure.unusable }
        return identity
    }
}

/// Terminates TLS for relayed streams with the phone's identity: a TLS listener bound to loopback, which only accepts
/// connections this process opened for a relayed stream (their local ports are registered before they connect), and
/// a minimal HTTP/1.1 server behind it (`PhoneEndpointResponder`).
final class PhoneTlsTerminator: @unchecked Sendable {
    private let queue = DispatchQueue(label: "flagship.phone-tls")
    private let listener: NWListener
    private let responder: PhoneEndpointResponder
    private var expected = Set<UInt16>()
    private(set) var port: NWEndpoint.Port?
    private var ready: [() -> Void] = []

    init(identity: sec_identity_t, responder: PhoneEndpointResponder) throws {
        let tls = NWProtocolTLS.Options()
        sec_protocol_options_set_local_identity(tls.securityProtocolOptions, identity)
        sec_protocol_options_set_min_tls_protocol_version(tls.securityProtocolOptions, .TLSv12)
        let params = NWParameters(tls: tls)
        params.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
        params.acceptLocalOnly = true
        listener = try NWListener(using: params)
        self.responder = responder
        listener.newConnectionHandler = { [weak self] c in self?.accept(c) }
        listener.stateUpdateHandler = { [weak self] st in
            guard let self, case .ready = st else { return }
            self.port = self.listener.port
            let r = self.ready
            self.ready = []
            r.forEach { $0() }
        }
        listener.start(queue: queue)
    }

    func whenReady(_ fn: @escaping () -> Void) {
        queue.async { self.port != nil ? fn() : self.ready.append(fn) }
    }

    func expect(_ port: UInt16) { queue.async { self.expected.insert(port) } }

    func stop() { listener.cancel() }

    private func accept(_ c: NWConnection, retried: Bool = false) {
        guard case .hostPort(_, let remotePort) = c.endpoint else {
            c.cancel()
            return
        }
        guard expected.remove(remotePort.rawValue) != nil else {
            // Our own connection may report its local port a moment after the listener sees it; anything else is
            // another process on this device and is refused.
            if retried { c.cancel() } else { queue.asyncAfter(deadline: .now() + 0.3) { self.accept(c, retried: true) } }
            return
        }
        var reader = HttpRequestReader()
        func read() {
            c.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) { [responder] data, _, done, err in
                if let data, !data.isEmpty {
                    do {
                        if let (head, body) = try reader.push(data) {
                            c.send(content: responder.respond(head, body: body), isComplete: true, completion: .contentProcessed { _ in c.cancel() })
                            return
                        }
                    } catch {
                        c.cancel()
                        return
                    }
                }
                if done || err != nil { c.cancel() } else { read() }
            }
        }
        c.start(queue: queue)
        read()
    }
}

public enum PhoneTunnelState: Equatable, Sendable {
    case connecting, claiming, holding(generation: Int64), lost(String), refused(String), closed
}

/// The phone's outbound tunnel (`/phone-tunnel`), held only while the app is in the foreground: begin, sign the
/// relay's offered claim with the account device key, serve relayed streams through `PhoneTlsTerminator`. It never
/// re-acquires on its own after a loss or a refusal; the next foreground does.
public final class PhoneTunnelClient: @unchecked Sendable {
    private let url: URL
    private let account: String
    private let hostname: String
    private let deviceKey: Curve25519.Signing.PrivateKey
    private let terminator: PhoneTlsTerminator
    private let onState: @Sendable (PhoneTunnelState) -> Void
    private let queue = DispatchQueue(label: "flagship.phone-tunnel")
    private var task: URLSessionWebSocketTask?
    private var streams: [UInt32: NWConnection] = [:]
    private var beat: DispatchSourceTimer?
    public let responder: PhoneEndpointResponder

    public init(url: URL, account: String, apex: String, deviceKey: Curve25519.Signing.PrivateKey, identity: sec_identity_t,
                onState: @escaping @Sendable (PhoneTunnelState) -> Void) throws {
        self.url = url
        self.account = account.lowercased()
        self.hostname = PhoneRoute.hostname(account: account, apex: apex)
        self.deviceKey = deviceKey
        self.onState = onState
        responder = PhoneEndpointResponder(account: self.account, hostname: hostname,
                                           phoneRoutePub: HexUtil.encode(deviceKey.publicKey.rawRepresentation))
        terminator = try PhoneTlsTerminator(identity: identity, responder: responder)
    }

    public func start() {
        onState(.connecting)
        let t = URLSession.shared.webSocketTask(with: url)
        task = t
        t.resume()
        receive(t)
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now() + PhoneRoute.beatSeconds, repeating: PhoneRoute.beatSeconds)
        timer.setEventHandler { [weak self] in self?.task?.send(.string(#"{"type":"beat"}"#)) { _ in } }
        timer.resume()
        beat = timer
    }

    /// Leaving the foreground: give the route up and close.
    public func stop() {
        beat?.cancel()
        beat = nil
        task?.send(.string(#"{"type":"release"}"#)) { _ in }
        task?.cancel(with: .normalClosure, reason: nil)
        task = nil
        queue.async {
            self.streams.values.forEach { $0.cancel() }
            self.streams.removeAll()
        }
        terminator.stop()
    }

    private func receive(_ t: URLSessionWebSocketTask) {
        t.receive { [weak self] result in
            guard let self else { return }
            switch result {
            case .failure:
                self.queue.async {
                    self.streams.values.forEach { $0.cancel() }
                    self.streams.removeAll()
                }
                self.onState(.closed)
            case .success(.string(let s)):
                self.control(s, t)
                self.receive(t)
            case .success(.data(let d)):
                self.queue.async { self.frame(d, t) }
                self.receive(t)
            case .success:
                self.receive(t)
            }
        }
    }

    /// The claim for a challenge, only if it names exactly this account's bare name.
    func claim(for m: [String: Any], now: Int64 = Int64(Date().timeIntervalSince1970 * 1000)) -> RouteClaim? {
        guard m["account"] as? String == account, m["hostname"] as? String == hostname,
              let g = (m["generation"] as? NSNumber)?.int64Value, let nonce = m["sessionNonce"] as? String else { return nil }
        let c = RouteClaim(account: account, phoneRoutePub: HexUtil.encode(deviceKey.publicKey.rawRepresentation), hostname: hostname,
                           generation: g, sessionNonce: nonce, issuedAt: now)
        return (try? c.canonicalBytes()) == nil ? nil : c
    }

    private func control(_ s: String, _ t: URLSessionWebSocketTask) {
        guard let m = (try? JSONSerialization.jsonObject(with: Data(s.utf8))) as? [String: Any] else { return }
        switch m["type"] as? String {
        case "hello":
            onState(.claiming)
            let msg = try? JSONSerialization.data(withJSONObject: ["type": "begin", "account": account])
            t.send(.string(String(decoding: msg ?? Data(), as: UTF8.self))) { _ in }
        case "challenge":
            guard let c = claim(for: m), let bytes = try? c.canonicalBytes(), let sig = try? PhoneRoute.signEd25519(bytes, key: deviceKey) else {
                onState(.refused("bad-challenge"))
                return
            }
            let body: [String: Any] = [
                "type": "claim",
                "claim": ["account": c.account, "phoneRoutePub": c.phoneRoutePub, "hostname": c.hostname, "generation": c.generation,
                          "sessionNonce": c.sessionNonce, "issuedAt": c.issuedAt],
                "signature": sig,
            ]
            let msg = try? JSONSerialization.data(withJSONObject: body)
            t.send(.string(String(decoding: msg ?? Data(), as: UTF8.self))) { _ in }
        case "granted": onState(.holding(generation: (m["generation"] as? NSNumber)?.int64Value ?? 0))
        case "refused": onState(.refused(m["code"] as? String ?? "refused"))
        case "lost": onState(.lost(m["reason"] as? String ?? "lost"))
        default: break
        }
    }

    private func frame(_ d: Data, _ t: URLSessionWebSocketTask) {
        guard let f = TunnelFrames.decode(d) else { return }
        switch f.type {
        case TunnelFrames.open:
            guard String(decoding: f.payload, as: UTF8.self).lowercased() == hostname, streams.count < 64 else {
                t.send(.data(TunnelFrames.encode(f.streamId, TunnelFrames.close))) { _ in }
                return
            }
            open(f.streamId, t)
        case TunnelFrames.data:
            streams[f.streamId]?.send(content: f.payload, completion: .idempotent)
        case TunnelFrames.close, TunnelFrames.closeRemote:
            streams.removeValue(forKey: f.streamId)?.cancel()
        default:
            break
        }
    }

    /// One relayed stream: a loopback connection into the TLS listener, its local port registered first.
    private func open(_ id: UInt32, _ t: URLSessionWebSocketTask) {
        terminator.whenReady { [weak self] in
            guard let self, let port = self.terminator.port else { return }
            let params = NWParameters.tcp
            let c = NWConnection(host: "127.0.0.1", port: port, using: params)
            self.queue.async {
                self.streams[id] = c
                c.stateUpdateHandler = { [weak self] st in
                    guard let self else { return }
                    if case .preparing = st, case .hostPort(_, let p)? = c.currentPath?.localEndpoint { self.terminator.expect(p.rawValue) }
                    if case .ready = st, case .hostPort(_, let p)? = c.currentPath?.localEndpoint { self.terminator.expect(p.rawValue) }
                    if case .failed = st { self.end(id, t) }
                    if case .cancelled = st { self.end(id, t) }
                }
                c.start(queue: self.queue)
                self.pump(id, c, t)
            }
        }
    }

    private func pump(_ id: UInt32, _ c: NWConnection, _ t: URLSessionWebSocketTask) {
        c.receive(minimumIncompleteLength: 1, maximumLength: 256 * 1024) { [weak self] data, _, done, err in
            guard let self else { return }
            if let data, !data.isEmpty { t.send(.data(TunnelFrames.encode(id, TunnelFrames.data, data))) { _ in } }
            if done || err != nil { self.end(id, t) } else { self.pump(id, c, t) }
        }
    }

    private func end(_ id: UInt32, _ t: URLSessionWebSocketTask) {
        queue.async {
            guard let c = self.streams.removeValue(forKey: id) else { return }
            c.cancel()
            t.send(.data(TunnelFrames.encode(id, TunnelFrames.close))) { _ in }
        }
    }
}
