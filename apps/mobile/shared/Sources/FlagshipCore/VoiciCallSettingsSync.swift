import CryptoKit
import Foundation

/// The owner's call hours, synced between the owner's own devices and never published (owner decision 2026-11-16,
/// option c: hours in the page index would show the owner's time zone to anyone). Swift twin of
/// packages/protocol/src/voiciCallSettings.ts (vectors: section `callSettings` of test-vectors/voici-call-modes/).
///
///   key     HKDF-SHA256(ikm UMK seed, salt empty, info "flagship/voici-call-settings/v1", 32)
///   sealed  {version, nonce (hex 12), ct (base64)}: AES-256-GCM(key, nonce, aad "flagship/voici-call-settings/v1|<username>|
///           <version>", canonical JSON plaintext); version = stored + 1 (compare-and-set at `.com`)
///   plain   {v:1, hours, updatedAt}; hours null (any time) or {days, from, to, zone}; a conflict merges by updatedAt.
/// The ringing phone enforces them: outside them it doesn't ring, and the call ends as a missed call.
public struct VoiciCallHours: Equatable, Sendable, Codable {
    /// Seven "0"/"1" from Monday, not all "0".
    public var days: String
    /// "HHMM", 0000-2359, different; an end before the start runs past midnight (the days name the start's day).
    public var from: String
    public var to: String
    /// IANA ("Europe/Paris") or "UTC".
    public var zone: String
    public init(days: String, from: String, to: String, zone: String) { self.days = days; self.from = from; self.to = to; self.zone = zone }
    public var json: JSONValue { ["days": .string(days), "from": .string(from), "to": .string(to), "zone": .string(zone)] }
}

public struct VoiciCallSettingsValue: Equatable, Sendable, Codable {
    public var hours: VoiciCallHours?
    public var updatedAt: Int64
    public init(hours: VoiciCallHours?, updatedAt: Int64) { self.hours = hours; self.updatedAt = updatedAt }
    public var json: JSONValue { ["v": 1, "hours": hours?.json ?? .null, "updatedAt": .number(Double(updatedAt))] }
}

public enum VoiciCallSettingsSync {
    public static let tag = "flagship/voici-call-settings/v1"
    public static let maxBytes = 4 * 1024

    static func minutes(_ hhmm: String) -> Int? {
        let b = Array(hhmm.utf8)
        guard b.count == 4, b.allSatisfy({ (0x30...0x39).contains($0) }), let n = Int(hhmm) else { return nil }
        let h = n / 100, m = n % 100
        return h <= 23 && m <= 59 ? h * 60 + m : nil
    }

    static func zoneOk(_ z: String) -> Bool {
        if z == "UTC" { return true }
        let parts = z.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
        guard (2...3).contains(parts.count), (1...32).contains(parts[0].utf8.count),
              parts[0].unicodeScalars.allSatisfy({ $0.isASCII && CharacterSet.letters.contains($0) }),
              parts.dropFirst().allSatisfy({ (1...32).contains($0.utf8.count)
                  && $0.unicodeScalars.allSatisfy { $0.isASCII && (CharacterSet.alphanumerics.contains($0) || "_+-".unicodeScalars.contains($0)) } })
        else { return false }
        return TimeZone(identifier: z) != nil
    }

    /// Strict shape of the hours (and a time zone this device knows).
    public static func parseHours(_ v: JSONValue?) -> VoiciCallHours? {
        guard let o = v?.object, Set(o.keys) == ["days", "from", "to", "zone"], let d = o["days"]?.string, let f = o["from"]?.string,
              let t = o["to"]?.string, let z = o["zone"]?.string, d.utf8.count == 7, d.utf8.allSatisfy({ $0 == 0x30 || $0 == 0x31 }), d != "0000000",
              let a = minutes(f), let b = minutes(t), a != b, zoneOk(z) else { return nil }
        return VoiciCallHours(days: d, from: f, to: t, zone: z)
    }

    public static func parse(_ v: JSONValue?) -> VoiciCallSettingsValue? {
        guard let o = v?.object, Set(o.keys) == ["v", "hours", "updatedAt"], o["v"]?.isOne == true, let at = o["updatedAt"]?.time,
              let h = o["hours"] else { return nil }
        if h.isNull { return VoiciCallSettingsValue(hours: nil, updatedAt: at) }
        guard let hours = parseHours(h) else { return nil }
        return VoiciCallSettingsValue(hours: hours, updatedAt: at)
    }

    /// Whether a call may ring at `now` (ms; no hours: always). Run on the ringing device only.
    public static func allows(_ hours: VoiciCallHours?, now: Int64) -> Bool {
        guard let hours else { return true }
        guard let h = parseHours(hours.json), let start = minutes(h.from), let end = minutes(h.to), let tz = TimeZone(identifier: h.zone) else { return true }
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = tz
        let c = cal.dateComponents([.weekday, .hour, .minute], from: Date(timeIntervalSince1970: TimeInterval(now) / 1000))
        guard let wd = c.weekday, let hr = c.hour, let mi = c.minute else { return true }
        let day = (wd + 5) % 7 // Monday 0 … Sunday 6
        let min = hr * 60 + mi
        let days = Array(h.days.utf8)
        let on = { (d: Int) in days[(d + 7) % 7] == 0x31 }
        if start < end { return on(day) && min >= start && min < end }
        return (on(day) && min >= start) || (on(day - 1) && min < end)
    }

    public static func deriveKey(umk: [UInt8]) -> [UInt8] { VoiciMessages.kdf(umk, tag) }

    static func aad(_ username: String, _ version: Int64) -> Data { Data("\(tag)|\(username)|\(version)".utf8) }

    public static func seal(key: [UInt8], username: String, version: Int64, settings s: VoiciCallSettingsValue, nonce: [UInt8]? = nil) throws -> JSONValue {
        let n = nonce ?? (0..<12).map { _ in UInt8.random(in: 0...255) }
        guard VoiciCalls.isUsername(username), version >= 1, n.count == 12, parse(s.json) != nil else { throw CanonicalJsonError("\(tag): bad input") }
        let box = try AES.GCM.seal(Data(try CanonicalJson.canonicalJsonBytes(s.json)), using: SymmetricKey(data: key), nonce: try AES.GCM.Nonce(data: n),
                                   authenticating: aad(username, version))
        return ["version": .number(Double(version)), "nonce": .string(CanonicalJson.hex(n)), "ct": .string(CanonicalJson.b64Encode(Array(box.ciphertext + box.tag)))]
    }

    public static func open(key: [UInt8], username: String, blob: JSONValue?) -> VoiciCallSettingsValue? {
        guard let o = blob?.object, Set(o.keys) == ["version", "nonce", "ct"], let version = o["version"]?.time, let nonceHex = o["nonce"]?.string,
              CanonicalJson.isLowerHex(nonceHex, bytes: 12), let ct = CanonicalJson.b64Decode(o["ct"]), ct.count >= 16, ct.count <= maxBytes + 16,
              let nonce = try? CanonicalJson.hexToBytes(nonceHex),
              let box = try? AES.GCM.SealedBox(nonce: AES.GCM.Nonce(data: nonce), ciphertext: ct.dropLast(16), tag: ct.suffix(16)),
              let pt = try? AES.GCM.open(box, using: SymmetricKey(data: key), authenticating: aad(username, version)),
              let text = String(data: pt, encoding: .utf8), let v = JSONValue.parse(text), CanonicalJson.isCanonical(v, text) else { return nil }
        return parse(v)
    }

    /// The stored blob's version, for the next compare-and-set.
    public static func version(_ blob: JSONValue?) -> Int64 { blob?["version"]?.time ?? 0 }

    /// A version conflict: the newer settings win.
    public static func merge(local: VoiciCallSettingsValue, remote: VoiciCallSettingsValue) -> VoiciCallSettingsValue {
        remote.updatedAt > local.updatedAt ? remote : local
    }
}
