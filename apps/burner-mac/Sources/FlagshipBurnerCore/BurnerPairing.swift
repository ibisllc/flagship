import Foundation
import CryptoKit

/// Phone↔burner pairing — the burner (initiator) side.
///
/// The burner shows a QR + a short human code. The phone scans/types it,
/// generates its own X25519 keypair, derives a shared secret, and both
/// sides compute the SAME 6-digit SAS + AES-256-GCM key LOCALLY. The
/// burner forwards its ephemeral public key over the relay (`burner-hello`)
/// so a typed-code phone (which only has the short code, not the pubkey)
/// can complete the handshake; a QR phone already has it from the QR and
/// verifies the relayed copy matches.
///
/// Crypto is byte-compatible with the phone's `QrRelay` (the website QR
/// flow): X25519 → HKDF-SHA256 with salt `flagship/qr/v1`, info
/// `flagship/qr/sas/v1` (SAS) and `flagship/qr/enc/v1` (AEAD key). The
/// only burner-specific addition is the short-code → session-id mapping
/// (`flagship/burner-sid/v1`), pinned by a cross-platform vector.
///
/// SECURITY: the SAS is never on the wire. A relay that swapped pubkeys
/// produces a mismatched code on the two screens, which the user catches.
/// The live socket is the gate — when it drops, the burner re-locks.
public enum BurnerPairing {

    public static let relayHkdfSalt = Data("flagship/qr/v1".utf8)
    public static let encInfo = Data("flagship/qr/enc/v1".utf8)
    public static let sasInfo = Data("flagship/qr/sas/v1".utf8)
    /// Domain-separation tag for deriving the 32-char relay session id from
    /// the short human code. MUST match the phone side.
    public static let sidTag = Data("flagship/burner-sid/v1".utf8)

    /// Bytes of entropy behind the short human code. 5 bytes = exactly 8
    /// base32 chars (no padding) — short enough to read aloud / type, and
    /// (with the relay's per-IP upgrade limit) ample for a short-lived
    /// pairing whose real authentication is the SAS.
    public static let codeByteCount = 5

    public enum PairingError: Error, LocalizedError {
        case badPublicKey
        case derivationFailed(String)
        case badShortCode
        case openFailed(String)
        public var errorDescription: String? {
            switch self {
            case .badPublicKey: return "Phone public key must be 32 raw X25519 bytes."
            case .derivationFailed(let m): return "Shared-secret derivation failed: \(m)"
            case .badShortCode: return "That code isn't valid — check it on the burner."
            case .openFailed(let m): return "Couldn't decrypt what the phone sent: \(m)"
            }
        }
    }

    // MARK: - Session identity (code ⇄ sid)

    /// Generate the random bytes behind a new pairing's short code.
    public static func newCodeBytes() -> Data {
        Data((0..<codeByteCount).map { _ in UInt8.random(in: 0...255) })
    }

    /// The relay session id derived from the short code's bytes — the
    /// `<sid>` in `/burner-pipe/<sid>`. base64url of SHA256(tag || code),
    /// truncated to 32 chars (within the relay's 16–64 bound). Both peers
    /// compute it identically, so a QR (which could also carry the sid) and
    /// a typed code converge on the same Durable Object.
    public static func sessionId(forCodeBytes code: Data) -> String {
        var h = SHA256()
        h.update(data: sidTag)
        h.update(data: code)
        let digest = Data(h.finalize())
        return String(Base64URLBurner.encode(digest).prefix(32))
    }

    /// The human-typeable short code (8 uppercase base32 chars, no padding).
    public static func humanCode(fromBytes code: Data) -> String {
        Base32.encode(code)
    }

    /// Decode a user-typed short code back to its bytes. Tolerant of
    /// lowercase, spaces, and dashes (display grouping). nil if invalid.
    public static func codeBytes(fromHumanCode raw: String) -> Data? {
        let cleaned = raw.uppercased().filter { $0 != " " && $0 != "-" }
        guard let bytes = Base32.decode(cleaned), bytes.count == codeByteCount else { return nil }
        return bytes
    }

    /// Display form of the short code, dash-grouped in 4s: "ABCD-EFGH".
    public static func formatHumanCode(_ code: String) -> String {
        let chars = Array(code)
        guard chars.count == 8 else { return code }
        return String(chars[0..<4]) + "-" + String(chars[4..<8])
    }

    /// The QR payload the burner displays. Carries the short code AND the
    /// burner's ephemeral X25519 pubkey so a scanning phone needs no relay
    /// round-trip to derive the SAS.
    public static func qrPayload(humanCode: String, burnerPublicKey: Data) -> String {
        "flagship://burner?c=\(humanCode)&k=\(Base64URLBurner.encode(burnerPublicKey))"
    }

    // MARK: - Handshake

    public struct DerivedMaterial {
        public let matchCode: String        // 6 digits, zero-padded
        public let aeadKey: SymmetricKey
    }

    /// Burner-side X25519 + HKDF. `burnerPrivateKey` is this session's
    /// ephemeral key; `phonePublicKey` is the raw 32-byte key the phone
    /// sent in `phone-hello`. Mirrors `QrRelay.deriveMaterial` exactly.
    public static func deriveMaterial(
        burnerPrivateKey: Curve25519.KeyAgreement.PrivateKey,
        phonePublicKey: Data
    ) throws -> DerivedMaterial {
        guard phonePublicKey.count == 32 else { throw PairingError.badPublicKey }
        let peer: Curve25519.KeyAgreement.PublicKey
        do { peer = try Curve25519.KeyAgreement.PublicKey(rawRepresentation: phonePublicKey) }
        catch { throw PairingError.badPublicKey }

        let shared: SharedSecret
        do { shared = try burnerPrivateKey.sharedSecretFromKeyAgreement(with: peer) }
        catch { throw PairingError.derivationFailed("\(error)") }

        let aeadKey = shared.hkdfDerivedSymmetricKey(
            using: SHA256.self, salt: relayHkdfSalt, sharedInfo: encInfo, outputByteCount: 32)
        let sasBytes = shared.hkdfDerivedSymmetricKey(
            using: SHA256.self, salt: relayHkdfSalt, sharedInfo: sasInfo, outputByteCount: 4
        ).withUnsafeBytes { Data($0) }

        let u32 = UInt32(sasBytes[0]) << 24 | UInt32(sasBytes[1]) << 16
                | UInt32(sasBytes[2]) << 8 | UInt32(sasBytes[3])
        return DerivedMaterial(matchCode: String(format: "%06d", u32 % 1_000_000), aeadKey: aeadKey)
    }

    /// AEAD-open a payload the phone sealed with the session key. The phone
    /// ships `ciphertext (= ct||tag)` and a 12-byte `nonce` separately
    /// (matching `QrRelay.seal`).
    public static func open(
        ciphertextBase64Url ct: String,
        nonceBase64Url nonce: String,
        key: SymmetricKey
    ) throws -> Data {
        guard let ctData = Base64URLBurner.decode(ct), let nonceData = Base64URLBurner.decode(nonce),
              nonceData.count == 12, ctData.count >= 16 else {
            throw PairingError.openFailed("malformed ciphertext/nonce")
        }
        let tag = ctData.suffix(16)
        let body = ctData.prefix(ctData.count - 16)
        do {
            let box = try AES.GCM.SealedBox(nonce: try AES.GCM.Nonce(data: nonceData),
                                            ciphertext: body, tag: tag)
            return try AES.GCM.open(box, using: key)
        } catch {
            throw PairingError.openFailed("\(error)")
        }
    }

    /// Display split of the 6-digit SAS ("123 456").
    public static func formatMatchCode(_ code: String) -> String {
        guard code.count == 6 else { return code }
        let i = code.index(code.startIndex, offsetBy: 3)
        return code[code.startIndex..<i] + " " + code[i...]
    }
}

/// base64url (RFC 4648 §5, no padding) — local copy so FlagshipBurnerCore
/// has no cross-package dependency.
public enum Base64URLBurner {
    public static func encode(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
    public static func decode(_ s: String) -> Data? {
        var p = s.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        p.append(String(repeating: "=", count: (4 - p.count % 4) % 4))
        return Data(base64Encoded: p)
    }
}

/// RFC 4648 base32 (uppercase A–Z2–7, no padding). Used for the short
/// human pairing code — case-insensitive on decode, dash/space tolerant.
public enum Base32 {
    private static let alphabet = Array("ABCDEFGHIJKLMNOPQRSTUVWXYZ234567")

    public static func encode(_ data: Data) -> String {
        var out = ""
        var buffer = 0
        var bits = 0
        for byte in data {
            buffer = (buffer << 8) | Int(byte)
            bits += 8
            while bits >= 5 {
                bits -= 5
                out.append(alphabet[(buffer >> bits) & 0x1f])
            }
        }
        if bits > 0 {
            out.append(alphabet[(buffer << (5 - bits)) & 0x1f])
        }
        return out
    }

    public static func decode(_ s: String) -> Data? {
        var lookup = [Character: Int]()
        for (i, c) in alphabet.enumerated() { lookup[c] = i }
        var out = Data()
        var buffer = 0
        var bits = 0
        for ch in s {
            guard let v = lookup[ch] else { return nil }
            buffer = (buffer << 5) | v
            bits += 5
            if bits >= 8 {
                bits -= 8
                out.append(UInt8((buffer >> bits) & 0xff))
            }
        }
        return out
    }
}
