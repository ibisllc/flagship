import Foundation
import FlagshipAPI

/// Quantum-safe stage 1 (docs/architecture-v2/pq-suites.md §20): the hybrid companions of
/// admin-root rotations and device capability grants. Swift twin of
/// `packages/protocol/src/pqAuthorityRecords.ts`; every port reads
/// `packages/protocol/test-vectors/pq-authority/vectors.json`.
public enum PqAuthorityRecords {
    public static let tagRotationV2 = "flagship/admin-root-rotation/v2"
    public static let tagDeviceGrant = DeviceCapabilityGrantEnvelope.canonicalTag
    static let hybridSuite = SignatureSuite.hybrid.rawValue

    /// What travels beside a v1 rotation: the old root's hybrid signature and the new root's binding.
    public struct RotationCompanion: Codable, Equatable, Sendable {
        public var signature: SignatureEnvelope
        public var newRootBinding: PqKeyBindingWire
        public init(signature: SignatureEnvelope, newRootBinding: PqKeyBindingWire) {
            self.signature = signature; self.newRootBinding = newRootBinding
        }
        public var wire: AdminRootRotationPqWire {
            let b = newRootBinding
            return AdminRootRotationPqWire(
                signature: PqSignatureWire(suite: signature.suite, signature: signature.signature),
                newRootBinding: PqBindingWireJSON(v: b.v, role: b.role, subjectId: b.subjectId, ed25519PubHex: b.ed25519PubHex,
                                                  mldsaPubHex: b.mldsaPubHex, issuedAt: b.issuedAt, signature: b.signature))
        }
        public var jsonObject: [String: Any] {
            ["signature": ["suite": signature.suite, "signature": signature.signature], "newRootBinding": newRootBinding.jsonObject]
        }
    }

    /// The hybrid key id of a binding's two keys (no signature check).
    public static func bindingKeyIdHex(ed25519PubHex: String, mldsaPubHex: String) -> String {
        PqBin.hex(PqHybrid.pqKeyId(suite: PqHybrid.suiteHybridSigEd25519MlDsa65V1,
                                   publicKey: PqTrust.pqBindingPublicKey(ed25519PubHex: ed25519PubHex, mldsaPubHex: mldsaPubHex)))
    }

    /// `flagship/admin-root-rotation/v2|<username>|<oldRootHex>|<newRootHex>|<issuedAt>|<newRootKeyIdHex>`.
    public static func canonicalRotationV2(_ r: AdminRootRotation, newRootKeyIdHex: String) throws -> [UInt8] {
        guard !r.username.utf8.contains(where: { $0 == 0x7c || $0 <= 0x1f || $0 == 0x7f }),
              newRootKeyIdHex.utf8.count == 64, PqBin.isLowerHex(newRootKeyIdHex),
              r.issuedAt >= 0, r.issuedAt <= PqTrust.maxSafeInteger
        else { throw PqTrustError("binding-malformed") }
        return Array([tagRotationV2, r.username, r.oldAdminRootPubHex.lowercased(), r.newAdminRootPubHex.lowercased(),
                      String(r.issuedAt), newRootKeyIdHex].joined(separator: "|").utf8)
    }

    /// The companion: `oldRootSign` is the old root's hybrid signer (purpose, payload) → signature.
    public static func signRotation(_ r: AdminRootRotation, newRootBinding: PqKeyBindingWire,
                                    oldRootSign: (_ purpose: String, _ payload: [UInt8]) throws -> [UInt8]) throws -> RotationCompanion {
        let msg = try canonicalRotationV2(r, newRootKeyIdHex: bindingKeyIdHex(ed25519PubHex: newRootBinding.ed25519PubHex,
                                                                             mldsaPubHex: newRootBinding.mldsaPubHex))
        let sig = try oldRootSign(tagRotationV2, msg)
        return RotationCompanion(signature: SignatureEnvelope(suite: hybridSuite, signature: PqBin.hex(sig)), newRootBinding: newRootBinding)
    }

    /// A grant's companion: the signing root's hybrid signature over the grant's own bytes.
    public static func signGrant(_ g: DeviceCapabilityGrantEnvelope,
                                 rootSign: (_ purpose: String, _ payload: [UInt8]) throws -> [UInt8]) throws -> SignatureEnvelope {
        SignatureEnvelope(suite: hybridSuite, signature: PqBin.hex(try rootSign(tagDeviceGrant, Array(g.canonicalBytes()))))
    }

    private static func envelope(_ raw: Any?) throws -> SignatureEnvelope {
        guard let o = raw as? [String: Any], let suite = o["suite"] as? String, let sig = o["signature"] as? String
        else { throw PqTrustError("bad-signature") }
        if suite != hybridSuite { throw PqTrustError(suite == SignatureSuite.ed25519.rawValue ? "strict-requires-hybrid" : "unknown-suite") }
        return SignatureEnvelope(suite: suite, signature: sig)
    }

    /// Verifies a rotation's companion (`pq` as JSON) and returns the new root's verified binding.
    /// `oldRootBinding` is the verifier's own pin for the old root.
    public static func verifyRotation(_ r: AdminRootRotation, pq: Any?, oldRootBinding: VerifiedPqKeyBinding?,
                                      policy: PolicyState, now: Int64) throws -> VerifiedPqKeyBinding {
        guard let o = pq as? [String: Any] else { throw PqTrustError("strict-requires-hybrid") }
        let env = try envelope(o["signature"])
        let wire = try PqTrust.pqKeyBindingFromWire(o["newRootBinding"])
        let newBinding = try PqTrust.verifyPqKeyBinding(wire, PqBindingExpectation(
            role: PqBindingRole.adminRoot.rawValue, subjectId: r.username.lowercased(),
            ed25519PubHex: r.newAdminRootPubHex.lowercased(), now: now))
        _ = try PqTrust.verifyCriticalSignature(
            message: try canonicalRotationV2(r, newRootKeyIdHex: newBinding.keyIdHex), expectedPurpose: tagRotationV2,
            envelope: env, signerEd25519PubHex: r.oldAdminRootPubHex, binding: oldRootBinding, policy: policy)
        return newBinding
    }

    /// Verifies a grant's companion under the binding of the root its classical signature verified under.
    public static func verifyGrant(_ g: DeviceCapabilityGrantEnvelope, pq: Any?, signerPubHex: String,
                                   signerBinding: VerifiedPqKeyBinding?, policy: PolicyState) throws {
        let env = try envelope(pq)
        _ = try PqTrust.verifyCriticalSignature(message: Array(g.canonicalBytes()), expectedPurpose: tagDeviceGrant, envelope: env,
                                                signerEd25519PubHex: signerPubHex, binding: signerBinding, policy: policy)
    }
}
