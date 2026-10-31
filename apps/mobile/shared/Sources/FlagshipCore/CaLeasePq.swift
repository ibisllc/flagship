import CryptoKit
import Foundation

/// The PQ half of a CA endorsement lease (packages/protocol/src/caLeasePq.ts, pq-suites.md §16.3),
/// checked on the phone where a lease makes `.com`'s CA key trusted. Empty pin: every lease counts
/// as before. Once `CaLeasePqPin.keyIds` names a key, a lease counts only with its verified hybrid
/// companion (under a `release-key` binding, subject `flagship-ca-track`, whose key id is pinned),
/// unless its v1 digest is in `legacyLeases`. Vectors: test-vectors/ca-lease-pq/vectors.json.
public enum CaLeasePq {
    public static let tagCaLeaseV2 = "flagship/ca-lease/v2"
    public static let bindingSubject = "flagship-ca-track"

    public struct Pin: Equatable, Sendable {
        public let keyIds: [String]
        public let legacyLeases: [String]
        public init(keyIds: [String], legacyLeases: [String]) { self.keyIds = keyIds; self.legacyLeases = legacyLeases }
    }

    /// Mirrors `CA_LEASE_PQ_PIN` in caLeasePq.ts (a test keeps them equal).
    public static let pin = Pin(
        keyIds: ["1c07f1ffe8e6e8b89d8b8c8c14544d6f065decfa67ea76ec50c30fadaadb9434"],
        legacyLeases: ["05992604e11f53b3ede67ac98c089faa8b45e23b6f543fdba1927a08df29f57f", "38d5ebb0d6ebf7742416076366ce3ef50c02273f91515224b2937c56e958c278", "6f11e97e0ce6fc6e77edf2aa2676c08fa2d73424803b5900cc22479194f4a363", "a1606216cf39cccc9d02e2d22d74874037da59f137bb065e55c9f6d9937f14a4"]
    )

    public static func v1Digest(_ e: CaEndorsement) -> String? {
        guard let bytes = try? MaintainersCanonical.canonicalCaEndorsement(e) else { return nil }
        return PqBin.hex(Array(SHA256.hash(data: bytes)))
    }

    /// The leases that may give authority (the classical checks still run on them after).
    public static func gate(_ leases: [CaEndorsement], bindings: [Any], endorsements: [Any], pin: Pin = pin, now: Int64) -> [CaEndorsement] {
        if pin.keyIds.isEmpty { return leases }
        let pinned = Set(pin.keyIds.map { $0.lowercased() })
        var verified: [String: VerifiedPqKeyBinding] = [:]
        for raw in bindings {
            guard let o = raw as? [String: Any], let ed = o["ed25519PubHex"] as? String,
                  let b = try? PqTrust.verifyPqKeyBinding(raw, PqBindingExpectation(role: "release-key", subjectId: bindingSubject, ed25519PubHex: ed, now: now)),
                  pinned.contains(b.keyIdHex) else { continue }
            verified[b.keyIdHex] = b
        }
        return leases.filter { e in
            guard let digest = v1Digest(e) else { return false }
            if pin.legacyLeases.contains(digest) { return true }
            return endorsements.contains { raw in
                guard let w = raw as? [String: Any], w["kind"] as? String == "CaEndorsementPq",
                      (w["version"] as? NSNumber)?.intValue == 2, w["endorsementId"] as? String == e.endorsementId,
                      w["v1Digest"] as? String == digest, w["suite"] as? String == "hybrid-ed25519-mldsa65/v1",
                      let keyId = w["keyId"] as? String, let sigHex = w["signature"] as? String, let sig = PqBin.unhex(sigHex),
                      let b = verified[keyId], b.ed25519PubHex == e.signedBy.lowercased()
                else { return false }
                let msg = PqBin.utf8([tagCaLeaseV2, e.endorsementId, digest, e.signedBy.lowercased(), keyId].joined(separator: "|"))
                return (try? PqHybrid.hybridVerify(publicKey: b.hybridPublicKey, purpose: tagCaLeaseV2, payload: msg, signature: sig)) != nil
            }
        }
    }
}
