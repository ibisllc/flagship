import Foundation
import CryptoKit
import FlagshipAPI

/// Architecture v2 milestone 2: ML-DSA-65 keys for the phone-held identities (account IRK,
/// admin root, this device's account device key) and their `flagship/pq-key-binding/v1`
/// bindings on `.com` (docs/architecture-v2/pq-suites.md §9).
///
/// Each identity's ML-DSA key is made on the device that holds the identity, fresh from the OS
/// RNG, and never leaves it: never derived from the UMK, exported, escrowed, or put in a pairing
/// bundle or recovery record. `.com` keeps the first ML-DSA key per Ed25519 key, so the IRK and
/// admin root are bound by whichever device holds them first; other devices act under strict
/// through their own `device` binding. A recovery that restores a root classically therefore
/// cannot rebind it (409), and a rotated IRK is only accepted once the re-pair's wait/veto has
/// completed (until then `.com` refuses it and this device retries at a later unlock).

/// How a PQ private key is held, as the app will show it. The two labels are fixed wording.
public enum PqCustody: String, Codable, Sendable {
    /// ML-DSA-65 inside the Secure Enclave (iOS 26+), non-exportable.
    case hardware = "secure-enclave"
    /// A software ML-DSA-65 seed sealed to a Secure Enclave key that needs Face ID / passcode.
    case hardwareWrapped = "software-hardware-wrapped"

    public var label: String {
        switch self {
        case .hardware: return "hardware PQ"
        case .hardwareWrapped: return "PQ, hardware-wrapped"
        }
    }
}

/// One identity the device can bind now: its role, subject and the Ed25519 private key at hand.
public struct PqIdentity: Sendable {
    public let role: PqBindingRole
    public let subjectId: String
    public let edKey: Curve25519.Signing.PrivateKey
    public init(role: PqBindingRole, subjectId: String, edKey: Curve25519.Signing.PrivateKey) {
        self.role = role; self.subjectId = subjectId.lowercased(); self.edKey = edKey
    }
    public var edPubHex: String { PqBin.hex(PqBytes(edKey.publicKey.rawRepresentation)) }
}

/// A PQ key the store holds for one identity.
public struct PqHeldKey: Sendable {
    public let mldsaPubHex: String
    public let custody: PqCustody
    /// ML-DSA-65 over (message, context); must not prompt (the store only returns a key it can
    /// use without one).
    public let sign: @Sendable (_ message: [UInt8], _ context: [UInt8]) throws -> [UInt8]
    public init(mldsaPubHex: String, custody: PqCustody, sign: @escaping @Sendable ([UInt8], [UInt8]) throws -> [UInt8]) {
        self.mldsaPubHex = mldsaPubHex; self.custody = custody; self.sign = sign
    }
}

public enum PqBindingStatus: String, Codable, Sendable {
    case pending, bound
    /// `.com` holds another ML-DSA key for this Ed25519 key (another device bound it first).
    case boundElsewhere = "bound-elsewhere"
}

/// Where the device keeps its identity PQ keys (iOS: `PqKeyStore` in the Flagship target).
public protocol PqIdentityKeyStore: Sendable {
    /// The key for this identity, made now if there is none, or nil when it cannot be used
    /// without prompting (the caller defers).
    func key(for identity: PqIdentity) async -> PqHeldKey?
    func status(for identity: PqIdentity) -> PqBindingStatus?
    func setStatus(_ status: PqBindingStatus, for identity: PqIdentity)
    /// Forget this identity's unused PQ key (another device's binding won).
    func discard(_ identity: PqIdentity)
}

public enum PqBindingPutOutcome: Equatable, Sendable {
    case stored
    case alreadyStored
    case boundElsewhere
    case retryLater(String)
}

public struct PqAccountBindings: Equatable, Sendable {
    public var accountIrk: PqKeyBindingWire?
    public var adminRoot: PqKeyBindingWire?
    public var devices: [PqKeyBindingWire]
}

/// `PUT/GET {com}/api/accounts/:u/pq-key-bindings`.
public protocol PqKeyBindingClient: Sendable {
    func put(username: String, binding: PqKeyBindingWire) async -> PqBindingPutOutcome
    func fetch(username: String) async throws -> PqAccountBindings?
}

public final class LivePqKeyBindingClient: PqKeyBindingClient, @unchecked Sendable {
    private let urlSession: URLSession
    private let baseUrl: URL
    private let readTokens: (any AccountReadTokenSource)?

    public init(urlSession: URLSession = .shared, baseUrl: URL = Endpoints.controlBaseUrl, readTokens: (any AccountReadTokenSource)? = nil) {
        self.urlSession = urlSession; self.baseUrl = baseUrl; self.readTokens = readTokens
    }

    private func url(_ username: String) -> URL {
        let u = username.lowercased().addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? username
        return baseUrl.appendingPathComponent("/api/accounts/\(u)/pq-key-bindings")
    }

    public func put(username: String, binding: PqKeyBindingWire) async -> PqBindingPutOutcome {
        var req = URLRequest(url: url(username))
        req.httpMethod = "PUT"
        req.setValue("application/json", forHTTPHeaderField: "content-type")
        req.httpBody = try? JSONEncoder().encode(binding)
        do {
            let (data, resp) = try await urlSession.gatedData(for: req)
            return Self.outcome(status: (resp as? HTTPURLResponse)?.statusCode ?? 0, body: data)
        } catch {
            return .retryLater("network")
        }
    }

    static func outcome(status: Int, body: Data) -> PqBindingPutOutcome {
        let error = (try? JSONSerialization.jsonObject(with: body) as? [String: Any])?["error"] as? String
        switch (status, error) {
        case (200..<300, _): return .stored
        case (409, "stale"): return .alreadyStored
        case (409, "pq-key-changed"): return .boundElsewhere
        default: return .retryLater(error ?? "http \(status)")
        }
    }

    public func fetch(username: String) async throws -> PqAccountBindings? {
        var req = URLRequest(url: url(username))
        req.httpMethod = "GET"
        req.cachePolicy = .reloadIgnoringLocalCacheData
        if let token = await readTokens?.token(for: username) { req.setValue("Bearer \(token)", forHTTPHeaderField: "authorization") }
        let (data, resp) = try await urlSession.gatedData(for: req)
        let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
        if status == 404 { return nil }
        guard (200..<300).contains(status) else { throw ScreensClientError.http(status: status, message: String(data: data, encoding: .utf8) ?? "") }
        return Self.parse(data)
    }

    /// `GET {com}/api/accounts/:u/assurance-policy/:kind/:id`: the scope's chained, owner-signed
    /// policy changes. Callers replay them with `AssurancePolicy.replay` under keys they trust;
    /// `.com`'s own `state` is never taken on its word. Nil when the scope has no chain.
    public func fetchPolicyChain(username: String, scope: PolicyScope) async throws -> [AssurancePolicy.SignedChange]? {
        let u = username.lowercased().addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? username
        let id = scope.id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? scope.id
        var req = URLRequest(url: baseUrl.appendingPathComponent("/api/accounts/\(u)/assurance-policy/\(scope.kind.rawValue)/\(id)"))
        req.httpMethod = "GET"
        req.cachePolicy = .reloadIgnoringLocalCacheData
        if let token = await readTokens?.token(for: username) { req.setValue("Bearer \(token)", forHTTPHeaderField: "authorization") }
        let (data, resp) = try await urlSession.gatedData(for: req)
        let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
        if status == 404 { return nil }
        guard (200..<300).contains(status) else { throw ScreensClientError.http(status: status, message: String(data: data, encoding: .utf8) ?? "") }
        struct Body: Decodable { let chain: [AssurancePolicy.SignedChange] }
        return try JSONDecoder().decode(Body.self, from: data).chain
    }

    /// The served chain with `.com`'s `evidence.recoveryChecked` (the readiness check shows it).
    public func fetchPolicy(username: String, scope: PolicyScope) async throws -> (chain: [AssurancePolicy.SignedChange], recoveryChecked: Bool) {
        let u = username.lowercased().addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? username
        let id = scope.id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? scope.id
        var req = URLRequest(url: baseUrl.appendingPathComponent("/api/accounts/\(u)/assurance-policy/\(scope.kind.rawValue)/\(id)"))
        req.cachePolicy = .reloadIgnoringLocalCacheData
        if let token = await readTokens?.token(for: username) { req.setValue("Bearer \(token)", forHTTPHeaderField: "authorization") }
        let (data, resp) = try await urlSession.gatedData(for: req)
        let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
        if status == 404 { return ([], false) }
        guard (200..<300).contains(status) else { throw ScreensClientError.http(status: status, message: String(data: data, encoding: .utf8) ?? "") }
        struct Ev: Decodable { let recoveryChecked: Bool? }
        struct Body: Decodable { let chain: [AssurancePolicy.SignedChange]; let evidence: Ev? }
        let b = try JSONDecoder().decode(Body.self, from: data)
        return (b.chain, b.evidence?.recoveryChecked ?? false)
    }

    /// `POST {com}/api/accounts/:u/assurance-policy`: nil when stored, else `.com`'s refusal code.
    public func postPolicyChange(username: String, change: AssurancePolicyChange, signature: SignatureEnvelope) async -> String? {
        let u = username.lowercased().addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? username
        var req = URLRequest(url: baseUrl.appendingPathComponent("/api/accounts/\(u)/assurance-policy"))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "content-type")
        struct Body: Encodable { let change: AssurancePolicyChange; let signature: SignatureEnvelope }
        req.httpBody = try? JSONEncoder().encode(Body(change: change, signature: signature))
        do {
            let (data, resp) = try await urlSession.gatedData(for: req)
            let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
            if (200..<300).contains(status) { return nil }
            let o = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            return (o?["code"] as? String) ?? (o?["error"] as? String) ?? "http \(status)"
        } catch {
            return "network"
        }
    }

    /// `GET {com}/api/server/:host/pq-key-binding` as JSON (verified by the caller under its pin).
    public func fetchServerBinding(serverDomain: String) async -> Any? {
        let h = serverDomain.lowercased().addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? serverDomain
        var req = URLRequest(url: baseUrl.appendingPathComponent("/api/server/\(h)/pq-key-binding"))
        req.cachePolicy = .reloadIgnoringLocalCacheData
        guard let (data, resp) = try? await urlSession.gatedData(for: req), (resp as? HTTPURLResponse)?.statusCode == 200 else { return nil }
        return try? JSONSerialization.jsonObject(with: data)
    }

    /// The account's live devices and how many have a PQ binding (`/api/users/:u/device-grants`).
    public func deviceBindingCounts(username: String) async -> (devices: Int, bound: Int)? {
        let u = username.lowercased().addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? username
        var req = URLRequest(url: baseUrl.appendingPathComponent("/api/users/\(u)/device-grants"))
        req.cachePolicy = .reloadIgnoringLocalCacheData
        if let token = await readTokens?.token(for: username) { req.setValue("Bearer \(token)", forHTTPHeaderField: "authorization") }
        guard let (data, resp) = try? await urlSession.gatedData(for: req), (resp as? HTTPURLResponse)?.statusCode == 200,
              let o = try? JSONSerialization.jsonObject(with: data) as? [String: Any], let grants = o["grants"] as? [[String: Any]] else { return nil }
        var seen: [String: Bool] = [:]
        for g in grants {
            guard let id = g["deviceId"] as? String else { continue }
            seen[id] = (seen[id] ?? false) || g["pqKeyBinding"] is [String: Any]
        }
        return (seen.count, seen.values.filter { $0 }.count)
    }

    /// Parses the GET body; wires that fail the strict wire shape are dropped.
    static func parse(_ data: Data) -> PqAccountBindings? {
        guard let o = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        func one(_ v: Any?) -> PqKeyBindingWire? { try? PqTrust.pqKeyBindingFromWire(v) }
        return PqAccountBindings(accountIrk: one(o["accountIrk"]), adminRoot: one(o["adminRoot"]),
                                 devices: ((o["devices"] as? [Any]) ?? []).compactMap(one))
    }
}

/// Makes and uploads the bindings for whatever identities are at hand. Never prompts: it only
/// runs on keys the caller already holds (an unlocked session, a creation flow), and anything it
/// cannot finish stays pending for the next run.
public actor PqIdentityBinder {
    private let store: any PqIdentityKeyStore
    private let client: any PqKeyBindingClient
    private let now: @Sendable () -> Int64

    public init(store: any PqIdentityKeyStore, client: any PqKeyBindingClient,
                now: @escaping @Sendable () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) }) {
        self.store = store; self.client = client; self.now = now
    }

    /// Binds each identity not yet bound. `remote` (`.com`'s current bindings, when the caller
    /// could read them) lets a role another device already bound be skipped before a key is made.
    @discardableResult
    public func run(username: String, identities: [PqIdentity], remote: PqAccountBindings? = nil) async -> [PqBindingRole: PqBindingStatus] {
        var out: [PqBindingRole: PqBindingStatus] = [:]
        for id in identities {
            if let s = store.status(for: id), s != .pending { out[id.role] = s; continue }
            if let other = Self.remoteWire(remote, for: id), other.ed25519PubHex == id.edPubHex {
                if let held = await store.key(for: id), held.mldsaPubHex == other.mldsaPubHex {
                    store.setStatus(.bound, for: id); out[id.role] = .bound
                } else {
                    store.discard(id); store.setStatus(.boundElsewhere, for: id); out[id.role] = .boundElsewhere
                }
                continue
            }
            guard let held = await store.key(for: id), let wire = try? Self.sign(id, held, issuedAt: now()) else {
                out[id.role] = .pending
                continue
            }
            switch await client.put(username: username, binding: wire) {
            case .stored, .alreadyStored:
                store.setStatus(.bound, for: id); out[id.role] = .bound
            case .boundElsewhere:
                store.discard(id); store.setStatus(.boundElsewhere, for: id); out[id.role] = .boundElsewhere
            case .retryLater:
                out[id.role] = .pending
            }
        }
        return out
    }

    static func remoteWire(_ remote: PqAccountBindings?, for id: PqIdentity) -> PqKeyBindingWire? {
        guard let remote else { return nil }
        switch id.role {
        case .accountIrk: return remote.accountIrk
        case .adminRoot: return remote.adminRoot
        case .device: return remote.devices.first { $0.subjectId == id.subjectId }
        case .boxStk, .bootKey: return nil
        }
    }

    /// The binding for `id` under `held`, checked locally before it is sent.
    public static func sign(_ id: PqIdentity, _ held: PqHeldKey, issuedAt: Int64) throws -> PqKeyBindingWire {
        let statement = PqKeyBindingStatement(role: id.role.rawValue, subjectId: id.subjectId, ed25519PubHex: id.edPubHex,
                                              mldsaPubHex: held.mldsaPubHex, issuedAt: issuedAt)
        guard let mlPub = PqBin.unhex(held.mldsaPubHex) else { throw PqTrustError("binding-malformed") }
        let edPub = PqBytes(id.edKey.publicKey.rawRepresentation)
        let wire = try PqTrust.signPqKeyBinding(statement) { purpose, payload in
            try PqHybrid.hybridSign(edPublicKey: edPub, mldsaPublicKey: mlPub, purpose: purpose, payload: payload,
                                    edSign: { PqBytes(try id.edKey.signature(for: $0)) }, mldsaSign: held.sign)
        }
        _ = try PqTrust.verifyPqKeyBinding(wire, PqBindingExpectation(role: id.role.rawValue, subjectId: id.subjectId,
                                                                      ed25519PubHex: id.edPubHex, now: issuedAt))
        return wire
    }
}

#if DEBUG
/// A software key store for tests, previews and the mock gym: the seed is kept in memory.
public final class InMemoryPqIdentityKeyStore: PqIdentityKeyStore, @unchecked Sendable {
    private let lock = NSLock()
    private var seeds: [String: [UInt8]] = [:]
    private var statuses: [String: PqBindingStatus] = [:]
    public var available = true
    public init() {}

    private func k(_ id: PqIdentity) -> String { "\(id.role.rawValue)|\(id.subjectId)|\(id.edPubHex)" }

    public func key(for identity: PqIdentity) async -> PqHeldKey? { keySync(identity) }

    private func keySync(_ identity: PqIdentity) -> PqHeldKey? {
        lock.lock(); defer { lock.unlock() }
        guard available else { return nil }
        let seed = seeds[k(identity)] ?? PqHybrid.randomSeed()
        seeds[k(identity)] = seed
        guard let pub = try? PqHybrid.mldsa65PublicKey(seed: seed) else { return nil }
        return PqHeldKey(mldsaPubHex: PqBin.hex(pub), custody: .hardwareWrapped) { m, ctx in
            try PqHybrid.mldsa65Sign(seed: seed, message: m, context: ctx)
        }
    }

    public func status(for identity: PqIdentity) -> PqBindingStatus? {
        lock.lock(); defer { lock.unlock() }
        return statuses[k(identity)]
    }

    public func setStatus(_ status: PqBindingStatus, for identity: PqIdentity) {
        lock.lock(); defer { lock.unlock() }
        statuses[k(identity)] = status
    }

    public func discard(_ identity: PqIdentity) {
        lock.lock(); defer { lock.unlock() }
        seeds[k(identity)] = nil
    }
}

/// A `.com` stand-in for tests and the mock gym, with the server contract's rules: the binding
/// must verify under the account's current key for its role, and the first ML-DSA key per
/// Ed25519 key wins.
public final class MockPqKeyBindingClient: PqKeyBindingClient, @unchecked Sendable {
    private let lock = NSLock()
    public var currentKeys: [String: String] = [:]
    public private(set) var stored: [String: PqKeyBindingWire] = [:]
    public var offline = false
    public init() {}

    private static func slot(_ w: PqKeyBindingWire) -> String { "\(w.role)|\(w.subjectId)" }

    public func put(username: String, binding: PqKeyBindingWire) async -> PqBindingPutOutcome { putSync(binding) }

    private func putSync(_ binding: PqKeyBindingWire) -> PqBindingPutOutcome {
        lock.lock(); defer { lock.unlock() }
        if offline { return .retryLater("network") }
        guard let trusted = currentKeys[Self.slot(binding)] else { return .retryLater("binding-key-mismatch") }
        do {
            _ = try PqTrust.verifyPqKeyBinding(binding, PqBindingExpectation(role: binding.role, subjectId: binding.subjectId,
                                                                              ed25519PubHex: trusted, now: binding.issuedAt))
        } catch let e as PqTrustError {
            return .retryLater(e.code)
        } catch {
            return .retryLater("bad-signature")
        }
        if let cur = stored[Self.slot(binding)], cur.ed25519PubHex == binding.ed25519PubHex {
            if cur.mldsaPubHex != binding.mldsaPubHex { return .boundElsewhere }
            if binding.issuedAt <= cur.issuedAt { return .alreadyStored }
        }
        stored[Self.slot(binding)] = binding
        return .stored
    }

    public func fetch(username: String) async throws -> PqAccountBindings? { fetchSync(username) }

    private func fetchSync(_ username: String) -> PqAccountBindings? {
        lock.lock(); defer { lock.unlock() }
        return PqAccountBindings(accountIrk: stored["account-irk|\(username.lowercased())"],
                                 adminRoot: stored["admin-root|\(username.lowercased())"],
                                 devices: stored.filter { $0.key.hasPrefix("device|") }.map(\.value))
    }

    /// Seed a binding as if another device had made it.
    public func preload(_ w: PqKeyBindingWire) {
        lock.lock(); defer { lock.unlock() }
        stored[Self.slot(w)] = w
    }
}
#endif
