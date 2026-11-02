import Foundation
import CryptoKit

/// The JSON value and the canonical-JSON / base64 / hex rules every voi.ci and Messages record uses
/// (docs/voici-and-messages.md §7.1). Swift twin of the encoder half of packages/protocol/src/webEnvelope.ts,
/// pinned by packages/protocol/test-vectors/messages/vectors.json (`canonicalJson`, `base64`).
///
/// Public API:
///   JSONValue (null | bool | number(Double) | string | brokenString([UInt16]) | array | object), JSONValue.parse(_:),
///   JSONValue.parse(utf8:), JSONValue(any:), accessors (string, object, array, safeInt, time, isNull, isOne).
///   CanonicalJson: canonicalJson, canonicalJsonBytes, jsonStringifyByteCount, b64Encode, b64Decode, sha256Hex,
///   hexToBytes, hex, isLowerHex, utf8Decode, isSafeInteger, utf16Less, validateNoSepCtrl.
///   VoiciVerdict<Value, Code> ("ok" or a refusal code, like the TS `{ok, code}` results).
///
/// Numbers are kept as Double, exactly what JavaScript's JSON.parse gives, so "safe integer" and "-0" mean what they
/// mean in the TypeScript. Booleans are their own case (a JSONSerialization NSNumber is told apart with
/// CFBooleanGetTypeID), so `true` is never 1. A JSON string holding a lone surrogate (legal in JavaScript, impossible
/// in a Swift String) is `brokenString`: canonical JSON refuses it and the text rules call it "surrogate".
public indirect enum JSONValue: Equatable, Sendable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case brokenString([UInt16])
    case array([JSONValue])
    case object([String: JSONValue])
}

extension JSONValue: ExpressibleByStringLiteral, ExpressibleByIntegerLiteral, ExpressibleByBooleanLiteral,
    ExpressibleByNilLiteral, ExpressibleByArrayLiteral, ExpressibleByDictionaryLiteral {
    public init(stringLiteral value: String) { self = .string(value) }
    public init(integerLiteral value: Int) { self = .number(Double(value)) }
    public init(booleanLiteral value: Bool) { self = .bool(value) }
    public init(nilLiteral: ()) { self = .null }
    public init(arrayLiteral elements: JSONValue...) { self = .array(elements) }
    public init(dictionaryLiteral elements: (String, JSONValue)...) {
        var o: [String: JSONValue] = [:]
        for (k, v) in elements { o[k] = v }
        self = .object(o)
    }

    public static func int(_ n: Int64) -> JSONValue { .number(Double(n)) }
    public static func optString(_ s: String?) -> JSONValue { s.map { .string($0) } ?? .null }
    public static func optInt(_ n: Int64?) -> JSONValue { n.map { .number(Double($0)) } ?? .null }

    public var string: String? { if case .string(let s) = self { return s }; return nil }
    /// A JavaScript string: `string` or `brokenString`.
    public var isJSString: Bool {
        switch self { case .string, .brokenString: return true; default: return false }
    }
    public var object: [String: JSONValue]? { if case .object(let o) = self { return o }; return nil }
    public var array: [JSONValue]? { if case .array(let a) = self { return a }; return nil }
    public var number: Double? { if case .number(let d) = self { return d }; return nil }
    public var isNull: Bool { if case .null = self { return true }; return false }
    /// `Number.isSafeInteger`.
    public var safeInt: Int64? {
        if case .number(let d) = self, CanonicalJson.isSafeInteger(d) { return Int64(d) }
        return nil
    }
    /// A safe integer >= 0 (the TS `isTime`).
    public var time: Int64? { safeInt.flatMap { $0 >= 0 ? $0 : nil } }
    /// `=== 1` (a number, never `true`).
    public var isOne: Bool { if case .number(let d) = self { return d == 1 }; return false }
    public subscript(key: String) -> JSONValue? { object?[key] }

    /// JSONSerialization output (or plain Swift values) to a JSONValue. Nil for anything that is not JSON.
    public init?(any: Any) {
        if any is NSNull { self = .null; return }
        if let n = any as? NSNumber {
            if CFGetTypeID(n) == CFBooleanGetTypeID() { self = .bool(n.boolValue) } else { self = .number(n.doubleValue) }
            return
        }
        if let ns = any as? NSString {
            var units = [UInt16](repeating: 0, count: ns.length)
            if ns.length > 0 { ns.getCharacters(&units, range: NSRange(location: 0, length: ns.length)) }
            self = JSONValue.fromUTF16(units)
            return
        }
        if let a = any as? [Any] {
            var out: [JSONValue] = []
            for x in a { guard let v = JSONValue(any: x) else { return nil }; out.append(v) }
            self = .array(out)
            return
        }
        if let o = any as? [String: Any] {
            var out: [String: JSONValue] = [:]
            for (k, x) in o { guard let v = JSONValue(any: x) else { return nil }; out[k] = v }
            self = .object(out)
            return
        }
        return nil
    }

    static func fromUTF16(_ units: [UInt16]) -> JSONValue {
        var i = 0
        while i < units.count {
            let c = units[i]
            if c >= 0xd800 && c <= 0xdbff {
                if i + 1 < units.count, units[i + 1] >= 0xdc00 && units[i + 1] <= 0xdfff { i += 2; continue }
                return .brokenString(units)
            }
            if c >= 0xdc00 && c <= 0xdfff { return .brokenString(units) }
            i += 1
        }
        return .string(String(decoding: units, as: UTF16.self))
    }

    /// `JSON.parse` (RFC 8259, strict like JavaScript's: no trailing commas, no comments, last duplicate key wins).
    public static func parse(_ text: String) -> JSONValue? {
        var p = StrictJsonParser(units: Array(text.utf16))
        guard let v = p.value() else { return nil }
        p.skipWhitespace()
        guard p.i == p.units.count else { return Optional<JSONValue>.none }
        return v
    }

    /// `JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))`.
    public static func parse(utf8 bytes: [UInt8]) -> JSONValue? {
        guard let text = CanonicalJson.utf8Decode(bytes) else { return nil }
        return parse(text)
    }
}

private struct StrictJsonParser {
    let units: [UInt16]
    var i = 0

    init(units: [UInt16]) { self.units = units }

    mutating func skipWhitespace() {
        while i < units.count, units[i] == 0x20 || units[i] == 0x09 || units[i] == 0x0a || units[i] == 0x0d { i += 1 }
    }

    mutating func literal(_ s: String, _ v: JSONValue) -> JSONValue? {
        let u = Array(s.utf16)
        guard i + u.count <= units.count, Array(units[i..<(i + u.count)]) == u else { return nil }
        i += u.count
        return v
    }

    mutating func value() -> JSONValue? {
        skipWhitespace()
        guard i < units.count else { return nil }
        switch units[i] {
        case 0x7b: return object()
        case 0x5b: return array()
        case 0x22: return stringUnits().map { JSONValue.fromUTF16($0) }
        case 0x74: return literal("true", .bool(true))
        case 0x66: return literal("false", .bool(false))
        case 0x6e: return literal("null", .null)
        default: return number()
        }
    }

    mutating func object() -> JSONValue? {
        i += 1
        var o: [String: JSONValue] = [:]
        skipWhitespace()
        if i < units.count, units[i] == 0x7d { i += 1; return .object(o) }
        while true {
            skipWhitespace()
            guard i < units.count, units[i] == 0x22, let k = stringUnits() else { return nil }
            guard case .string(let key) = JSONValue.fromUTF16(k) else { return nil }
            skipWhitespace()
            guard i < units.count, units[i] == 0x3a else { return nil }
            i += 1
            guard let v = value() else { return nil }
            o[key] = v
            skipWhitespace()
            guard i < units.count else { return nil }
            if units[i] == 0x2c { i += 1; continue }
            if units[i] == 0x7d { i += 1; return .object(o) }
            return nil
        }
    }

    mutating func array() -> JSONValue? {
        i += 1
        var a: [JSONValue] = []
        skipWhitespace()
        if i < units.count, units[i] == 0x5d { i += 1; return .array(a) }
        while true {
            guard let v = value() else { return nil }
            a.append(v)
            skipWhitespace()
            guard i < units.count else { return nil }
            if units[i] == 0x2c { i += 1; continue }
            if units[i] == 0x5d { i += 1; return .array(a) }
            return nil
        }
    }

    mutating func stringUnits() -> [UInt16]? {
        i += 1
        var out: [UInt16] = []
        while i < units.count {
            let c = units[i]
            if c == 0x22 { i += 1; return out }
            if c < 0x20 { return nil }
            if c != 0x5c { out.append(c); i += 1; continue }
            i += 1
            guard i < units.count else { return nil }
            switch units[i] {
            case 0x22: out.append(0x22)
            case 0x5c: out.append(0x5c)
            case 0x2f: out.append(0x2f)
            case 0x62: out.append(0x08)
            case 0x66: out.append(0x0c)
            case 0x6e: out.append(0x0a)
            case 0x72: out.append(0x0d)
            case 0x74: out.append(0x09)
            case 0x75:
                guard i + 4 < units.count else { return nil }
                var n: UInt16 = 0
                for k in 1...4 {
                    let h = units[i + k]
                    let d: UInt16
                    switch h {
                    case 0x30...0x39: d = h - 0x30
                    case 0x61...0x66: d = h - 0x61 + 10
                    case 0x41...0x46: d = h - 0x41 + 10
                    default: return nil
                    }
                    n = n << 4 | d
                }
                out.append(n)
                i += 4
            default: return nil
            }
            i += 1
        }
        return nil
    }

    mutating func number() -> JSONValue? {
        let start = i
        func digit(_ k: Int) -> Bool { k < units.count && units[k] >= 0x30 && units[k] <= 0x39 }
        if i < units.count, units[i] == 0x2d { i += 1 }
        guard digit(i) else { return nil }
        if units[i] == 0x30 { i += 1 } else { while digit(i) { i += 1 } }
        if i < units.count, units[i] == 0x2e {
            i += 1
            guard digit(i) else { return nil }
            while digit(i) { i += 1 }
        }
        if i < units.count, units[i] == 0x65 || units[i] == 0x45 {
            i += 1
            if i < units.count, units[i] == 0x2b || units[i] == 0x2d { i += 1 }
            guard digit(i) else { return nil }
            while digit(i) { i += 1 }
        }
        guard let d = Double(String(decoding: units[start..<i], as: UTF16.self)) else { return nil }
        return .number(d)
    }
}

/// Outcome of a check: "ok" with its value, or the refusal code the TypeScript returns.
public enum VoiciVerdict<Value, Code: RawRepresentable> where Code.RawValue == String {
    case ok(Value)
    case refused(Code)

    public var code: String {
        switch self { case .ok: return "ok"; case .refused(let c): return c.rawValue }
    }
    public var value: Value? { if case .ok(let v) = self { return v }; return nil }
    public var isOk: Bool { if case .ok = self { return true }; return false }
}

public struct CanonicalJsonError: Error, Equatable, CustomStringConvertible {
    public let message: String
    public init(_ message: String) { self.message = message }
    public var description: String { message }
}

public enum CanonicalJson {
    static let maxSafeInteger: Double = 9_007_199_254_740_991

    /// `Number.isSafeInteger`.
    public static func isSafeInteger(_ d: Double) -> Bool {
        d.isFinite && d.rounded(.towardZero) == d && abs(d) <= maxSafeInteger
    }

    static func isTime(_ n: Int64) -> Bool { n >= 0 && Double(n) <= maxSafeInteger }

    /// JavaScript `<` on strings: UTF-16 code unit order.
    public static func utf16Less(_ a: String, _ b: String) -> Bool { a.utf16.lexicographicallyPrecedes(b.utf16) }

    /// Byte-exact string equality (Swift's `==` is canonical equivalence; JavaScript's `===` is not).
    static func same(_ a: String, _ b: String) -> Bool { a.utf16.elementsEqual(b.utf16) }

    // MARK: canonical JSON

    static func jsonString(_ s: String, into out: inout String) {
        out.append("\"")
        for u in s.unicodeScalars {
            switch u.value {
            case 0x22: out.append("\\\"")
            case 0x5c: out.append("\\\\")
            case 0x08: out.append("\\b")
            case 0x0c: out.append("\\f")
            case 0x0a: out.append("\\n")
            case 0x0d: out.append("\\r")
            case 0x09: out.append("\\t")
            case 0..<0x20: out.append(String(format: "\\u%04x", u.value))
            default: out.unicodeScalars.append(u)
            }
        }
        out.append("\"")
    }

    static func sortedKeys(_ o: [String: JSONValue]) -> [String] { o.keys.sorted(by: utf16Less) }

    static func write(_ v: JSONValue, into out: inout String) throws {
        switch v {
        case .null: out.append("null")
        case .bool(let b): out.append(b ? "true" : "false")
        case .number(let d):
            if !isSafeInteger(d) || (d == 0 && d.sign == .minus) { throw CanonicalJsonError("canonical JSON: only safe integers") }
            out.append(String(Int64(d)))
        case .string(let s): jsonString(s, into: &out)
        case .brokenString: throw CanonicalJsonError("canonical JSON: lone surrogate")
        case .array(let a):
            out.append("[")
            for (n, x) in a.enumerated() {
                if n > 0 { out.append(",") }
                try write(x, into: &out)
            }
            out.append("]")
        case .object(let o):
            out.append("{")
            for (n, k) in sortedKeys(o).enumerated() {
                if n > 0 { out.append(",") }
                jsonString(k, into: &out)
                out.append(":")
                try write(o[k]!, into: &out)
            }
            out.append("}")
        }
    }

    /// Canonical JSON text: keys sorted by UTF-16 code units, no whitespace, JSON.stringify escaping, safe integers.
    public static func canonicalJson(_ v: JSONValue) throws -> String {
        var out = ""
        try write(v, into: &out)
        return out
    }

    public static func canonicalJsonBytes(_ v: JSONValue) throws -> [UInt8] { Array(try canonicalJson(v).utf8) }

    /// `canonicalJson(v) === text`, compared as code units (not Swift's canonical equivalence); false when refused.
    static func isCanonical(_ v: JSONValue, _ text: String) -> Bool {
        guard let c = try? canonicalJson(v) else { return false }
        return same(c, text)
    }

    /// UTF-8 length of `JSON.stringify(v)` (what a size cap on an already-parsed value measures).
    public static func jsonStringifyByteCount(_ v: JSONValue) -> Int {
        switch v {
        case .null: return 4
        case .bool(let b): return b ? 4 : 5
        case .number(let d): return jsNumberString(d).utf8.count
        case .string(let s):
            var out = ""
            jsonString(s, into: &out)
            return out.utf8.count
        case .brokenString(let units):
            var n = 2
            var i = 0
            while i < units.count {
                let c = units[i]
                if c >= 0xd800 && c <= 0xdbff, i + 1 < units.count, units[i + 1] >= 0xdc00 && units[i + 1] <= 0xdfff {
                    n += 4; i += 2; continue
                }
                if c >= 0xd800 && c <= 0xdfff { n += 6 } else if c == 0x22 || c == 0x5c || c == 0x08 || c == 0x0c || c == 0x0a || c == 0x0d || c == 0x09 { n += 2 } else if c < 0x20 { n += 6 } else if c < 0x80 { n += 1 } else if c < 0x800 { n += 2 } else { n += 3 }
                i += 1
            }
            return n
        case .array(let a): return 2 + a.reduce(0) { $0 + jsonStringifyByteCount($1) } + max(0, a.count - 1)
        case .object(let o):
            return 2 + o.reduce(0) { $0 + jsonStringifyByteCount(.string($1.key)) + 1 + jsonStringifyByteCount($1.value) } + max(0, o.count - 1)
        }
    }

    /// JavaScript's Number::toString for a finite double (shortest round-trip digits).
    static func jsNumberString(_ d: Double) -> String {
        if d == 0 { return "0" }
        if !d.isFinite { return "null" }
        let neg = d < 0
        let text = "\(abs(d))"
        var mantissa = text
        var exp = 0
        if let e = text.firstIndex(where: { $0 == "e" || $0 == "E" }) {
            mantissa = String(text[..<e])
            exp = Int(text[text.index(after: e)...].replacingOccurrences(of: "+", with: "")) ?? 0
        }
        var digits = mantissa
        var point = digits.count
        if let dot = mantissa.firstIndex(of: ".") {
            point = mantissa.distance(from: mantissa.startIndex, to: dot)
            digits = mantissa.replacingOccurrences(of: ".", with: "")
        }
        var chars = Array(digits)
        while chars.count > 1, chars.first == "0" { chars.removeFirst(); point -= 1 }
        while chars.count > 1, chars.last == "0" { chars.removeLast() }
        let s = String(chars)
        let k = s.count
        let n = point + exp
        var out: String
        if k <= n && n <= 21 {
            out = s + String(repeating: "0", count: n - k)
        } else if 0 < n && n <= 21 {
            out = String(chars[0..<n]) + "." + String(chars[n...])
        } else if -6 < n && n <= 0 {
            out = "0." + String(repeating: "0", count: -n) + s
        } else {
            let e = n - 1
            out = String(chars[0]) + (k > 1 ? "." + String(chars[1...]) : "") + "e" + (e >= 0 ? "+" : "-") + String(abs(e))
        }
        return neg ? "-" + out : out
    }

    // MARK: base64, hex, hashes

    static let b64Alphabet = Array("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/".utf8)

    /// Standard base64 with padding.
    public static func b64Encode(_ b: [UInt8]) -> String {
        var out = [UInt8]()
        out.reserveCapacity((b.count + 2) / 3 * 4)
        var i = 0
        while i < b.count {
            let n = (UInt32(b[i]) << 16) | (UInt32(i + 1 < b.count ? b[i + 1] : 0) << 8) | UInt32(i + 2 < b.count ? b[i + 2] : 0)
            out.append(b64Alphabet[Int((n >> 18) & 63)])
            out.append(b64Alphabet[Int((n >> 12) & 63)])
            out.append(i + 1 < b.count ? b64Alphabet[Int((n >> 6) & 63)] : 0x3d)
            out.append(i + 2 < b.count ? b64Alphabet[Int(n & 63)] : 0x3d)
            i += 3
        }
        return String(decoding: out, as: UTF8.self)
    }

    /// Strict standard base64: padded and canonical (re-encodes to the same string), else nil.
    public static func b64Decode(_ s: String) -> [UInt8]? {
        let u = Array(s.utf8)
        guard u.count % 4 == 0 else { return nil }
        var pad = 0
        for (n, c) in u.enumerated() {
            if c == 0x3d {
                pad += 1
                continue
            }
            if pad > 0 { return nil }
            let ok = (0x41...0x5a).contains(c) || (0x61...0x7a).contains(c) || (0x30...0x39).contains(c) || c == 0x2b || c == 0x2f
            if !ok { return nil }
            _ = n
        }
        if pad > 2 { return nil }
        func val(_ c: UInt8) -> UInt32 {
            switch c {
            case 0x41...0x5a: return UInt32(c - 0x41)
            case 0x61...0x7a: return UInt32(c - 0x61 + 26)
            case 0x30...0x39: return UInt32(c - 0x30 + 52)
            case 0x2b: return 62
            case 0x2f: return 63
            default: return 0
            }
        }
        let len = u.count / 4 * 3 - (s.hasSuffix("==") ? 2 : s.hasSuffix("=") ? 1 : 0)
        var out = [UInt8]()
        out.reserveCapacity(max(0, len))
        var i = 0
        while i < u.count {
            let n = (val(u[i]) << 18) | (val(u[i + 1]) << 12) | (val(u[i + 2]) << 6) | val(u[i + 3])
            if out.count < len { out.append(UInt8((n >> 16) & 0xff)) }
            if out.count < len { out.append(UInt8((n >> 8) & 0xff)) }
            if out.count < len { out.append(UInt8(n & 0xff)) }
            i += 4
        }
        return b64Encode(out) == s ? out : nil
    }

    public static func b64Decode(_ v: JSONValue?) -> [UInt8]? {
        guard let s = v?.string else { return nil }
        return b64Decode(s)
    }

    public static func hex(_ b: [UInt8]) -> String {
        let digits = Array("0123456789abcdef".utf8)
        var out = [UInt8]()
        out.reserveCapacity(b.count * 2)
        for x in b { out.append(digits[Int(x >> 4)]); out.append(digits[Int(x & 0x0f)]) }
        return String(decoding: out, as: UTF8.self)
    }

    /// `^[0-9a-f]*$`, even length, and exactly `bytes` bytes when given.
    public static func isLowerHex(_ s: String, bytes: Int? = nil) -> Bool {
        let u = s.utf8
        guard u.count % 2 == 0, u.allSatisfy({ (0x30...0x39).contains($0) || (0x61...0x66).contains($0) }) else { return false }
        return bytes == nil || u.count == bytes! * 2
    }

    public static func isLowerHex(_ v: JSONValue?, bytes: Int? = nil) -> Bool {
        guard let s = v?.string else { return false }
        return isLowerHex(s, bytes: bytes)
    }

    public static func hexToBytes(_ h: String) throws -> [UInt8] {
        guard isLowerHex(h) else { throw CanonicalJsonError("not lowercase hex") }
        let u = Array(h.utf8)
        func nib(_ c: UInt8) -> UInt8 { c <= 0x39 ? c - 0x30 : c - 0x61 + 10 }
        return stride(from: 0, to: u.count, by: 2).map { nib(u[$0]) << 4 | nib(u[$0 + 1]) }
    }

    public static func sha256(_ b: [UInt8]) -> [UInt8] { Array(SHA256.hash(data: b)) }
    public static func sha256Hex(_ b: [UInt8]) -> String { hex(sha256(b)) }
    public static func sha256Hex(_ s: String) -> String { sha256Hex(Array(s.utf8)) }

    /// `new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)`: a leading BOM is kept (so a JSON
    /// parse refuses it), malformed UTF-8 is nil.
    public static func utf8Decode(_ bytes: [UInt8]) -> String? {
        let s = String(decoding: bytes, as: UTF8.self)
        return s.utf8.elementsEqual(bytes) ? s : nil
    }

    /// The canonical-bytes separator rule: no "|" and no C0 control or DEL.
    public static func validateNoSepCtrl(_ name: String, _ value: String) throws {
        for c in value.utf16 where c == 0x7c || c <= 0x1f || c == 0x7f {
            throw CanonicalJsonError("canonical-bytes field \"\(name)\" contains a separator or control character")
        }
    }

    static func join(_ parts: [String]) -> [UInt8] { Array(parts.joined(separator: "|").utf8) }

    // MARK: signatures

    public static func ed25519PublicKey(seed: [UInt8]) throws -> [UInt8] {
        Array(try Curve25519.Signing.PrivateKey(rawRepresentation: seed).publicKey.rawRepresentation)
    }

    /// Ed25519 signature (hex). CryptoKit's signatures are randomized: verify, never compare bytes.
    public static func ed25519SignHex(_ msg: [UInt8], seed: [UInt8]) throws -> String {
        hex(Array(try Curve25519.Signing.PrivateKey(rawRepresentation: seed).signature(for: msg)))
    }

    public static func ed25519VerifyHex(_ sigHex: String, _ msg: [UInt8], _ pubHex: String) -> Bool {
        guard isLowerHex(sigHex, bytes: 64), isLowerHex(pubHex, bytes: 32),
              let key = try? Curve25519.Signing.PublicKey(rawRepresentation: hexToBytes(pubHex)),
              let sig = try? hexToBytes(sigHex) else { return false }
        return key.isValidSignature(sig, for: msg)
    }

    /// ECDSA P-256 / SHA-256, IEEE P1363 r||s (hex 128), uncompressed SEC1 key (hex 130). High-S accepted.
    public static func p256VerifyP1363(_ sigHex: String, _ msg: [UInt8], _ pubHex: String) -> Bool {
        guard isLowerHex(sigHex, bytes: 64), isLowerHex(pubHex, bytes: 65), pubHex.hasPrefix("04"),
              let key = try? P256.Signing.PublicKey(x963Representation: hexToBytes(pubHex)),
              var raw = try? hexToBytes(sigHex) else { return false }
        // (r, s) verifies exactly when (r, n - s) does: fold a high S down so the result never depends on whether
        // the platform enforces low S (WebCrypto does not normalize).
        let s = Array(raw[32..<64])
        if s.lexicographicallyPrecedes(p256Order) && p256HalfOrder.lexicographicallyPrecedes(s) {
            raw.replaceSubrange(32..<64, with: subtract(p256Order, s))
        }
        guard let sig = try? P256.Signing.ECDSASignature(rawRepresentation: raw) else { return false }
        return key.isValidSignature(sig, for: msg)
    }

    static let p256Order: [UInt8] = try! hexToBytes("ffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551")
    static let p256HalfOrder: [UInt8] = try! hexToBytes("7fffffff800000007fffffffffffffffde737d56d38bcf4279dce5617e3192a8")

    /// a - b for equal-length big-endian numbers with a >= b.
    static func subtract(_ a: [UInt8], _ b: [UInt8]) -> [UInt8] {
        var out = [UInt8](repeating: 0, count: a.count)
        var borrow = 0
        for i in stride(from: a.count - 1, through: 0, by: -1) {
            var d = Int(a[i]) - Int(b[i]) - borrow
            borrow = d < 0 ? 1 : 0
            if d < 0 { d += 256 }
            out[i] = UInt8(d)
        }
        return out
    }
}
