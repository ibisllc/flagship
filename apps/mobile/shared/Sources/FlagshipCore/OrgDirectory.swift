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

/// A member's slice of the directory (packages/protocol/src/orgDirectory.ts, `flagship/org-directory-slice/v1`).
public struct OrgDirectorySlice: Equatable {
    public var orgId: String, seatId: String, kemKeyId: String, tagKeyVersion: Int64, contentTag: String, sealedHex: String, issuedAt: Int64
    public var json: [String: Any] {
        ["orgId": orgId, "seatId": seatId, "kemKeyId": kemKeyId, "tagKeyVersion": NSNumber(value: tagKeyVersion), "contentTag": contentTag,
         "sealedHex": sealedHex, "issuedAt": NSNumber(value: issuedAt)]
    }
    public static func fromWire(_ w: Any?) throws -> OrgDirectorySlice {
        guard let o = w as? [String: Any], let a = o["orgId"] as? String, let s = o["seatId"] as? String, let k = o["kemKeyId"] as? String,
              let v = OrgAuthority.i64(o["tagKeyVersion"]), let t = o["contentTag"] as? String, let h = o["sealedHex"] as? String,
              let i = OrgAuthority.i64(o["issuedAt"]) else { throw OrgAuthorityError("malformed", "slice") }
        return OrgDirectorySlice(orgId: a, seatId: s, kemKeyId: k, tagKeyVersion: v, contentTag: t, sealedHex: h, issuedAt: i)
    }
}

extension OrgDirectory {
    public static let sliceTag = "flagship/org-directory-slice/v1"

    static func serverTargets(_ roles: [OrgSeatRole], _ all: [String]) -> Set<String> {
        var out = Set<String>()
        for r in roles {
            switch r {
            case .serverAdmin(let s): out.formUnion(s ?? all)
            case .unlock(let s): out.formUnion(s)
            default: break
            }
        }
        return out
    }
    static func appTargets(_ roles: [OrgSeatRole]) -> Set<String> {
        var out = Set<String>()
        for case .serviceAdmin(let apps) in roles { out.formUnion(apps) }
        return out
    }

    /// Every org admin, each live seat whose roles name a server or app this seat's roles name, and those servers.
    public static func shares(_ st: OrgAuthorityState, _ book: OrgSeatBook, seatId: String, servers: [String], now: Int64) -> (seats: [String], servers: [String]) {
        let mine = book.seats[seatId]
        let myServers = mine.map { serverTargets($0.roles, servers) } ?? []
        let myApps = mine.map { appTargets($0.roles) } ?? []
        var seats = Set(st.current.admins.filter { $0.kind == .admin }.map(\.seatId))
        for (id, s) in book.seats where id != seatId && !book.revoked.contains(id) && s.grant.expiresAt > now {
            if !serverTargets(s.roles, servers).isDisjoint(with: myServers) || !appTargets(s.roles).isDisjoint(with: myApps) { seats.insert(id) }
        }
        seats.remove(seatId)
        return (seats.sorted(), myServers.filter { servers.contains($0) }.sorted())
    }

    public static func sliceContent(_ st: OrgAuthorityState, _ book: OrgSeatBook, seatId: String, bySeat: [String: OrgDirectoryEntry], servers: [String], now: Int64)
        -> (entries: [OrgDirectoryEntry], servers: [String]) {
        let sh = shares(st, book, seatId: seatId, servers: servers, now: now)
        let entries = sh.seats.compactMap { bySeat[$0] }.map { e -> OrgDirectoryEntry in var x = e; x.email = ""; x.externalId = ""; x.updatedAt = 0; return x }
        return (entries, sh.servers)
    }

    public static func slicePayload(orgId: String, seatId: String, entries: [OrgDirectoryEntry], servers: [String]) throws -> [UInt8] {
        guard OrgAuthority.isHex(orgId, 32), OrgAuthority.isHex(seatId, 32), entries.count <= 2000, servers.count <= 512 else { throw fail("slice") }
        let bodies = try entries.map { b64u(try canonicalBody($0)) }.sorted()
        for s in servers { if !OrgAuthority.token(s, "^[a-z0-9][a-z0-9.-]{0,252}$") { throw fail("server") } }
        guard servers == Array(Set(servers)).sorted() else { throw fail("servers not sorted and unique") }
        return OrgAuthority.join([sliceTag, "payload", orgId, seatId, bodies.joined(separator: ","), servers.joined(separator: ",")])
    }

    public static func parseSlicePayload(_ b: [UInt8], orgId: String, seatId: String) throws -> (entries: [OrgDirectoryEntry], servers: [String]) {
        guard let s = String(bytes: b, encoding: .utf8) else { throw fail("utf8") }
        let p = s.split(separator: "|", omittingEmptySubsequences: false).map(String.init)
        guard p.count == 6, p[0] == sliceTag, p[1] == "payload", p[2] == orgId, p[3] == seatId else { throw fail("slice payload") }
        let entries = p[4].isEmpty ? [] : try p[4].split(separator: ",").map { try parseBody(try unb64u(String($0))) }
        let servers = p[5].isEmpty ? [] : p[5].split(separator: ",").map(String.init)
        guard try slicePayload(orgId: orgId, seatId: seatId, entries: entries, servers: servers) == b else { throw fail("slice payload not canonical") }
        return (entries, servers)
    }

    public static func sliceContentTag(directoryKey: [UInt8], payload: [UInt8]) -> String {
        let mac = HMAC<SHA256>.authenticationCode(for: Array("\(sliceTag)|tag|".utf8) + payload, using: SymmetricKey(data: directoryKey))
        return PqBin.hex(Array(mac))
    }

    public static func canonicalSliceWrite(_ s: OrgDirectorySlice) throws -> [UInt8] {
        guard OrgAuthority.isHex(s.orgId, 32), OrgAuthority.isHex(s.seatId, 32), OrgAuthority.isHex(s.kemKeyId, 64), OrgAuthority.isHex(s.contentTag, 64),
              s.tagKeyVersion >= 1, s.issuedAt >= 0, let sealed = PqBin.unhex(s.sealedHex), !sealed.isEmpty else { throw fail("slice") }
        return OrgAuthority.join([sliceTag, s.orgId, s.seatId, s.kemKeyId, String(s.tagKeyVersion), s.contentTag, OrgAuthority.sha256Hex(sealed), String(s.issuedAt)])
    }

    public static func sealSlice(orgId: String, seatId: String, kemPub: [UInt8], kemKeyId: String, entries: [OrgDirectoryEntry], servers: [String],
                                 directoryKey: [UInt8], tagKeyVersion: Int64, issuedAt: Int64) throws -> OrgDirectorySlice {
        let payload = try slicePayload(orgId: orgId, seatId: seatId, entries: entries, servers: servers)
        let opts = HybridSealOptions(purpose: sliceTag, senderKeyId: [UInt8](repeating: 0, count: 32), issuedAt: UInt64(issuedAt))
        let sealed = try PqHybrid.hybridSeal(recipientPublicKey: kemPub, options: opts, context: [Array(orgId.utf8), Array(seatId.utf8)], plaintext: payload)
        let s = OrgDirectorySlice(orgId: orgId, seatId: seatId, kemKeyId: kemKeyId, tagKeyVersion: tagKeyVersion,
                                  contentTag: sliceContentTag(directoryKey: directoryKey, payload: payload), sealedHex: PqBin.hex(sealed), issuedAt: issuedAt)
        _ = try canonicalSliceWrite(s)
        return s
    }

    public static func openSlice(_ s: OrgDirectorySlice, kemSecret: [UInt8]) throws -> (entries: [OrgDirectoryEntry], servers: [String]) {
        _ = try canonicalSliceWrite(s)
        guard let sealed = PqBin.unhex(s.sealedHex) else { throw fail("hex") }
        let plain: [UInt8]
        do { plain = try PqHybrid.hybridOpen(recipientSecretKey: kemSecret, expectedPurpose: sliceTag, context: [Array(s.orgId.utf8), Array(s.seatId.utf8)], sealed: sealed).plaintext } catch {
            throw fail("slice does not open")
        }
        return try parseSlicePayload(plain, orgId: s.orgId, seatId: s.seatId)
    }

    /// A member's check that one org admin (still one now) approved its slice.
    public static func verifySliceApproval(_ st: OrgAuthorityState, _ book: OrgSeatBook, _ s: OrgDirectorySlice, approvals: [OrgApproval], now: Int64) throws {
        let at = approvals.first?.oarVersion ?? -1
        try OrgRotation.recordedApprovals(st, book, order: try canonicalSliceWrite(s), approvals: approvals, oarVersion: at, now: now, scoped: nil)
        guard approvals.contains(where: { a in st.current.admins.contains { $0.seatId == a.seatId && $0.kind == .admin } }) else { throw fail("not an org admin now") }
    }
}
