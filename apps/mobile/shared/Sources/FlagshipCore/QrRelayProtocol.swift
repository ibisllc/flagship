import Foundation
import CryptoKit
import FlagshipAPI

/// Phone-side QR relay protocol (v2). Mirrors
/// apps/web/public/heroQr.js + apps/web/public/webapp/views/create-server.js.
///
/// The browser-on-flagshipserver.com displays a QR encoding
///   https://flagshipserver.com/qr?s=<sid>&k=<pkB-base64url>
/// where sid is the relay session id and pkB is the browser's ephemeral
/// X25519 public key. The phone scans this URL, generates its own
/// X25519 keypair, computes the shared secret, derives both a 256-bit
/// AEAD key and a 6-digit SAS match code locally, connects to the
/// relay WS as role=phone, exchanges hello/ack, and on user-confirm
/// AEAD-encrypts the canonical InstallBlob bundle and ships it.
///
/// SECURITY: the match code is NEVER on the wire — both peers compute
/// it from the shared X25519 secret. A MitM that swapped pubkeys would
/// produce a mismatched code on the two screens, which the user catches
/// visually. The 600 ms phone-side confirm gate prevents reflexive
/// double-taps from bypassing the check.
public enum QrRelay {

    /// Control apex host, via `Endpoints` (prod-default + test override).
    public static var qrUrlHost: String { Endpoints.controlHost }
    public static let relayHkdfSalt = Data("flagship/qr/v1".utf8)
    public static let encInfo = Data("flagship/qr/enc/v1".utf8)
    public static let sasInfo = Data("flagship/qr/sas/v1".utf8)

    /// Parsed contents of a QR URL.
    public struct QrSession: Equatable, Sendable {
        public let sid: String
        public let browserPublicKey: Data    // raw 32-byte X25519
        public init(sid: String, browserPublicKey: Data) {
            self.sid = sid; self.browserPublicKey = browserPublicKey
        }
    }

    /// Material derived from the X25519 handshake. `matchCode` is the
    /// 6-digit string the user sees on the phone; the same 6 digits
    /// appear on the browser. `aeadKey` keys an AES-256-GCM seal.
    public struct DerivedMaterial: Sendable {
        public let matchCode: String        // 6 digits, zero-padded
        public let aeadKey: SymmetricKey
    }

    public enum RelayError: Error, LocalizedError, Sendable {
        case malformedQrUrl(String)
        case badPublicKey
        case derivationFailed(String)
        public var errorDescription: String? {
            switch self {
            case .malformedQrUrl(let m): return "QR URL: \(m)"
            case .badPublicKey:           return "Browser public key must be 32 raw X25519 bytes."
            case .derivationFailed(let m): return "Shared-secret derivation failed: \(m)"
            }
        }
    }

    /// Parse one of:
    ///   - https://flagshipserver.com/qr?s=<sid>&k=<pkB>
    ///   - flagship://qr?s=<sid>&k=<pkB>
    ///   - s=<sid>&k=<pkB>
    /// All return the same QrSession.
    public static func parseQrUrl(_ raw: String) throws -> QrSession {
        let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { throw RelayError.malformedQrUrl("empty") }
        var s: String? = nil
        var k: String? = nil
        if text.contains("?") {
            let normalized = text.hasPrefix("flagship://")
                ? text.replacingOccurrences(of: "flagship://", with: "https://_/")
                : text
            guard let comps = URLComponents(string: normalized) else {
                throw RelayError.malformedQrUrl("could not parse")
            }
            for q in comps.queryItems ?? [] {
                if q.name == "s" { s = q.value }
                if q.name == "k" { k = q.value }
            }
        } else if text.contains("=") {
            let comps = text.split(separator: "&")
            for pair in comps {
                let kv = pair.split(separator: "=", maxSplits: 1).map(String.init)
                guard kv.count == 2 else { continue }
                if kv[0] == "s" { s = kv[1] }
                if kv[0] == "k" { k = kv[1] }
            }
        }
        guard let sid = s, !sid.isEmpty,
              let pkB64u = k, !pkB64u.isEmpty else {
            throw RelayError.malformedQrUrl("missing s= or k=")
        }
        guard let pkRaw = Base64URL.decode(pkB64u) else {
            throw RelayError.malformedQrUrl("k is not valid base64url")
        }
        guard pkRaw.count == 32 else { throw RelayError.badPublicKey }
        return QrSession(sid: sid, browserPublicKey: pkRaw)
    }

    /// Build a VALID demo QR URL for MOCK / UI-testing ONLY. Generates a fresh
    /// ephemeral browser X25519 keypair + a random sid and formats it exactly
    /// like the URL the browser shows. The phone-side flow derives a real match
    /// code from it, and in MOCK mode the mock relay acks — so the full
    /// create-server flow (connect → match → mint → deliver) runs end-to-end
    /// against the mock backend without a desktop. The UI only surfaces this in
    /// mock mode; it is never used against the live relay.
    public static func makeDemoQrUrl() -> String {
        let browserSk = Curve25519.KeyAgreement.PrivateKey()
        let k = Base64URL.encode(browserSk.publicKey.rawRepresentation)
        let sid = Base64URL.encode(Data((0..<9).map { _ in UInt8.random(in: 0...255) }))
        return "https://\(qrUrlHost)/qr?s=\(sid)&k=\(k)"
    }

    /// Run the local X25519 + HKDF on the phone side. The caller passes
    /// its freshly-generated private key (don't reuse — ephemeral) and
    /// the browser's raw public key from the QR URL. Output is the
    /// match code the user verifies + the AEAD key that wraps the
    /// InstallBlob payload.
    public static func deriveMaterial(
        phonePrivateKey: Curve25519.KeyAgreement.PrivateKey,
        browserPublicKey: Data
    ) throws -> DerivedMaterial {
        guard browserPublicKey.count == 32 else { throw RelayError.badPublicKey }
        let peer: Curve25519.KeyAgreement.PublicKey
        do { peer = try Curve25519.KeyAgreement.PublicKey(rawRepresentation: browserPublicKey) }
        catch { throw RelayError.derivationFailed("\(error)") }

        let shared: SharedSecret
        do { shared = try phonePrivateKey.sharedSecretFromKeyAgreement(with: peer) }
        catch { throw RelayError.derivationFailed("\(error)") }

        let aeadKey = shared.hkdfDerivedSymmetricKey(
            using: SHA256.self,
            salt: relayHkdfSalt,
            sharedInfo: encInfo,
            outputByteCount: 32
        )
        let sasBytes = shared.hkdfDerivedSymmetricKey(
            using: SHA256.self,
            salt: relayHkdfSalt,
            sharedInfo: sasInfo,
            outputByteCount: 4
        ).withUnsafeBytes { Data($0) }

        let u32 = UInt32(sasBytes[0]) << 24
                | UInt32(sasBytes[1]) << 16
                | UInt32(sasBytes[2]) << 8
                | UInt32(sasBytes[3])
        let n = u32 % 1_000_000
        let match = String(format: "%06d", n)
        return DerivedMaterial(matchCode: match, aeadKey: aeadKey)
    }

    /// AEAD-seal the phone's payload before pushing through the relay.
    /// Returns (ciphertext, 12-byte nonce). The browser AEAD-opens the
    /// concatenation `nonce || ciphertext` under the same kEnc.
    public static func seal(payload: Data, with key: SymmetricKey) throws -> (ciphertextBase64Url: String, nonceBase64Url: String) {
        let nonceBytes = Data((0..<12).map { _ in UInt8.random(in: 0...255) })
        let nonce = try AES.GCM.Nonce(data: nonceBytes)
        let sealed = try AES.GCM.seal(payload, using: key, nonce: nonce)
        // SealedBox.combined is nonce || ciphertext || tag; we ship the
        // ciphertext+tag and the nonce separately, matching the wire
        // format in create-server.js / heroQr.js.
        let ct = sealed.ciphertext + sealed.tag
        return (Base64URL.encode(ct), Base64URL.encode(nonceBytes))
    }

    /// Helper for the canonical match-code split (`123 456`) the UI
    /// shows. Identical to the browser side's `formatMatchCode`.
    public static func formatMatchCode(_ code: String) -> String {
        guard code.count == 6 else { return code }
        let i = code.index(code.startIndex, offsetBy: 3)
        return code[code.startIndex..<i] + " " + code[i...]
    }
}

/// base64url (RFC 4648 §5) helpers — no padding. Mirrors the
/// b64urlEncode/decode pair in heroQr.js.
public enum Base64URL {
    public static func encode(_ data: Data) -> String {
        let b64 = data.base64EncodedString()
        return b64
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
    public static func decode(_ s: String) -> Data? {
        var padded = s.replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        let pad = (4 - padded.count % 4) % 4
        padded.append(String(repeating: "=", count: pad))
        return Data(base64Encoded: padded)
    }
}
