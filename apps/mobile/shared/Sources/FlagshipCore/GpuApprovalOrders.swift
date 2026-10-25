import Foundation
import FlagshipAPI

/// The owner's GPU approval for one app installation on one box, which flagship-gpud verifies
/// itself, and its withdrawal. Signed with the sensitive-order key (the admin root, else the IRK on
/// an account without one). Wire parity with packages/protocol/src/gpuApproval.ts; pinned by
/// packages/protocol/test-vectors/gpu-approval/vectors.json.
///
///   flagship/gpu-approval/v1|<server>|<appId>|<installationId>|<generation>|<backend>|<maxCount>
///     |<caps sorted, comma-joined>|<policies sorted, comma-joined>|<isolation>|<secrecy 1|0>
///     |<trustDomain or empty>|<ownerConsent or empty>|<issuedAt>
///   flagship/gpu-approval-withdraw/v1|<server>|<appId>|<installationId>|<generation>|<issuedAt>
public enum GpuApprovalOrder {
    public static let tag = "flagship/gpu-approval/v1"
    public static let withdrawTag = "flagship/gpu-approval-withdraw/v1"

    public static let backends = ["nvidia-cuda", "amd-rocm", "intel-level-zero"]
    public static let capabilities = ["compute", "graphics", "video-encode", "video-decode"]
    public static let policies = ["exclusive", "partition", "cooperative"]
    public static let isolations = ["gvisor-nvproxy", "vm-passthrough"]
    static let maxGang = 16

    public struct Invalid: Error, Equatable { public let reason: String }

    static func serverOk(_ s: String) -> Bool {
        (1...253).contains(s.utf8.count) && s.unicodeScalars.allSatisfy { ("a"..."z").contains($0) || ("0"..."9").contains($0) || $0 == "." || $0 == "-" }
    }

    static func fieldOk(_ s: String) -> Bool {
        (1...128).contains(s.utf8.count) && s.unicodeScalars.allSatisfy {
            ("a"..."z").contains($0) || ("A"..."Z").contains($0) || ("0"..."9").contains($0) || $0 == "." || $0 == "_" || $0 == ":" || $0 == "-"
        }
    }

    static func sortedSet(_ items: [String], _ allowed: [String], _ what: String) throws -> String {
        guard !items.isEmpty else { throw Invalid(reason: "no \(what)") }
        for i in items where !allowed.contains(i) { throw Invalid(reason: "unknown \(what)") }
        return Array(Set(items)).sorted { Array($0.utf8).lexicographicallyPrecedes(Array($1.utf8)) }.joined(separator: ",")
    }

    static func ids(_ server: String, _ appId: String, _ installationId: String, _ generation: Int64, _ issuedAt: Int64) throws {
        guard serverOk(server) else { throw Invalid(reason: "serverDomain") }
        guard fieldOk(appId), fieldOk(installationId) else { throw Invalid(reason: "app installation") }
        guard generation >= 0 else { throw Invalid(reason: "generation") }
        guard issuedAt >= 0 else { throw Invalid(reason: "issuedAt") }
    }

    /// The bytes the owner signs to approve `r` on `server` (the box the device is talking to).
    public static func canonical(server: String, _ r: GpuApprovalRequest, issuedAt: Int64) throws -> Data {
        try ids(server, r.appId, r.installationId, r.generation, issuedAt)
        guard (1...maxGang).contains(r.maxCount) else { throw Invalid(reason: "maxCount") }
        guard backends.contains(r.backend) else { throw Invalid(reason: "backend") }
        guard isolations.contains(r.isolation) else { throw Invalid(reason: "isolation") }
        func opt(_ v: String?, _ what: String) throws -> String {
            guard let v else { return "" }
            guard fieldOk(v) else { throw Invalid(reason: what) }
            return v
        }
        let parts = [
            tag, server, r.appId, r.installationId, String(r.generation), r.backend, String(r.maxCount),
            try sortedSet(r.caps, capabilities, "capability"), try sortedSet(r.policies, policies, "policy"),
            r.isolation, r.secrecy ? "1" : "0", try opt(r.trustDomain, "trust domain"), try opt(r.ownerConsent, "consent"), String(issuedAt),
        ]
        return Data(parts.joined(separator: "|").utf8)
    }

    public static func withdrawCanonical(server: String, appId: String, installationId: String, generation: Int64, issuedAt: Int64) throws -> Data {
        try ids(server, appId, installationId, generation, issuedAt)
        return Data([withdrawTag, server, appId, installationId, String(generation), String(issuedAt)].joined(separator: "|").utf8)
    }

    /// The terms the owner signs for a listed request. The box lists a request with no trust domain or
    /// consent; sharing a GPU between apps (cooperative) needs both, so the owner's approval names the
    /// account's own apps as the trust domain and records this approval as the consent.
    public static func ownerTerms(_ r: GpuApprovalRequest, issuedAt: Int64) -> GpuApprovalRequest {
        guard r.policies.contains("cooperative") else { return r }
        return GpuApprovalRequest(server: r.server, appId: r.appId, installationId: r.installationId, generation: r.generation,
                                  backend: r.backend, maxCount: r.maxCount, caps: r.caps, policies: r.policies, isolation: r.isolation,
                                  secrecy: r.secrecy, trustDomain: r.trustDomain ?? cooperativeTrustDomain,
                                  ownerConsent: r.ownerConsent ?? "owner-consent-\(issuedAt)", issuedAt: r.issuedAt)
    }

    /// The trust domain an owner's approval of cooperative sharing names: the account's own apps.
    public static let cooperativeTrustDomain = "owner-apps"

    /// `POST /api/screens/accelerators/approvals`: the terms as the box listed them, plus `issuedAt` and the signature.
    public static func body(server: String, _ r: GpuApprovalRequest, issuedAt: Int64, signatureHex: String) -> [String: Any] {
        [
            "server": server, "appId": r.appId, "installationId": r.installationId, "generation": r.generation,
            "backend": r.backend, "maxCount": r.maxCount, "caps": r.caps, "policies": r.policies, "isolation": r.isolation,
            "secrecy": r.secrecy, "trustDomain": r.trustDomain.map { $0 as Any } ?? NSNull(),
            "ownerConsent": r.ownerConsent.map { $0 as Any } ?? NSNull(), "issuedAt": issuedAt, "signature": signatureHex,
        ]
    }

    /// `POST /api/screens/accelerators/approvals/withdraw`.
    public static func withdrawBody(_ r: GpuApprovalRequest, issuedAt: Int64, signatureHex: String) -> [String: Any] {
        ["appId": r.appId, "installationId": r.installationId, "generation": r.generation, "issuedAt": issuedAt, "signature": signatureHex]
    }

    /// The request the box's body describes (the mock box and tests read bodies back).
    public static func request(fromBody o: [String: Any]) -> GpuApprovalRequest? {
        func i64(_ v: Any?) -> Int64? { (v as? NSNumber)?.int64Value }
        guard let server = o["server"] as? String, let appId = o["appId"] as? String, let inst = o["installationId"] as? String,
              let gen = i64(o["generation"]), let backend = o["backend"] as? String, let n = i64(o["maxCount"]),
              let caps = o["caps"] as? [String], let pol = o["policies"] as? [String], let iso = o["isolation"] as? String,
              let secrecy = o["secrecy"] as? Bool else { return nil }
        return GpuApprovalRequest(server: server, appId: appId, installationId: inst, generation: gen, backend: backend, maxCount: Int(n),
                                  caps: caps, policies: pol, isolation: iso, secrecy: secrecy,
                                  trustDomain: o["trustDomain"] as? String, ownerConsent: o["ownerConsent"] as? String)
    }
}
