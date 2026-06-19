import Foundation

/// Gating v2 (docs/service-access-gating.md, "## v2 hardening") — the AUTHOR's
/// local cache of the SIGNED create envelope, keyed by inviteId.
///
/// Why this exists: in the MANUAL-approve loop the author FINALIZES the bind by
/// POSTing `{accept, acceptSig, create, createSig}` to their box, which verifies
/// the owner's create authority ITSELF (box-as-authority). `.com`'s invite
/// listing does NOT return the create SIGNATURE (only metadata), so the author
/// can't reconstruct the signed create from `.com`. The author IS the creator, so
/// they persist the exact create + its AID signature here at create time and
/// replay it when a consumer's acceptance reply comes back.
///
/// Privacy / safety: this never leaves the device; losing it only means a
/// manual-approve invite created on THIS device can't be finalized from it
/// (re-issue the invite). It holds NO secret (the capability secret is never
/// stored — only the secretHash, which `.com` already holds). Single-blob
/// UserDefaults keyed by `flagship.inviteCreateStore.v1`, a
/// `[String /* inviteId */: StoredInviteCreate]` map.
public struct StoredInviteCreate: Codable, Equatable, Sendable {
    public var inviteId: String
    public var authorAidHex: String
    public var serviceRef: String
    public var secretHash: String
    public var encryptedBundle: String
    public var issuedAt: Int64
    public var maxRedemptions: Int?
    public var expiresAt: Int64?
    /// The author's AID signature over the create canonical bytes (lower hex).
    public var createSigHex: String

    public init(
        inviteId: String, authorAidHex: String, serviceRef: String, secretHash: String,
        encryptedBundle: String, issuedAt: Int64, maxRedemptions: Int? = nil,
        expiresAt: Int64? = nil, createSigHex: String
    ) {
        self.inviteId = inviteId
        self.authorAidHex = authorAidHex.lowercased()
        self.serviceRef = serviceRef
        self.secretHash = secretHash
        self.encryptedBundle = encryptedBundle
        self.issuedAt = issuedAt
        self.maxRedemptions = maxRedemptions
        self.expiresAt = expiresAt
        self.createSigHex = createSigHex.lowercased()
    }

    /// The `create` carrier dict the box's `/api/service-access/accept` expects
    /// (the exact fields `verifyComCreate` parses). Numbers stay numeric.
    public var createDict: [String: Any] {
        var d: [String: Any] = [
            "inviteId": inviteId,
            "authorAID": authorAidHex,
            "serviceRef": serviceRef,
            "secretHash": secretHash,
            "encryptedBundle": encryptedBundle,
            "issuedAt": issuedAt,
        ]
        if let maxRedemptions { d["maxRedemptions"] = maxRedemptions }
        if let expiresAt { d["expiresAt"] = expiresAt }
        return d
    }
}

public protocol InviteCreateStore: Sendable {
    func put(_ create: StoredInviteCreate)
    func get(inviteId: String) -> StoredInviteCreate?
    func remove(inviteId: String)
}

public final class UserDefaultsInviteCreateStore: InviteCreateStore, @unchecked Sendable {
    private let defaults: UserDefaults
    private let storageKey: String
    private let lock = NSLock()

    public init(defaults: UserDefaults = .standard, storageKey: String = "flagship.inviteCreateStore.v1") {
        self.defaults = defaults
        self.storageKey = storageKey
    }

    public func put(_ create: StoredInviteCreate) {
        lock.lock(); defer { lock.unlock() }
        var blob = readBlob()
        blob[create.inviteId.lowercased()] = create
        writeBlob(blob)
    }

    public func get(inviteId: String) -> StoredInviteCreate? {
        lock.lock(); defer { lock.unlock() }
        return readBlob()[inviteId.lowercased()]
    }

    public func remove(inviteId: String) {
        lock.lock(); defer { lock.unlock() }
        var blob = readBlob()
        blob.removeValue(forKey: inviteId.lowercased())
        writeBlob(blob)
    }

    private func readBlob() -> [String: StoredInviteCreate] {
        guard let data = defaults.data(forKey: storageKey),
              let decoded = try? JSONDecoder().decode([String: StoredInviteCreate].self, from: data)
        else { return [:] }
        return decoded
    }

    private func writeBlob(_ blob: [String: StoredInviteCreate]) {
        guard let data = try? JSONEncoder().encode(blob) else { return }
        defaults.set(data, forKey: storageKey)
    }
}

public final class InMemoryInviteCreateStore: InviteCreateStore, @unchecked Sendable {
    private var blob: [String: StoredInviteCreate] = [:]
    private let lock = NSLock()
    public init() {}
    public func put(_ create: StoredInviteCreate) {
        lock.lock(); defer { lock.unlock() }
        blob[create.inviteId.lowercased()] = create
    }
    public func get(inviteId: String) -> StoredInviteCreate? {
        lock.lock(); defer { lock.unlock() }
        return blob[inviteId.lowercased()]
    }
    public func remove(inviteId: String) {
        lock.lock(); defer { lock.unlock() }
        blob.removeValue(forKey: inviteId.lowercased())
    }
}
