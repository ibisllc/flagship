import Foundation
import CryptoKit

/// The org directory (packages/protocol/src/orgDirectory.ts; docs/org-directory.md §2): each seat's
/// names, sealed under the org directory key (key-ring kind `directory-key`, org admins only). Byte for
/// byte the TypeScript forms, pinned by test-vectors/org-directory. Free text travels as base64url so
/// no field can carry the `|` separator.
public struct OrgDirectoryEntry: Equatable {
    public var seatId: String, pendingId: String, pseudonym: String, displayName: String, email: String, externalId: String
    public var source: String, groups: [String], updatedAt: Int64
    public init(seatId: String, pendingId: String = "", pseudonym: String, displayName: String = "", email: String = "", externalId: String = "",
                source: String = "manual", groups: [String] = [], updatedAt: Int64) {
        self.seatId = seatId; self.pendingId = pendingId; self.pseudonym = pseudonym; self.displayName = displayName; self.email = email
        self.externalId = externalId; self.source = source; self.groups = groups; self.updatedAt = updatedAt
    }
    public static func fromWire(_ w: Any?) throws -> OrgDirectoryEntry {
        guard let o = w as? [String: Any], let s = o["seatId"] as? String, let p = o["pendingId"] as? String, let n = o["pseudonym"] as? String,
              let d = o["displayName"] as? String, let e = o["email"] as? String, let x = o["externalId"] as? String, let src = o["source"] as? String,
              let g = o["groups"] as? [String], let u = OrgAuthority.i64(o["updatedAt"]) else { throw OrgAuthorityError("malformed", "directory entry") }
        return OrgDirectoryEntry(seatId: s, pendingId: p, pseudonym: n, displayName: d, email: e, externalId: x, source: src, groups: g, updatedAt: u)
    }
}

/// A sealed entry as `.com` stores it.
public struct OrgDirectorySealed: Equatable {
    public var orgId: String, entryId: String, keyVersion: Int64, sizeBucket: Int, sealedHex: String, issuedAt: Int64
    public var json: [String: Any] {
        ["orgId": orgId, "entryId": entryId, "keyVersion": NSNumber(value: keyVersion), "sizeBucket": NSNumber(value: sizeBucket),
         "sealedHex": sealedHex, "issuedAt": NSNumber(value: issuedAt)]
    }
    public static func fromWire(_ w: Any?) throws -> OrgDirectorySealed {
        guard let o = w as? [String: Any], let orgId = o["orgId"] as? String, let id = o["entryId"] as? String, let v = OrgAuthority.i64(o["keyVersion"]),
              let b = OrgAuthority.i64(o["sizeBucket"]), let h = o["sealedHex"] as? String, let t = OrgAuthority.i64(o["issuedAt"]) else {
            throw OrgAuthorityError("malformed", "sealed directory entry")
        }
        return OrgDirectorySealed(orgId: orgId, entryId: id, keyVersion: v, sizeBucket: Int(b), sealedHex: h, issuedAt: t)
    }
}

public enum OrgDirectory {
    public static let tag = "flagship/org-directory-entry/v1"
    public static let buckets = [256, 512, 1024, 2048, 4096, 8192]
    public static let maxGroups = 32
    static let limits = (pseudonym: 128, displayName: 256, email: 320, externalId: 256, group: 256)

    static func fail(_ d: String) -> OrgAuthorityError { OrgAuthorityError("malformed", d) }

    static func b64u(_ b: [UInt8]) -> String {
        Data(b).base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }
    static func unb64u(_ s: String) throws -> [UInt8] {
        guard OrgAuthority.token(s, "^[A-Za-z0-9_-]*$"), s.count % 4 != 1 else { throw fail("base64url") }
        var t = s.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while t.count % 4 != 0 { t += "=" }
        guard let d = Data(base64Encoded: t), b64u(Array(d)) == s else { throw fail("base64url not canonical") }
        return Array(d)
    }

    /// No control characters, NFC, at most `max` UTF-8 bytes.
    static func text(_ name: String, _ v: String, _ max: Int, required: Bool = false) throws {
        if required && v.trimmingCharacters(in: .whitespaces).isEmpty { throw fail("\(name) empty") }
        let bad = v.unicodeScalars.contains { $0.value < 0x20 || $0.value == 0x7f || $0.value == 0x2028 || $0.value == 0x2029 }
        let nfc = Array(v.precomposedStringWithCanonicalMapping.unicodeScalars) == Array(v.unicodeScalars)
        if bad || !nfc || v.utf8.count > max { throw fail(name) }
    }

    /// Sorted by UTF-16 code units, as JavaScript sorts.
    public static func sortedGroups(_ g: [String]) -> [String] { g.sorted { $0.utf16.lexicographicallyPrecedes($1.utf16) } }

    public static func check(_ e: OrgDirectoryEntry) throws {
        if !e.seatId.isEmpty && !OrgAuthority.isHex(e.seatId, 32) { throw fail("seatId") }
        if !e.pendingId.isEmpty && !OrgAuthority.isHex(e.pendingId, 32) { throw fail("pendingId") }
        if e.seatId.isEmpty == e.pendingId.isEmpty { throw fail("exactly one of seatId and pendingId") }
        try text("pseudonym", e.pseudonym, limits.pseudonym, required: true)
        try text("displayName", e.displayName, limits.displayName)
        try text("email", e.email, limits.email)
        try text("externalId", e.externalId, limits.externalId)
        if !OrgAuthority.token(e.source, "^[a-z][a-z0-9-]{1,31}$") { throw fail("source") }
        if e.groups.count > maxGroups { throw fail("groups") }
        for g in e.groups { try text("group", g, limits.group, required: true) }
        let sorted = sortedGroups(e.groups)
        for i in sorted.indices {
            if Array(sorted[i].utf16) != Array(e.groups[i].utf16) { throw fail("groups not sorted and unique") }
            if i > 0 && Array(sorted[i].utf16) == Array(sorted[i - 1].utf16) { throw fail("groups not sorted and unique") }
        }
        if e.updatedAt < 0 { throw fail("updatedAt") }
    }

    public static func canonicalBody(_ e: OrgDirectoryEntry) throws -> [UInt8] {
        try check(e)
        let t = { (s: String) in b64u(Array(s.utf8)) }
        return OrgAuthority.join([tag, "body", e.seatId, e.pendingId, t(e.pseudonym), t(e.displayName), t(e.email), t(e.externalId), e.source,
                                  e.groups.map(t).joined(separator: ","), String(e.updatedAt)])
    }

    public static func parseBody(_ bytes: [UInt8]) throws -> OrgDirectoryEntry {
        guard let s = String(bytes: bytes, encoding: .utf8) else { throw fail("utf8") }
        let p = s.split(separator: "|", omittingEmptySubsequences: false).map(String.init)
        guard p.count == 11, p[0] == tag, p[1] == "body", OrgAuthority.token(p[10], "^(0|[1-9][0-9]{0,15})$"), let u = Int64(p[10]) else { throw fail("body") }
        func txt(_ x: String) throws -> String {
            guard let v = String(bytes: try unb64u(x), encoding: .utf8) else { throw fail("utf8") }
            return v
        }
        let groups = p[9].isEmpty ? [] : try p[9].split(separator: ",", omittingEmptySubsequences: false).map { try txt(String($0)) }
        let e = OrgDirectoryEntry(seatId: p[2], pendingId: p[3], pseudonym: try txt(p[4]), displayName: try txt(p[5]), email: try txt(p[6]),
                                  externalId: try txt(p[7]), source: p[8], groups: groups, updatedAt: u)
        guard try canonicalBody(e) == bytes else { throw fail("body not canonical") }
        return e
    }

    static func checkHeader(orgId: String, entryId: String, keyVersion: Int64, sizeBucket: Int) throws {
        if !OrgAuthority.isHex(orgId, 32) { throw fail("orgId") }
        if !OrgAuthority.isHex(entryId, 32) { throw fail("entryId") }
        if keyVersion < 1 { throw fail("keyVersion") }
        if !buckets.contains(sizeBucket) { throw fail("sizeBucket") }
    }

    static func aad(_ s: OrgDirectorySealed) throws -> [UInt8] {
        try checkHeader(orgId: s.orgId, entryId: s.entryId, keyVersion: s.keyVersion, sizeBucket: s.sizeBucket)
        return OrgAuthority.join([tag, "seal", s.orgId, s.entryId, String(s.keyVersion), String(s.sizeBucket)])
    }

    /// What an org admin's approval signs to store an entry on `.com`.
    public static func canonicalWrite(_ s: OrgDirectorySealed) throws -> [UInt8] {
        try checkHeader(orgId: s.orgId, entryId: s.entryId, keyVersion: s.keyVersion, sizeBucket: s.sizeBucket)
        guard s.sealedHex.utf8.count == 2 * (12 + s.sizeBucket + 16), let sealed = PqBin.unhex(s.sealedHex), s.issuedAt >= 0 else { throw fail("sealedHex") }
        return OrgAuthority.join([tag, s.orgId, s.entryId, String(s.keyVersion), String(s.sizeBucket), OrgAuthority.sha256Hex(sealed), String(s.issuedAt)])
    }

    public static func entryKey(directoryKey: [UInt8], orgId: String, entryId: String, keyVersion: Int64) throws -> [UInt8] {
        guard directoryKey.count == 32, OrgAuthority.isHex(orgId, 32), OrgAuthority.isHex(entryId, 32), keyVersion >= 0 else { throw fail("entry key") }
        let k = HKDF<SHA256>.deriveKey(inputKeyMaterial: SymmetricKey(data: directoryKey), salt: Data(),
                                       info: Data(OrgAuthority.join([tag, "key", orgId, entryId, String(keyVersion)])), outputByteCount: 32)
        return k.withUnsafeBytes { Array($0) }
    }

    public static func seal(orgId: String, entryId: String, keyVersion: Int64, directoryKey: [UInt8], entry: OrgDirectoryEntry,
                            issuedAt: Int64, nonce: [UInt8]? = nil) throws -> OrgDirectorySealed {
        let body = try canonicalBody(entry)
        guard let bucket = buckets.first(where: { $0 >= body.count + 2 }) else { throw fail("entry too large") }
        var padded = [UInt8](repeating: 0, count: bucket)
        padded[0] = UInt8(body.count >> 8); padded[1] = UInt8(body.count & 255)
        padded.replaceSubrange(2..<(2 + body.count), with: body)
        let n = nonce ?? PqBin.random(12)
        guard n.count == 12 else { throw fail("nonce") }
        let header = OrgDirectorySealed(orgId: orgId, entryId: entryId, keyVersion: keyVersion, sizeBucket: bucket, sealedHex: "", issuedAt: issuedAt)
        let key = SymmetricKey(data: try entryKey(directoryKey: directoryKey, orgId: orgId, entryId: entryId, keyVersion: keyVersion))
        let box = try AES.GCM.seal(padded, using: key, nonce: try AES.GCM.Nonce(data: n), authenticating: try aad(header))
        var out = header
        out.sealedHex = PqBin.hex(Array(box.combined!))
        _ = try canonicalWrite(out)
        return out
    }

    public static func open(_ s: OrgDirectorySealed, directoryKey: [UInt8]) throws -> OrgDirectoryEntry {
        _ = try canonicalWrite(s)
        guard let sealed = PqBin.unhex(s.sealedHex) else { throw fail("hex") }
        let key = SymmetricKey(data: try entryKey(directoryKey: directoryKey, orgId: s.orgId, entryId: s.entryId, keyVersion: s.keyVersion))
        let padded: [UInt8]
        do {
            padded = Array(try AES.GCM.open(try AES.GCM.SealedBox(combined: Data(sealed)), using: key, authenticating: try aad(s)))
        } catch { throw fail("does not open") }
        let len = Int(padded[0]) << 8 | Int(padded[1])
        guard len + 2 <= padded.count, padded[(2 + len)...].allSatisfy({ $0 == 0 }) else { throw fail("padding") }
        return try parseBody(Array(padded[2..<(2 + len)]))
    }

    /// The newest entry per seat (by `updatedAt`), from every entry this admin's keys open.
    public static func openAll(orgId: String, _ sealed: [OrgDirectorySealed], keys: [Int64: [UInt8]]) -> (bySeat: [String: (entry: OrgDirectoryEntry, entryId: String)],
                                                                                                         byPending: [String: (entry: OrgDirectoryEntry, entryId: String)]) {
        var bySeat: [String: (entry: OrgDirectoryEntry, entryId: String)] = [:], byPending: [String: (entry: OrgDirectoryEntry, entryId: String)] = [:]
        for s in sealed where s.orgId == orgId {
            guard let k = keys[s.keyVersion], let e = try? open(s, directoryKey: k) else { continue }
            if !e.seatId.isEmpty {
                if (bySeat[e.seatId]?.entry.updatedAt ?? -1) < e.updatedAt { bySeat[e.seatId] = (e, s.entryId) }
            } else if (byPending[e.pendingId]?.entry.updatedAt ?? -1) < e.updatedAt { byPending[e.pendingId] = (e, s.entryId) }
        }
        return (bySeat, byPending)
    }
}

extension OrgDirectory {
    /// Every directory-key version in a verified plan that `seat:<seatId>` can open, by version.
    public static func keys(_ plan: OrgRotationPlan, seatId: String, kemSecret: [UInt8]) -> [Int64: [UInt8]] {
        var out: [Int64: [UInt8]] = [:]
        for b in plan.chains[OrgRotation.chainId(.directoryKey, "*")] ?? [] {
            if let k = try? OrgAuthority.openKeyRing(b.ring, recipients: b.recipients, recipient: "seat:\(seatId)", kemSecret: kemSecret) { out[b.ring.version] = k }
        }
        return out
    }

    /// The newest verified directory-key version, or nil before the first one exists.
    public static func newestVersion(_ plan: OrgRotationPlan) -> Int64? { plan.chains[OrgRotation.chainId(.directoryKey, "*")]?.last?.ring.version }
}
