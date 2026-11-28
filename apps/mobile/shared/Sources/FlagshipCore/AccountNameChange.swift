import Foundation
import FlagshipAPI

// "Choose your own account name" at sign-up: the paid rename (`POST /api/account/name-change`), and what `.com`'s
// rename leaves to the device (docs/naming-recovery-and-name-change.md §5). The founding device's grant and profiles
// are signed over the old name, so the device mints them again under the new one; its account device key stays the
// one `.com` registered (derived from the old name) and is stored under the new name.

public struct NameChangeQuote: Equatable, Sendable {
    public var available: Bool
    public var kind: String?
    /// Blind $1 vouchers the rename costs (10 for a name change).
    public var units: Int
    public var code: String?
    public var heldUntil: Int64?
    public var problem: String?
    /// A free name grant pays for it: nothing to pay.
    public var paid: Bool
    /// `dibs-held`: the `.com` that holds the name (maybe the de-hyphenated label); nil from an older `.com`.
    public var domain: String?
    /// `dibs-held`: false when `.com`'s lookup of that domain failed (the name is held until it answers).
    public var checked: Bool

    public init(available: Bool, kind: String? = nil, units: Int = 10, code: String? = nil, heldUntil: Int64? = nil, problem: String? = nil,
                paid: Bool = false, domain: String? = nil, checked: Bool = true) {
        self.available = available; self.kind = kind; self.units = units; self.code = code; self.heldUntil = heldUntil; self.problem = problem
        self.paid = paid; self.domain = domain; self.checked = checked
    }

    static func from(_ v: JSONValue?) -> NameChangeQuote {
        NameChangeQuote(available: v?["available"] == .bool(true), kind: v?["kind"]?.string,
                        units: Int(v?["units"]?.safeInt ?? v?["priceUsd"]?.safeInt ?? 10), code: v?["code"]?.string,
                        heldUntil: v?["heldUntil"]?.safeInt, problem: v?["problem"]?.string, paid: v?["paid"] == .bool(true),
                        domain: v?["domain"]?.string, checked: v?["checked"] != .bool(false))
    }
}

/// A name the owner set aside for a friend (`name-grant.mjs`), opened from
/// `https://<apex>/app/choose-name#n=<name>&g=<code>&e=<expiresAt ms>[&f=1]` (`f=1`: the grant also pays).
public struct NameGrant: Hashable, Sendable {
    public var name: String
    public var code: String
    public var expiresAt: Int64
    public var free: Bool

    public init(name: String, code: String, expiresAt: Int64, free: Bool) {
        self.name = name.lowercased(); self.code = code; self.expiresAt = expiresAt; self.free = free
    }

    /// From the link's fragment parameters; nil when one is missing.
    public static func from(_ f: [String: String]) -> NameGrant? {
        guard let n = f["n"]?.trimmingCharacters(in: .whitespaces), !n.isEmpty,
              let g = f["g"]?.trimmingCharacters(in: .whitespaces), !g.isEmpty,
              let e = f["e"].flatMap({ Int64($0) }) else { return nil }
        return NameGrant(name: n, code: g, expiresAt: e, free: f["f"] == "1")
    }

    var json: JSONValue { ["code": .string(code), "expiresAt": .int(expiresAt)] }
}

/// A refusal from `.com` with its machine `code` (nameChange.ts), or `network`.
public struct NameChangeRefusal: Error, Equatable, Sendable {
    public var status: Int
    public var code: String
    public var heldUntil: Int64?
    public var problem: String?
    /// `voucher-spent`: the nullifiers already spent (drop them from the wallet).
    public var spent: [String]
    /// `dibs-held`: the `.com` that holds the name, and whether its lookup answered (see `NameChangeQuote`).
    public var domain: String?
    public var checked: Bool

    public init(status: Int, code: String, heldUntil: Int64? = nil, problem: String? = nil, spent: [String] = [],
                domain: String? = nil, checked: Bool = true) {
        self.status = status; self.code = code; self.heldUntil = heldUntil; self.problem = problem; self.spent = spent
        self.domain = domain; self.checked = checked
    }

    static func from(status: Int, data: Data) -> NameChangeRefusal {
        let v = JSONValue.parse(utf8: Array(data))
        return NameChangeRefusal(status: status, code: v?["code"]?.string ?? "http-\(status)", heldUntil: v?["heldUntil"]?.safeInt,
                                 problem: v?["problem"]?.string, spent: (v?["spent"]?.array ?? []).compactMap(\.string),
                                 domain: v?["domain"]?.string, checked: v?["checked"] != .bool(false))
    }
}

/// How a rename is paid: a single-use code, or blind $1 vouchers.
public enum NameChangePayment: Equatable, Sendable {
    case code(String)
    case vouchers([Voucher])
    /// A free name grant pays: send nothing else.
    case grant
}

public struct NameChangeOutcome: Equatable, Sendable {
    public var newUsername: String
    public var oldNameReleased: Bool
    public init(newUsername: String, oldNameReleased: Bool) { self.newUsername = newUsername; self.oldNameReleased = oldNameReleased }
}

/// `flagship/revoke-device-capability-grant/v1|grantId|username|reason|issuedAt` (packages/protocol deviceCapability.ts).
public enum RevokeDeviceCapabilityGrantEnvelope {
    public static let canonicalTag = "flagship/revoke-device-capability-grant/v1"
    public static func canonicalBytes(grantId: String, username: String, reason: String, issuedAt: Int64) -> Data {
        Data([canonicalTag, grantId, username, reason, String(issuedAt)].joined(separator: "|").utf8)
    }
}

public protocol AccountNameChangeClient: Sendable {
    /// `POST /api/account/name-change/quote` (public).
    func quote(username: String, newUsername: String, grant: NameGrant?) async throws -> NameChangeQuote
    /// The same quote without a username: the choose-name screen's check while typing, before any account exists.
    /// Nil when `.com` couldn't answer it (an older `.com` refuses the shape, or no network): Pay checks then.
    func precheck(newUsername: String, grant: NameGrant?) async -> NameChangeQuote?
    /// `POST /api/account/name-change`; throws `NameChangeRefusal`.
    func rename(aidPubHex: String, oldUsername: String, newUsername: String, issuedAt: Int64, signatureHex: String,
                payment: NameChangePayment, grant: NameGrant?) async throws -> NameChangeOutcome
    /// `POST /api/users/<u>/device-grants`, signed by the admin root.
    func mintDeviceGrant(_ grant: DeviceCapabilityGrantEnvelope, signatureHex: String) async throws
    /// `POST /api/users/<u>/device-grants/revoke`, signed by the account IRK.
    func revokeDeviceGrant(username: String, grantId: String, reason: String, issuedAt: Int64, signatureHex: String) async throws
    /// The IRK `.com` holds for `username` (`GET /api/username/<u>`), lowercase hex; nil when no account has that name.
    func accountIrk(username: String) async throws -> String?
}

public extension AccountNameChangeClient {
    func precheck(newUsername: String, grant: NameGrant?) async -> NameChangeQuote? { nil }
}

public final class LiveAccountNameChangeClient: AccountNameChangeClient, @unchecked Sendable {
    private let session: URLSession
    private let base: URL

    public init(session: URLSession = .shared, base: URL = Endpoints.controlBaseUrl) {
        self.session = session
        self.base = base
    }

    private static func seg(_ s: String) -> String {
        s.lowercased().addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(CharacterSet(charactersIn: "-"))) ?? s
    }

    private func send(_ method: String, _ path: String, _ body: JSONValue?) async throws -> (Int, Data) {
        var r = URLRequest(url: URL(string: base.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/")) + path)!, timeoutInterval: 20)
        r.httpMethod = method
        r.cachePolicy = .reloadIgnoringLocalCacheData
        if let body {
            r.setValue("application/json", forHTTPHeaderField: "content-type")
            r.httpBody = Data(try CanonicalJson.canonicalJson(body).utf8)
        }
        let (data, res) = try await session.gatedData(for: r)
        return ((res as? HTTPURLResponse)?.statusCode ?? 0, data)
    }

    private func call(_ method: String, _ path: String, _ body: JSONValue?) async throws -> JSONValue? {
        let (status, data) = try await send(method, path, body)
        guard (200..<300).contains(status) else { throw NameChangeRefusal.from(status: status, data: data) }
        return JSONValue.parse(utf8: Array(data))
    }

    public func quote(username: String, newUsername: String, grant: NameGrant?) async throws -> NameChangeQuote {
        var body: [String: JSONValue] = ["username": .string(username), "newUsername": .string(newUsername)]
        if let grant { body["nameGrant"] = grant.json }
        return NameChangeQuote.from(try await call("POST", "/api/account/name-change/quote", .object(body)))
    }

    public func precheck(newUsername: String, grant: NameGrant?) async -> NameChangeQuote? {
        var body: [String: JSONValue] = ["newUsername": .string(newUsername)]
        if let grant, grant.name == newUsername.lowercased() { body["nameGrant"] = grant.json }
        guard let (status, data) = try? await send("POST", "/api/account/name-change/quote", .object(body)),
              (200..<300).contains(status), let v = JSONValue.parse(utf8: Array(data)), v["available"] == .bool(true) || v["available"] == .bool(false) else { return nil }
        return NameChangeQuote.from(v)
    }

    public func rename(aidPubHex: String, oldUsername: String, newUsername: String, issuedAt: Int64, signatureHex: String,
                       payment: NameChangePayment, grant: NameGrant?) async throws -> NameChangeOutcome {
        var body: [String: JSONValue] = [
            "request": ["aidPubHex": .string(aidPubHex.lowercased()), "oldUsername": .string(oldUsername),
                        "newUsername": .string(newUsername), "issuedAt": .int(issuedAt)],
            "signature": .string(signatureHex),
        ]
        switch payment {
        case .code(let c): body["voucherCode"] = .string(c)
        case .vouchers(let vs): body["vouchers"] = .array(vs.map(\.json))
        case .grant: break
        }
        if let grant { body["nameGrant"] = grant.json }
        let v = try await call("POST", "/api/account/name-change", .object(body))
        return NameChangeOutcome(newUsername: v?["newUsername"]?.string ?? newUsername.lowercased(),
                                 oldNameReleased: v?["oldNameReleased"] == .bool(true))
    }

    public func mintDeviceGrant(_ g: DeviceCapabilityGrantEnvelope, signatureHex: String) async throws {
        let grant: JSONValue = [
            "grantId": .string(g.grantId), "username": .string(g.username), "deviceId": .string(g.deviceId),
            "devicePubKey": .string(g.devicePubKeyHex), "scopes": .array(g.scopes.map { .string($0) }),
            "issuedAt": .int(g.issuedAt), "expiresAt": .int(g.expiresAt),
        ]
        do {
            _ = try await call("POST", "/api/users/\(Self.seg(g.username))/device-grants", ["grant": grant, "signature": .string(signatureHex)])
        } catch let r as NameChangeRefusal where r.status == 409 {
            // The same grant id is already stored: a retry after the first mint landed.
        }
    }

    public func revokeDeviceGrant(username: String, grantId: String, reason: String, issuedAt: Int64, signatureHex: String) async throws {
        let request: JSONValue = ["grantId": .string(grantId), "username": .string(username), "reason": .string(reason), "issuedAt": .int(issuedAt)]
        _ = try await call("POST", "/api/users/\(Self.seg(username))/device-grants/revoke", ["request": request, "signature": .string(signatureHex)])
    }

    public func accountIrk(username: String) async throws -> String? {
        let (status, data) = try await send("GET", "/api/username/\(Self.seg(username))", nil)
        if status == 404 { return nil }
        guard status == 200 else { throw NameChangeRefusal.from(status: status, data: data) }
        return JSONValue.parse(utf8: Array(data))?["irkPub"]?.string?.lowercased()
    }
}

// MARK: - The pending record (crash safety)

/// Written before the rename is sent and kept until the device has caught up with it, so a restart in between finishes
/// the work (or learns the rename never happened) instead of showing "This account was removed".
public struct PendingAccountRename: Codable, Equatable, Sendable {
    public enum Stage: String, Codable, Sendable {
        /// The rename request is (about to be) sent; whether `.com` applied it is unknown.
        case renaming
        /// `.com` renamed the account; the device's own copy follows.
        case renamed
        /// This device's keys and records are under the new name.
        case movedLocally
        /// The new grant is minted and the old one revoked.
        case grantSwapped
        /// The profiles are signed again under the new name.
        case profilesDone
    }

    public var oldName: String
    public var newName: String
    public var deviceId: String
    public var oldGrantId: String
    /// Minted once and reused on a retry.
    public var newGrantId: String
    public var irkPubHex: String
    public var stage: Stage
    /// Vouchers the rename spent, to mark spent in the wallet once it is the new name's.
    public var spentNullifiers: [String]
    public var accountDisplayName: String
    public var deviceDisplayName: String

    public init(oldName: String, newName: String, deviceId: String, oldGrantId: String, newGrantId: String = UUID().uuidString.lowercased(),
                irkPubHex: String, stage: Stage = .renaming, spentNullifiers: [String] = [], accountDisplayName: String, deviceDisplayName: String) {
        self.oldName = oldName.lowercased(); self.newName = newName.lowercased(); self.deviceId = deviceId; self.oldGrantId = oldGrantId
        self.newGrantId = newGrantId; self.irkPubHex = irkPubHex.lowercased(); self.stage = stage; self.spentNullifiers = spentNullifiers
        self.accountDisplayName = accountDisplayName; self.deviceDisplayName = deviceDisplayName
    }

    /// True when this record is about `name` (either side of the rename).
    public func names(_ name: String) -> Bool {
        let n = name.lowercased()
        return n == oldName || n == newName
    }
}

public protocol PendingAccountRenameStore: AnyObject, Sendable {
    func load() -> PendingAccountRename?
    func save(_ record: PendingAccountRename)
    func clear()
}

public final class DefaultsPendingAccountRenameStore: PendingAccountRenameStore, @unchecked Sendable {
    public static let shared = DefaultsPendingAccountRenameStore()
    private let defaults: UserDefaults
    private let key: String

    public init(defaults: UserDefaults = .standard, key: String = "flagship.pendingAccountRename.v1") {
        self.defaults = defaults
        self.key = key
    }

    public func load() -> PendingAccountRename? {
        defaults.data(forKey: key).flatMap { try? JSONDecoder().decode(PendingAccountRename.self, from: $0) }
    }

    public func save(_ record: PendingAccountRename) {
        if let data = try? JSONEncoder().encode(record) { defaults.set(data, forKey: key) }
    }

    public func clear() { defaults.removeObject(forKey: key) }
}
