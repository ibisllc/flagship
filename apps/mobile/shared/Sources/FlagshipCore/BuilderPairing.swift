import Foundation
import CryptoKit

/// Phone-side of the phone↔desktop-builder pairing — the part that's
/// specific to the builder (the SAS + AEAD reuse `QrRelay`, since the
/// constants are identical).
///
/// The builder shows a QR (`flagship://builder?c=<code>&k=<builderPkB64url>`)
/// plus an 8-char short code. The phone scans the QR (gets the code AND
/// the pubkey) or types the code (gets only the code, learns the pubkey
/// over the relay via `builder-hello`). Both derive the relay session id
/// from the code identically, so a scan and a typed code converge on the
/// same Durable Object.
///
/// Mirrors apps/builder-mac BuilderPairing (Swift) + the cross-platform
/// vector in apps/com builderPairingVector.test.ts.
public enum BuilderPairing {

    /// Domain-separation tag for code → session-id (must match the builder).
    public static let sidTag = Data("flagship/builder-sid/v1".utf8)
    public static let codeByteCount = 5

    public struct Scanned: Equatable, Sendable {
        public let codeBytes: Data
        /// Present when scanned from a QR; nil when typed (learned later).
        public let builderPublicKey: Data?
        public init(codeBytes: Data, builderPublicKey: Data?) {
            self.codeBytes = codeBytes
            self.builderPublicKey = builderPublicKey
        }
    }

    public enum PairError: Error, LocalizedError {
        case badCode
        case badQr(String)
        public var errorDescription: String? {
            switch self {
            case .badCode: return "That code isn't valid — check it on the computer."
            case .badQr(let m): return "QR: \(m)"
            }
        }
    }

    /// The relay session id (`<sid>` in `/builder-pipe/<sid>`).
    public static func sessionId(forCodeBytes code: Data) -> String {
        var h = SHA256()
        h.update(data: sidTag)
        h.update(data: code)
        return String(Base64URL.encode(Data(h.finalize())).prefix(32))
    }

    /// Decode a user-typed short code (case-insensitive, dash/space-tolerant).
    public static func codeBytes(fromHumanCode raw: String) -> Data? {
        let cleaned = raw.uppercased().filter { $0 != " " && $0 != "-" }
        guard let bytes = Base32.decode(cleaned), bytes.count == codeByteCount else { return nil }
        return bytes
    }

    /// Parse either a scanned builder QR or a typed short code.
    /// Accepts: `flagship://builder?c=<code>&k=<pk>`, `c=<code>&k=<pk>`,
    /// or a bare 8-char code.
    public static func parse(_ raw: String) throws -> Scanned {
        let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { throw PairError.badQr("empty") }

        // Bare typed code (no query).
        if !text.contains("=") && !text.contains("?") {
            guard let code = codeBytes(fromHumanCode: text) else { throw PairError.badCode }
            return Scanned(codeBytes: code, builderPublicKey: nil)
        }

        var c: String?
        var k: String?
        let normalized = text.hasPrefix("flagship://")
            ? text.replacingOccurrences(of: "flagship://", with: "https://_/")
            : text
        if let comps = URLComponents(string: normalized) {
            for q in comps.queryItems ?? [] {
                if q.name == "c" { c = q.value }
                if q.name == "k" { k = q.value }
            }
        }
        guard let codeStr = c, let code = codeBytes(fromHumanCode: codeStr) else {
            throw PairError.badCode
        }
        var pk: Data? = nil
        if let kStr = k, let raw = Base64URL.decode(kStr), raw.count == 32 { pk = raw }
        return Scanned(codeBytes: code, builderPublicKey: pk)
    }

    /// True if a string looks like a builder pairing QR/code (for the
    /// scanner's `validate` predicate).
    public static func looksLikeBuilderCode(_ raw: String) -> Bool {
        (try? parse(raw)) != nil
    }
}

/// RFC 4648 base32 (uppercase A–Z2–7, no padding). Mirrors apps/builder-mac.
public enum Base32 {
    private static let alphabet = Array("ABCDEFGHIJKLMNOPQRSTUVWXYZ234567")

    public static func encode(_ data: Data) -> String {
        var out = "", buffer = 0, bits = 0
        for byte in data {
            buffer = (buffer << 8) | Int(byte); bits += 8
            while bits >= 5 { bits -= 5; out.append(alphabet[(buffer >> bits) & 0x1f]) }
        }
        if bits > 0 { out.append(alphabet[(buffer << (5 - bits)) & 0x1f]) }
        return out
    }

    public static func decode(_ s: String) -> Data? {
        var lookup = [Character: Int]()
        for (i, c) in alphabet.enumerated() { lookup[c] = i }
        var out = Data(), buffer = 0, bits = 0
        for ch in s {
            guard let v = lookup[ch] else { return nil }
            buffer = (buffer << 5) | v; bits += 5
            if bits >= 8 { bits -= 8; out.append(UInt8((buffer >> bits) & 0xff)) }
        }
        return out
    }
}
