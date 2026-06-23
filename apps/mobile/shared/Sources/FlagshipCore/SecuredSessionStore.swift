import Foundation

/// Web-experience gating (docs/service-access-gating.md, "Web-experience
/// gating"). When THIS phone authorizes a browser's QR-login knock, the box
/// hands back a phone-held `secretId` (never the browser). The phone keeps the
/// session locally so the owner can later see, refresh (online/offline), and
/// stop the browser sessions they opened from Settings → "Open secured
/// sessions".
///
/// Persistence: UserDefaults under one JSON blob keyed by
/// `flagship.securedSessions.v1` — a `[secretId: SecuredSession]` map. The
/// secretId is the box's session-status / session-close handle; it's already a
/// bearer to "poll/close THIS session" and nothing more (no account key, no
/// content), so UserDefaults is the right floor: losing it just means the owner
/// loses the in-app handle to a session that still expires on its own on the
/// box. Mirrors `InviteLabelBook`'s single-blob, lock-guarded shape.
public struct SecuredSession: Codable, Equatable, Sendable, Identifiable {
    /// The 64-hex phone-held session handle. Rides the BODY of status/close
    /// (never a URL) so it can't land in the box's access logs.
    public var secretId: String
    /// The box fqdn the session lives on (the `serverId` the authorize bound).
    public var serverId: String
    /// The `<creator>--<slug>` ref the box keys the allow-list on.
    public var serviceRef: String
    /// The canonical `https://<svc>.<server>` URL the browser is viewing —
    /// what the owner recognizes the session by. Display only.
    public var serviceUrl: String
    /// The browser User-Agent the box recorded at page-serve.
    public var browserAgent: String
    /// Unix-ms the session started (the box's authorize timestamp).
    public var startedAt: Int64

    public var id: String { secretId }

    public init(secretId: String, serverId: String, serviceRef: String, serviceUrl: String, browserAgent: String, startedAt: Int64) {
        self.secretId = secretId.lowercased()
        self.serverId = serverId
        self.serviceRef = serviceRef
        self.serviceUrl = serviceUrl
        self.browserAgent = browserAgent
        self.startedAt = startedAt
    }

    /// Build the canonical service URL the owner recognizes the session by:
    /// `https://<svc>.<server>` — or `https://<server>` if no svc label was
    /// carried (the box still routes the apex). Mirrors the deeplink's
    /// `svc`/`server` pairing.
    public static func serviceUrl(svc: String, serverDomain: String) -> String {
        let host = serverDomain.trimmingCharacters(in: CharacterSet(charactersIn: "/ "))
        let label = svc.trimmingCharacters(in: .whitespacesAndNewlines)
        return label.isEmpty ? "https://\(host)" : "https://\(label).\(host)"
    }
}

public protocol SecuredSessionStoring: Sendable {
    /// Persist (or replace) a session, keyed by its secretId.
    func put(_ session: SecuredSession)
    /// All held sessions, most-recently-started first.
    func list() -> [SecuredSession]
    /// Drop a session by secretId (after a Stop, or once it's no longer wanted).
    func remove(secretId: String)
}

/// UserDefaults-backed implementation. Single-blob storage keeps the write
/// path lock-free + race-free for the handful of sessions the owner holds.
public final class UserDefaultsSecuredSessionStore: SecuredSessionStoring, @unchecked Sendable {
    private let defaults: UserDefaults
    private let storageKey: String
    private let lock = NSLock()

    public init(defaults: UserDefaults = .standard, storageKey: String = "flagship.securedSessions.v1") {
        self.defaults = defaults
        self.storageKey = storageKey
    }

    public func put(_ session: SecuredSession) {
        lock.lock(); defer { lock.unlock() }
        var blob = readBlob()
        blob[session.secretId] = session
        writeBlob(blob)
    }

    public func list() -> [SecuredSession] {
        lock.lock(); defer { lock.unlock() }
        return readBlob().values.sorted { $0.startedAt > $1.startedAt }
    }

    public func remove(secretId: String) {
        lock.lock(); defer { lock.unlock() }
        var blob = readBlob()
        blob.removeValue(forKey: secretId.lowercased())
        writeBlob(blob)
    }

    private func readBlob() -> [String: SecuredSession] {
        guard let data = defaults.data(forKey: storageKey),
              let decoded = try? JSONDecoder().decode([String: SecuredSession].self, from: data)
        else { return [:] }
        return decoded
    }

    private func writeBlob(_ blob: [String: SecuredSession]) {
        guard let data = try? JSONEncoder().encode(blob) else { return }
        defaults.set(data, forKey: storageKey)
    }
}

/// In-memory implementation for previews + tests. Drop-in for the
/// UserDefaults-backed one without touching the global defaults store.
public final class InMemorySecuredSessionStore: SecuredSessionStoring, @unchecked Sendable {
    private var blob: [String: SecuredSession] = [:]
    private let lock = NSLock()

    public init() {}

    public func put(_ session: SecuredSession) {
        lock.lock(); defer { lock.unlock() }
        blob[session.secretId] = session
    }

    public func list() -> [SecuredSession] {
        lock.lock(); defer { lock.unlock() }
        return blob.values.sorted { $0.startedAt > $1.startedAt }
    }

    public func remove(secretId: String) {
        lock.lock(); defer { lock.unlock() }
        blob.removeValue(forKey: secretId.lowercased())
    }
}
