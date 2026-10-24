import Foundation
import CryptoKit

/// Port of packages/protocol/src/strictReentry.ts: the evidence an admin device signs into a
/// change back to strict after a compatibility period. Each digest commits to what this device
/// checked itself, in the fixed text form every client builds the same way
/// (packages/protocol/test-vectors/strict-reentry). The rekey receipt covers the server's PQ key
/// and a fresh nonce only; data at rest is not re-encrypted by it.
public enum StrictReentry {
    public static let tag = "flagship/strict-reentry/v1"

    public struct Binding: Equatable, Sendable {
        public var role: String
        public var subjectId: String
        public var ed25519PubHex: String
        public var mldsaPubHex: String
        public init(role: String, subjectId: String, ed25519PubHex: String, mldsaPubHex: String) {
            self.role = role; self.subjectId = subjectId; self.ed25519PubHex = ed25519PubHex; self.mldsaPubHex = mldsaPubHex
        }
        public init(_ v: VerifiedPqKeyBinding) {
            self.init(role: v.role, subjectId: v.subjectId, ed25519PubHex: v.ed25519PubHex, mldsaPubHex: v.mldsaPubHex)
        }
    }

    public struct Inputs: Equatable, Sendable {
        public var account: String
        public var scope: PolicyScope
        public var leftStrictAt: Int64
        public var devices: [Binding]
        public var deviceCount: Int
        public var adminRoot: Binding?
        public var server: Binding
        public var recoveryChecked: Bool
        public var recoveryCheckedAt: Int64?
        public var nonceHex: String
        public var checkedAt: Int64
        public init(account: String, scope: PolicyScope, leftStrictAt: Int64, devices: [Binding], deviceCount: Int, adminRoot: Binding?,
                    server: Binding, recoveryChecked: Bool, recoveryCheckedAt: Int64?, nonceHex: String, checkedAt: Int64) {
            self.account = account; self.scope = scope; self.leftStrictAt = leftStrictAt; self.devices = devices
            self.deviceCount = deviceCount; self.adminRoot = adminRoot; self.server = server; self.recoveryChecked = recoveryChecked
            self.recoveryCheckedAt = recoveryCheckedAt; self.nonceHex = nonceHex; self.checkedAt = checkedAt
        }
    }

    public struct Refusal: Error, Equatable {
        public let code: String
        public let sentence: String
    }

    private static func token(_ s: String) -> Bool {
        !s.isEmpty && s.count <= 256 && s.unicodeScalars.allSatisfy { c in
            (c >= "A" && c <= "Z") || (c >= "a" && c <= "z") || (c >= "0" && c <= "9") || "._:@-".unicodeScalars.contains(c)
        }
    }

    private static func lowerHex(_ s: String) -> Bool {
        !s.isEmpty && s.unicodeScalars.allSatisfy { ($0 >= "0" && $0 <= "9") || ($0 >= "a" && $0 <= "f") }
    }

    private static func line(_ b: Binding) throws -> String {
        guard token(b.role), token(b.subjectId) else { throw Refusal(code: "bad-input", sentence: "strict-reentry: bad binding field") }
        guard lowerHex(b.ed25519PubHex), lowerHex(b.mldsaPubHex) else { throw Refusal(code: "bad-input", sentence: "strict-reentry: binding keys must be lowercase hex") }
        return "\(b.role):\(b.subjectId):\(b.ed25519PubHex):\(b.mldsaPubHex)"
    }

    /// The four canonical texts, in order (verifier checks, enrollment, rekey, recovery).
    public static func texts(_ i: Inputs) throws -> [String] {
        guard token(i.account), token(i.scope.id), token(i.scope.kind.rawValue) else {
            throw Refusal(code: "bad-input", sentence: "strict-reentry: bad account or scope")
        }
        guard i.nonceHex.count == 64, lowerHex(i.nonceHex) else { throw Refusal(code: "bad-input", sentence: "strict-reentry: the nonce must be 32 bytes of hex") }
        guard i.leftStrictAt >= 0, i.checkedAt >= 0, i.deviceCount >= 0 else { throw Refusal(code: "bad-input", sentence: "strict-reentry: bad number") }
        guard i.devices.count == i.deviceCount, i.deviceCount > 0 else {
            throw Refusal(code: "devices-not-enrolled", sentence: "Every device on the account needs its post-quantum key before strict comes back.")
        }
        guard i.recoveryChecked, let recAt = i.recoveryCheckedAt else {
            throw Refusal(code: "recovery-not-checked", sentence: "Test your recovery before turning strict on again.")
        }
        let head = "\(tag)|\(i.account)|\(i.scope.kind.rawValue)|\(i.scope.id)|\(i.leftStrictAt)"
        let devices = try i.devices.map(line).sorted()
        var all = devices
        if let a = i.adminRoot { all.append(try line(a)) }
        let server = try line(i.server)
        all.append(server)
        all.sort()
        return [
            "\(head)|verifier-checks|\(all.joined(separator: ","))|\(i.checkedAt)",
            "\(head)|enrollment|\(i.deviceCount)|\(devices.joined(separator: ","))",
            "\(head)|rekey|\(server)|\(i.nonceHex)|\(i.checkedAt)",
            "\(head)|recovery|checked|\(recAt)",
        ]
    }

    public static func evidence(_ i: Inputs) throws -> StrictReentryEvidence {
        let d = try texts(i).map { t in SHA256.hash(data: Data(t.utf8)).map { String(format: "%02x", $0) }.joined() }
        return StrictReentryEvidence(verifierChecksDigest: d[0], enrollmentDigest: d[1], rekeyReceiptDigest: d[2], recoveryTestDigest: d[3])
    }

    /// 32 fresh random bytes, hex.
    public static func freshNonce() -> String {
        var g = SystemRandomNumberGenerator()
        return (0..<32).map { _ in String(format: "%02x", UInt8.random(in: 0...255, using: &g)) }.joined()
    }
}
