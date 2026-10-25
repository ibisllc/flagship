import Foundation

/// The owner's order to move one box between its container stacks: `arch-v2` (Podman, and the Rust
/// keyd, broker and core) or back to `classic` (Docker and the TS path). Signed with the
/// sensitive-order key (the admin root where the box pins one), sent to the box, used once. Wire
/// parity with packages/protocol/src/archV2Switch.ts; pinned by
/// packages/protocol/test-vectors/arch-v2-switch/vectors.json.
///
///   flagship/arch-v2-switch/v1|<serverDomain lowercase>|<target>|<nonce>|<issuedAt>
public struct StackSwitchOrder: Equatable, Sendable {
    public static let tag = "flagship/arch-v2-switch/v1"

    public struct Invalid: Error, Equatable { public let reason: String }

    public let serverDomain: String
    /// `arch-v2` or `classic`.
    public let target: String
    /// 32 lowercase hex.
    public let nonce: String
    public let issuedAt: Int64

    public init(serverDomain: String, target: String, nonce: String, issuedAt: Int64) {
        self.serverDomain = serverDomain; self.target = target; self.nonce = nonce; self.issuedAt = issuedAt
    }

    public static func newNonce() -> String {
        (0..<16).map { _ in String(format: "%02x", UInt8.random(in: 0...255)) }.joined()
    }

    public func canonicalBytes() throws -> Data {
        guard !serverDomain.unicodeScalars.contains(where: { $0.value == 0x7c || $0.value <= 0x1f || $0.value == 0x7f }) else {
            throw Invalid(reason: "serverDomain")
        }
        guard target == "arch-v2" || target == "classic" else { throw Invalid(reason: "target") }
        guard nonce.utf8.count == 32, nonce.unicodeScalars.allSatisfy({ ("0"..."9").contains($0) || ("a"..."f").contains($0) }) else {
            throw Invalid(reason: "nonce")
        }
        guard issuedAt >= 0, issuedAt <= (1 << 53) - 1 else { throw Invalid(reason: "issuedAt") }
        return Data([Self.tag, serverDomain.lowercased(), target, nonce, String(issuedAt)].joined(separator: "|").utf8)
    }

    /// `POST /api/stack/switch` `{order, signature, dryRun?}`.
    public func body(signatureHex: String, dryRun: Bool) -> [String: Any] {
        var b: [String: Any] = [
            "order": ["serverDomain": serverDomain, "target": target, "nonce": nonce, "issuedAt": issuedAt],
            "signature": signatureHex,
        ]
        if dryRun { b["dryRun"] = true }
        return b
    }
}
