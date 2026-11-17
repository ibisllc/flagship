import CryptoKit
import Foundation

/// The org's voucher wallet (docs/plans-and-backup-offer.md §6). Swift twin of packages/protocol/src/orgWallet.ts,
/// pinned by test-vectors/org-plan/ (`wallet`, `merge`). An org has no UMK, so the wallet is sealed under the org key
/// ring's `wallet` key, which only org admins receive and every admin's departure rotates.
///
///   key      HKDF-SHA256(ikm ring key, salt empty, info "flagship/org-voucher-wallet/v1|<orgId>", 32)
///   sealed   {version, keyVersion, nonce (hex 12), ct (base64)}: AES-256-GCM(key, nonce,
///            aad "flagship/org-voucher-wallet/v1|<orgId>|<keyVersion>|<version>", canonical JSON plaintext)
///   plain    {v:1, vouchers, spent, settings {seats, autoPay, overageCapUnits, updatedAt}, overage, pad}
///   write    flagship/org-voucher-wallet-write/v1|<orgId>|<version>|<keyVersion>|<blobSha256>|<issuedAt>,
///            approved by one org admin (`flagship/org-approval/v1`)
public struct OrgWalletSettings: Equatable, Sendable {
    public var seats: Int64
    public var autoPay: Bool
    public var overageCapUnits: Int64
    public var updatedAt: Int64
    public init(seats: Int64, autoPay: Bool, overageCapUnits: Int64, updatedAt: Int64) {
        self.seats = seats; self.autoPay = autoPay; self.overageCapUnits = overageCapUnits; self.updatedAt = updatedAt
    }
    var json: JSONValue { ["seats": .int(seats), "autoPay": .bool(autoPay), "overageCapUnits": .int(overageCapUnits), "updatedAt": .int(updatedAt)] }
}

public struct OrgVoucherWallet: Equatable, Sendable {
    public var vouchers: [Voucher]
    public var spent: [String]
    public var settings: OrgWalletSettings
    public var overage: VoucherWallet.OverageMonth
    public init(vouchers: [Voucher], spent: [String], settings: OrgWalletSettings, overage: VoucherWallet.OverageMonth) {
        self.vouchers = vouchers; self.spent = spent; self.settings = settings; self.overage = overage
    }

    public static func empty(seats: Int64, overageCapUnits: Int64) -> OrgVoucherWallet {
        OrgVoucherWallet(vouchers: [], spent: [], settings: .init(seats: seats, autoPay: true, overageCapUnits: overageCapUnits, updatedAt: 0),
                         overage: .init(period: "", units: 0))
    }

    public var balance: Int { vouchers.count }

    func json(pad: String) -> JSONValue {
        ["v": 1, "vouchers": .array(vouchers.map(\.json)), "spent": .array(spent.map { .string($0) }), "settings": settings.json,
         "overage": ["period": .string(overage.period), "units": .int(overage.units)], "pad": .string(pad)]
    }
}

/// A sealed org wallet as `.com` stores it.
public struct SealedOrgVoucherWallet: Equatable, Sendable {
    public var version: Int64
    public var keyVersion: Int64
    public var nonce: String
    public var ct: String
    public init(version: Int64, keyVersion: Int64, nonce: String, ct: String) {
        self.version = version; self.keyVersion = keyVersion; self.nonce = nonce; self.ct = ct
    }
    public var json: JSONValue { ["version": .int(version), "keyVersion": .int(keyVersion), "nonce": .string(nonce), "ct": .string(ct)] }
}

/// The order an org admin approves to store a sealed wallet.
public struct OrgWalletWrite: Equatable, Sendable {
    public var orgId: String
    public var version: Int64
    public var keyVersion: Int64
    public var blobSha256: String
    public var issuedAt: Int64
    public init(orgId: String, version: Int64, keyVersion: Int64, blobSha256: String, issuedAt: Int64) {
        self.orgId = orgId; self.version = version; self.keyVersion = keyVersion; self.blobSha256 = blobSha256; self.issuedAt = issuedAt
    }
    public var json: JSONValue {
        ["orgId": .string(orgId), "version": .int(version), "keyVersion": .int(keyVersion), "blobSha256": .string(blobSha256), "issuedAt": .int(issuedAt)]
    }
}

public enum OrgWalletSync {
    public static let tag = "flagship/org-voucher-wallet/v1"
    public static let writeTag = "flagship/org-voucher-wallet-write/v1"
    /// A company batch fits in one wallet.
    public static let maxVouchers = 5000
    public static let maxBytes = 4 * 1024 * 1024

    public struct WalletError: Error, Equatable { public let reason: String }

    static func isOrgId(_ s: String) -> Bool { s.utf8.count == 32 && CanonicalJson.isLowerHex(s) }

    public static func normalize(_ w: OrgVoucherWallet) -> OrgVoucherWallet {
        let spent = Array(Set(w.spent).sorted(by: CanonicalJson.utf16Less).suffix(VoucherWalletSync.maxSpent))
        let spentSet = Set(spent)
        var seen = Set<String>()
        var vouchers: [Voucher] = []
        for x in w.vouchers.sorted(by: VoucherWalletSync.less) {
            let id = "\(x.k)|\(x.n)"
            if seen.contains(id) || spentSet.contains(Vouchers.nullifier(x)) { continue }
            seen.insert(id)
            vouchers.append(x)
        }
        var out = w
        out.vouchers = Array(vouchers.prefix(maxVouchers))
        out.spent = spent
        return out
    }

    static func parseSettings(_ v: JSONValue?) -> OrgWalletSettings? {
        guard let o = v?.object, Set(o.keys) == ["seats", "autoPay", "overageCapUnits", "updatedAt"],
              let seats = o["seats"]?.time, seats >= 1, seats <= 1_000_000, case .bool(let autoPay)? = o["autoPay"],
              let cap = o["overageCapUnits"]?.time, cap <= 1_000_000, let at = o["updatedAt"]?.time else { return nil }
        return OrgWalletSettings(seats: seats, autoPay: autoPay, overageCapUnits: cap, updatedAt: at)
    }

    /// Strict shape of an org wallet plaintext (`pad` allowed and dropped).
    public static func parse(_ v: JSONValue?) -> OrgVoucherWallet? {
        guard let o = v?.object else { return nil }
        guard Set(o.keys).subtracting(["pad"]) == ["v", "vouchers", "spent", "settings", "overage"], o["v"]?.isOne == true else { return nil }
        if let pad = o["pad"] { guard let s = pad.string, s.utf8.allSatisfy({ $0 == 0x30 }) else { return nil } }
        guard let vs = o["vouchers"]?.array, vs.count <= maxVouchers, let sp = o["spent"]?.array, sp.count <= VoucherWalletSync.maxSpent else { return nil }
        var spent: [String] = []
        for s in sp { guard let h = s.string, CanonicalJson.isLowerHex(h, bytes: 32) else { return nil }; spent.append(h) }
        var vouchers: [Voucher] = []
        for x in vs { guard let p = Vouchers.parse(x) else { return nil }; vouchers.append(p) }
        guard let settings = parseSettings(o["settings"]), let ov = o["overage"]?.object, Set(ov.keys) == ["period", "units"],
              let period = ov["period"]?.string, VoucherWalletSync.isPeriod(period), let units = ov["units"]?.time else { return nil }
        return normalize(OrgVoucherWallet(vouchers: vouchers, spent: spent, settings: settings, overage: .init(period: period, units: units)))
    }

    /// A version conflict: both sides' vouchers and spends, the newer settings, the later overage month.
    public static func merge(local: OrgVoucherWallet, remote: OrgVoucherWallet) -> OrgVoucherWallet {
        let settings = remote.settings.updatedAt > local.settings.updatedAt ? remote.settings : local.settings
        let overage: VoucherWallet.OverageMonth
        if local.overage.period == remote.overage.period {
            overage = .init(period: local.overage.period, units: max(local.overage.units, remote.overage.units))
        } else {
            overage = CanonicalJson.utf16Less(remote.overage.period, local.overage.period) ? local.overage : remote.overage
        }
        return normalize(OrgVoucherWallet(vouchers: local.vouchers + remote.vouchers, spent: local.spent + remote.spent, settings: settings, overage: overage))
    }

    public static func add(_ w: OrgVoucherWallet, _ vouchers: [Voucher]) -> OrgVoucherWallet {
        var x = w
        x.vouchers += vouchers
        return normalize(x)
    }

    public static func markSpent(_ w: OrgVoucherWallet, _ nullifiers: [String]) -> OrgVoucherWallet {
        var x = w
        x.spent += nullifiers
        return normalize(x)
    }

    public static func take(_ w: OrgVoucherWallet, _ n: Int) -> [Voucher] { Array(normalize(w).vouchers.prefix(max(0, n))) }

    /// The canonical plaintext, padded to its bucket (4 KiB × 2^i).
    public static func plaintext(_ w: OrgVoucherWallet) throws -> String {
        let n = normalize(w)
        let bare = try CanonicalJson.canonicalJson(n.json(pad: ""))
        let len = bare.utf8.count
        var b = VoucherWalletSync.bucket
        while b < len { b *= 2 }
        guard b <= maxBytes else { throw WalletError(reason: "\(tag): too large") }
        return try CanonicalJson.canonicalJson(n.json(pad: String(repeating: "0", count: b - len)))
    }

    /// The wallet key from the org key ring's `wallet` key.
    public static func deriveKey(ringKey: [UInt8], orgId: String) throws -> [UInt8] {
        guard ringKey.count == 32, isOrgId(orgId) else { throw WalletError(reason: "\(tag): bad input") }
        return VoiciMessages.kdf(ringKey, "\(tag)|\(orgId)")
    }

    static func aad(_ orgId: String, _ keyVersion: Int64, _ version: Int64) -> Data { Data("\(tag)|\(orgId)|\(keyVersion)|\(version)".utf8) }

    public static func seal(key: [UInt8], orgId: String, keyVersion: Int64, version: Int64, wallet: OrgVoucherWallet,
                            nonce: [UInt8]? = nil) throws -> SealedOrgVoucherWallet {
        let n = nonce ?? Vouchers.random(12)
        guard version >= 1, keyVersion >= 1, n.count == 12, isOrgId(orgId) else { throw WalletError(reason: "\(tag): bad input") }
        let box = try AES.GCM.seal(Data(try plaintext(wallet).utf8), using: SymmetricKey(data: key), nonce: try AES.GCM.Nonce(data: n),
                                   authenticating: aad(orgId, keyVersion, version))
        return SealedOrgVoucherWallet(version: version, keyVersion: keyVersion, nonce: CanonicalJson.hex(n), ct: CanonicalJson.b64Encode(Array(box.ciphertext + box.tag)))
    }

    /// Strict shape of a sealed blob (no decryption).
    public static func parseSealed(_ blob: JSONValue?) -> SealedOrgVoucherWallet? {
        guard let o = blob?.object, Set(o.keys) == ["version", "keyVersion", "nonce", "ct"],
              let version = o["version"]?.time, version >= 1, let kv = o["keyVersion"]?.time, kv >= 1,
              let nonce = o["nonce"]?.string, CanonicalJson.isLowerHex(nonce, bytes: 12), let ct = o["ct"]?.string,
              !ct.isEmpty, ct.utf8.count % 4 == 0, ct.utf8.count <= ((maxBytes + 16) * 4) / 3 + 4,
              ct.utf8.allSatisfy({ ($0 >= 0x41 && $0 <= 0x5a) || ($0 >= 0x61 && $0 <= 0x7a) || ($0 >= 0x30 && $0 <= 0x39) || $0 == 0x2b || $0 == 0x2f || $0 == 0x3d })
        else { return nil }
        return SealedOrgVoucherWallet(version: version, keyVersion: kv, nonce: nonce, ct: ct)
    }

    public static func open(key: [UInt8], orgId: String, blob: JSONValue?) -> OrgVoucherWallet? {
        guard let s = parseSealed(blob) else { return nil }
        return open(key: key, orgId: orgId, sealed: s)
    }

    public static func open(key: [UInt8], orgId: String, sealed s: SealedOrgVoucherWallet) -> OrgVoucherWallet? {
        guard let ct = CanonicalJson.b64Decode(JSONValue.string(s.ct)), ct.count >= 16, let nonce = try? CanonicalJson.hexToBytes(s.nonce),
              let box = try? AES.GCM.SealedBox(nonce: AES.GCM.Nonce(data: nonce), ciphertext: ct.dropLast(16), tag: ct.suffix(16)),
              let pt = try? AES.GCM.open(box, using: SymmetricKey(data: key), authenticating: aad(orgId, s.keyVersion, s.version)),
              let text = String(data: pt, encoding: .utf8), let v = JSONValue.parse(text), CanonicalJson.isCanonical(v, text) else { return nil }
        return parse(v)
    }

    /// SHA-256 hex of the canonical JSON of the sealed blob.
    public static func blobSha256(_ b: SealedOrgVoucherWallet) -> String {
        CanonicalJson.sha256Hex((try? CanonicalJson.canonicalJson(b.json)) ?? "")
    }

    /// The order an org admin approves to store `blob` (wrapped in a `flagship/org-approval/v1`).
    public static func canonicalWrite(_ w: OrgWalletWrite) throws -> [UInt8] {
        guard isOrgId(w.orgId), w.version >= 1, w.keyVersion >= 1, CanonicalJson.isLowerHex(w.blobSha256, bytes: 32), w.issuedAt >= 0 else {
            throw WalletError(reason: "\(writeTag): bad input")
        }
        return Array([writeTag, w.orgId, String(w.version), String(w.keyVersion), w.blobSha256, String(w.issuedAt)].joined(separator: "|").utf8)
    }

    public static func writeFor(orgId: String, blob: SealedOrgVoucherWallet, issuedAt: Int64) -> OrgWalletWrite {
        OrgWalletWrite(orgId: orgId, version: blob.version, keyVersion: blob.keyVersion, blobSha256: blobSha256(blob), issuedAt: issuedAt)
    }
}
