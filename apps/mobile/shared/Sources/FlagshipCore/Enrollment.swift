import CryptoKit
import Foundation

/// First contact between a new server and the device that created it. Wire parity with
/// packages/protocol/src/enrollment.ts; pinned by packages/protocol/test-vectors/enrollment/vectors.json.
///
/// - The recipe carries a one-time 32-byte `enrollmentKeyHex` this device keeps; the box's first
///   request carries `deviceInfo.enrollmentProof` = HMAC-SHA256(secret,
///   `flagship/enrollment-proof/v1|<serverDomain lowercase>|<stkPubHex>|<authCodeSerial>`).
///   A proof that fails means the key was not built from this device's recipe: refuse to pin it.
/// - The server code: first 4 bytes of SHA-256(`flagship/server-code/v1|<stkPubHex>`), big-endian,
///   mod 1,000,000, six digits. The box shows it on its own screen.
public enum Enrollment {
    public static let proofTag = "flagship/enrollment-proof/v1"
    public static let codeTag = "flagship/server-code/v1"

    /// A fresh one-time secret for a new recipe.
    public static func newSecret() -> Data {
        var b = [UInt8](repeating: 0, count: 32)
        _ = SecRandomCopyBytes(kSecRandomDefault, b.count, &b)
        return Data(b)
    }

    private static func isHex64(_ s: String) -> Bool {
        s.count == 64 && s.allSatisfy { "0123456789abcdef".contains($0) }
    }

    public static func proofHex(secret: Data, serverDomain: String, stkPubHex: String, authCodeSerial: String) -> String? {
        guard secret.count == 32, isHex64(stkPubHex), !serverDomain.contains("|"), !authCodeSerial.contains("|") else { return nil }
        let msg = Data([proofTag, serverDomain.lowercased(), stkPubHex, authCodeSerial].joined(separator: "|").utf8)
        let mac = HMAC<SHA256>.authenticationCode(for: msg, using: SymmetricKey(data: secret))
        return Data(mac).map { String(format: "%02x", $0) }.joined()
    }

    /// Constant-time check of the box's proof.
    public static func verify(secret: Data, serverDomain: String, stkPubHex: String, authCodeSerial: String, proofHex: String) -> Bool {
        guard let want = Self.proofHex(secret: secret, serverDomain: serverDomain, stkPubHex: stkPubHex, authCodeSerial: authCodeSerial) else { return false }
        let a = Array(want.utf8)
        let b = Array(proofHex.lowercased().utf8)
        guard a.count == b.count else { return false }
        var diff: UInt8 = 0
        for i in 0..<a.count { diff |= a[i] ^ b[i] }
        return diff == 0
    }

    public static let seenTag = "flagship/server-code-seen/v1"

    /// Studio's report that the VM it hosts showed `stkPubHex`: HMAC-SHA256 under the per-server
    /// `studioConfirmKey` this device sent Studio beside the recipe (never inside it), over
    /// `flagship/server-code-seen/v1|<serverDomain lowercase>|<stkPubHex>`. Read from order status `serverSeen`.
    public static func serverSeenMacHex(studioConfirmKey: Data, serverDomain: String, stkPubHex: String) -> String? {
        guard studioConfirmKey.count == 32, isHex64(stkPubHex), !serverDomain.contains("|") else { return nil }
        let msg = Data("\(seenTag)|\(serverDomain.lowercased())|\(stkPubHex)".utf8)
        return Data(HMAC<SHA256>.authenticationCode(for: msg, using: SymmetricKey(data: studioConfirmKey))).map { String(format: "%02x", $0) }.joined()
    }

    public static func verifyServerSeen(studioConfirmKey: Data, serverDomain: String, stkPubHex: String, macHex: String) -> Bool {
        guard let want = serverSeenMacHex(studioConfirmKey: studioConfirmKey, serverDomain: serverDomain, stkPubHex: stkPubHex) else { return false }
        let a = Array(want.utf8), b = Array(macHex.lowercased().utf8)
        guard a.count == b.count else { return false }
        var diff: UInt8 = 0
        for i in 0..<a.count { diff |= a[i] ^ b[i] }
        return diff == 0
    }

    public static func serverCode(stkPubHex: String) -> String? {
        guard isHex64(stkPubHex) else { return nil }
        let d = Array(SHA256.hash(data: Data("\(codeTag)|\(stkPubHex)".utf8)))
        let n = (UInt32(d[0]) << 24) | (UInt32(d[1]) << 16) | (UInt32(d[2]) << 8) | UInt32(d[3])
        return String(format: "%06u", n % 1_000_000)
    }
}
