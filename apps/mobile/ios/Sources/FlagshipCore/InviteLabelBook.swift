import Foundation

/// P6 — owner-only label book that maps a per-app `opaqueTag` (16-byte
/// hex anonymization handle the client generates when issuing an invite)
/// to the local-only display label / channel / sent-to memo / notes.
///
/// **Privacy invariant**: this data NEVER leaves the device. The daemon
/// only sees `opaqueTag` + the redeemer's IRK pubkey hex after they
/// redeem; the human-readable "John (work)" mapping stays here. Mirrors
/// `apps/web/public/webapp/lib/labelBook.js` and Android's
/// `core/InviteLabelBook.kt`.
///
/// Persistence: UserDefaults under a single JSON blob keyed by
/// `flagship.inviteLabelBook.v1`. The blob is a `[String: LabelRow]`
/// map keyed by `"<serviceId>|<opaqueTagHex>"`. UserDefaults is the
/// right floor for "local-only metadata that's nice to have but losing
/// it is not catastrophic" — losing the labels never costs access (the
/// daemon's access rows survive).
public struct InviteLabel: Codable, Equatable, Sendable {
    /// Display name shown in the manage view (e.g. "John (work)").
    public var displayName: String
    /// Channel the link was shared over — drives the channel pill.
    public var channel: String
    /// Memo recording where the link was sent (phone, email, etc.).
    public var sentTo: String
    /// Free-form notes; capped at 2000 chars.
    public var notes: String
    /// Unix-ms when the row was persisted.
    public var sentAt: Int64

    public init(displayName: String, channel: String, sentTo: String, notes: String, sentAt: Int64) {
        self.displayName = displayName
        self.channel = channel
        self.sentTo = sentTo
        self.notes = notes
        self.sentAt = sentAt
    }
}

/// Stored row — the wire shape includes the routing key so list APIs
/// can avoid double-bookkeeping.
public struct InviteLabelRow: Codable, Equatable, Sendable, Identifiable {
    public var serviceId: String
    public var opaqueTagHex: String
    public var label: InviteLabel

    public var id: String { "\(serviceId)|\(opaqueTagHex)" }

    public init(serviceId: String, opaqueTagHex: String, label: InviteLabel) {
        self.serviceId = serviceId
        self.opaqueTagHex = opaqueTagHex.lowercased()
        self.label = label
    }
}

public protocol InviteLabelBook: Sendable {
    func put(serviceId: String, opaqueTagHex: String, label: InviteLabel)
    func get(serviceId: String, opaqueTagHex: String) -> InviteLabel?
    func list(serviceId: String) -> [InviteLabelRow]
    func remove(serviceId: String, opaqueTagHex: String)
}

/// UserDefaults-backed implementation. Single-blob storage keeps the
/// write path lock-free + race-free for the volumes we expect (tens of
/// invites per app).
public final class UserDefaultsInviteLabelBook: InviteLabelBook, @unchecked Sendable {
    private let defaults: UserDefaults
    private let storageKey: String
    private let lock = NSLock()

    public init(defaults: UserDefaults = .standard, storageKey: String = "flagship.inviteLabelBook.v1") {
        self.defaults = defaults
        self.storageKey = storageKey
    }

    public func put(serviceId: String, opaqueTagHex: String, label: InviteLabel) {
        lock.lock(); defer { lock.unlock() }
        var blob = readBlob()
        let key = makeKey(serviceId: serviceId, opaqueTagHex: opaqueTagHex)
        blob[key] = InviteLabelRow(
            serviceId: serviceId,
            opaqueTagHex: opaqueTagHex.lowercased(),
            label: label
        )
        writeBlob(blob)
    }

    public func get(serviceId: String, opaqueTagHex: String) -> InviteLabel? {
        lock.lock(); defer { lock.unlock() }
        let key = makeKey(serviceId: serviceId, opaqueTagHex: opaqueTagHex)
        return readBlob()[key]?.label
    }

    public func list(serviceId: String) -> [InviteLabelRow] {
        lock.lock(); defer { lock.unlock() }
        let blob = readBlob()
        let rows = blob.values.filter { $0.serviceId == serviceId }
        return rows.sorted { $0.label.sentAt > $1.label.sentAt }
    }

    public func remove(serviceId: String, opaqueTagHex: String) {
        lock.lock(); defer { lock.unlock() }
        var blob = readBlob()
        let key = makeKey(serviceId: serviceId, opaqueTagHex: opaqueTagHex)
        blob.removeValue(forKey: key)
        writeBlob(blob)
    }

    private func makeKey(serviceId: String, opaqueTagHex: String) -> String {
        "\(serviceId)|\(opaqueTagHex.lowercased())"
    }

    private func readBlob() -> [String: InviteLabelRow] {
        guard let data = defaults.data(forKey: storageKey),
              let decoded = try? JSONDecoder().decode([String: InviteLabelRow].self, from: data)
        else { return [:] }
        return decoded
    }

    private func writeBlob(_ blob: [String: InviteLabelRow]) {
        guard let data = try? JSONEncoder().encode(blob) else { return }
        defaults.set(data, forKey: storageKey)
    }
}

/// In-memory implementation for previews + tests. Drop-in for the
/// UserDefaults-backed one without touching the global defaults store.
public final class InMemoryInviteLabelBook: InviteLabelBook, @unchecked Sendable {
    private var blob: [String: InviteLabelRow] = [:]
    private let lock = NSLock()

    public init() {}

    public func put(serviceId: String, opaqueTagHex: String, label: InviteLabel) {
        lock.lock(); defer { lock.unlock() }
        blob[key(serviceId, opaqueTagHex)] = InviteLabelRow(
            serviceId: serviceId, opaqueTagHex: opaqueTagHex.lowercased(), label: label
        )
    }

    public func get(serviceId: String, opaqueTagHex: String) -> InviteLabel? {
        lock.lock(); defer { lock.unlock() }
        return blob[key(serviceId, opaqueTagHex)]?.label
    }

    public func list(serviceId: String) -> [InviteLabelRow] {
        lock.lock(); defer { lock.unlock() }
        return blob.values
            .filter { $0.serviceId == serviceId }
            .sorted { $0.label.sentAt > $1.label.sentAt }
    }

    public func remove(serviceId: String, opaqueTagHex: String) {
        lock.lock(); defer { lock.unlock() }
        blob.removeValue(forKey: key(serviceId, opaqueTagHex))
    }

    private func key(_ serviceId: String, _ opaqueTagHex: String) -> String {
        "\(serviceId)|\(opaqueTagHex.lowercased())"
    }
}

// MARK: - Opaque-tag minting + share-url builder

public enum InviteUtil {
    /// Mint a 16-byte opaque tag (lowercase hex, 32 chars). Mirrors
    /// `apps/web/public/webapp/lib/labelBook.js#generateOpaqueTag`.
    public static func generateOpaqueTag() -> String {
        var bytes = [UInt8](repeating: 0, count: 16)
        _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        return bytes.map { String(format: "%02x", $0) }.joined()
    }

    /// Build the share URL the recipient redeems through. Mirrors the
    /// webapp's `buildShareUrl(appUrl, secretHex, serviceId)`.
    public static func buildShareUrl(appUrl: String, secretHex: String, serviceId: String) -> String {
        let base = appUrl.replacingOccurrences(of: "/+$", with: "", options: .regularExpression)
        // serviceId may contain hyphens / non-URL-safe runs; percent-
        // encode it the same way the webapp does.
        let escaped = serviceId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? serviceId
        return "\(base)/invite#k=\(secretHex)&a=\(escaped)"
    }
}
