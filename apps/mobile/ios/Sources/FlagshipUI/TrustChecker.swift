import Foundation
import FlagshipCore
import FlagshipAPI

/// Fetches `GET /api/maintainer-blessing` from `.com` and feeds the verdict to
/// the `TrustCenter`. The whole point of the feature: the client runs the full
/// `BAKED_PIN → verifyMandateChainFromPin → authorizedCaKeys(now)` check ITSELF
/// (over the served chain), at the CALLER's clock, and requires the served CA
/// pubkey to be authorized live now.
///
/// Failure-class discipline (the sequencing constraint that must not be
/// violated): a NETWORK error is NO verdict — we never brick on the absence of
/// a verdict, only on a valid response that fails verification.
public struct TrustChecker: Sendable {
    private let urlSession: URLSession
    private let baseUrl: URL

    public init(
        urlSession: URLSession = .shared,
        baseUrl: URL = Endpoints.controlBaseUrl
    ) {
        self.urlSession = urlSession
        self.baseUrl = baseUrl
    }

    // MARK: - JSON shapes (the `/api/maintainer-blessing` payload)

    private struct SigJSON: Decodable { let pubkey: String; let sig: String }
    private struct ApprovalJSON: Decodable { let kind: String; let threshold: Int }
    private struct ProjectJSON: Decodable {
        let name: String?; let contact: String?; let homepage: String?; let tracks: [String]?
    }
    private struct MandateJSON: Decodable {
        let kind: String; let version: Int; let mandateId: String; let track: String
        let holder: String; let issuedAt: String; let expiresAt: String
        let successors: [String]; let approvalRule: ApprovalJSON
        let minSuccessors: Int; let maxDurationSeconds: Int; let defaultDurationSeconds: Int
        let project: ProjectJSON?; let signedBy: String; let signatures: [SigJSON]
    }
    private struct CaEndorsementJSON: Decodable {
        let kind: String; let version: Int; let endorsementId: String; let track: String
        let caPubkey: String; let scope: String; let notBefore: String; let notAfter: String
        let issuedAt: String; let signedBy: String; let signatures: [SigJSON]
    }
    private struct BlessingJSON: Decodable {
        let version: Int
        let pinnedMandateHash: String
        let caPubkey: String
        let mandates: [MandateJSON]
        let caEndorsements: [CaEndorsementJSON]
    }

    private func toMandate(_ j: MandateJSON) -> Mandate {
        Mandate(
            kind: j.kind, version: j.version, mandateId: j.mandateId, track: j.track,
            holder: j.holder, issuedAt: j.issuedAt, expiresAt: j.expiresAt,
            successors: j.successors,
            approvalRule: MaintainersApprovalRule(kind: j.approvalRule.kind, threshold: j.approvalRule.threshold),
            minSuccessors: j.minSuccessors, maxDurationSeconds: j.maxDurationSeconds,
            defaultDurationSeconds: j.defaultDurationSeconds,
            project: j.project.map {
                MaintainersProject(name: $0.name, contact: $0.contact, homepage: $0.homepage, tracks: $0.tracks)
            },
            signedBy: j.signedBy,
            signatures: j.signatures.map { MaintainersSignature(pubkey: $0.pubkey, sig: $0.sig) }
        )
    }

    private func toEndorsement(_ j: CaEndorsementJSON) -> CaEndorsement {
        CaEndorsement(
            kind: j.kind, version: j.version, endorsementId: j.endorsementId, track: j.track,
            caPubkey: j.caPubkey, scope: j.scope, notBefore: j.notBefore, notAfter: j.notAfter,
            issuedAt: j.issuedAt, signedBy: j.signedBy,
            signatures: j.signatures.map { MaintainersSignature(pubkey: $0.pubkey, sig: $0.sig) }
        )
    }

    /// Fetch + verify. Returns:
    ///   - `.trusted` / `.untrusted` on a VALID response (a verdict);
    ///   - `nil` on a network/parse failure (NO verdict — caller leaves the
    ///     center's verdict untouched).
    /// On `.untrusted`, the failing control-server cert (slugged by its
    /// cert-hash) is included so the sliver can render it.
    public enum Outcome: Sendable {
        case trusted
        case untrusted(TrustFailure)
        case noVerdict
    }

    public func check(now: Date = Date()) async -> Outcome {
        let blessing: MaintainerBlessing
        do {
            var req = URLRequest(url: baseUrl.appendingPathComponent("/api/maintainer-blessing"))
            req.httpMethod = "GET"
            let (data, resp) = try await urlSession.data(for: req)
            guard let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
                return .noVerdict // not a clean response → no verdict
            }
            let j = try JSONDecoder().decode(BlessingJSON.self, from: data)
            blessing = MaintainerBlessing(
                pinnedMandateHash: j.pinnedMandateHash,
                caPubkey: j.caPubkey,
                mandates: j.mandates.map(toMandate),
                caEndorsements: j.caEndorsements.map(toEndorsement)
            )
        } catch {
            return .noVerdict
        }

        if MaintainersTrust.verifyComBlessing(blessing, now: now) {
            return .trusted
        }
        let failure = TrustFailure(
            certClass: .control,
            certHash: TrustException.certHash(forCaPubkey: blessing.caPubkey),
            caPubkey: blessing.caPubkey
        )
        return .untrusted(failure)
    }
}
