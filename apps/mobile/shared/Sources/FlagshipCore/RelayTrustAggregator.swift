import Foundation
import FlagshipAPI

/// One DISTINCT faulty relay authority, aggregated across ALL of a user's pods
/// — the unit of the per-cert relay-trust sliver (maintainer-trust Layer 3).
/// The unit is the FAULTY CERTIFICATE (cert-hash), NOT the box: one sliver line
/// + one biometric override per `failingCertHash`, spanning every affected
/// server. One owner exception for the cert-hash is fanned out by `.com` and
/// satisfies all of them at once.
public struct RelayCertFailure: Identifiable, Equatable, Sendable {
    /// relay-class cert-hash of the failing hub key (64-hex).
    public let certHash: String
    /// The affected server domains (sorted, deduped) — "which/how-many servers".
    public let servers: [String]
    /// Standing "operating under admin override" marker, driven from the
    /// RELAYED wire field `coveringExceptionCertHash` — a covered box keeps
    /// reporting `untrusted` for the cert but names it as covered. Persists
    /// until a fresh valid blessing clears the box's verdict.
    public let overridden: Bool

    public init(certHash: String, servers: [String], overridden: Bool) {
        self.certHash = certHash
        self.servers = servers
        self.overridden = overridden
    }

    public var id: String { "relay:\(certHash)" }
    public var serverCount: Int { servers.count }
    /// First 8 hex — the sliver slug (shared cross-surface contract).
    public var slug: String { String(certHash.prefix(8)) }
    /// The sliver line label (matches the control/relay contract).
    public var label: String { "Relay certificate expired · \(slug)" }
    /// The failing cert as a `TrustException`-signable descriptor (certClass
    /// `.relay`; `caPubkey` is unused for relay — the cert-hash IS the anchor).
    public var trustFailure: TrustFailure {
        TrustFailure(certClass: .relay, certHash: certHash, caPubkey: "")
    }
}

/// Verifies each box's STK-signed relay-trust verdict and aggregates the
/// untrusted ones by `failingCertHash` across a `/pods` list. A box's trust
/// claim is AUTHENTICATED (verified under `identityPubKey`), never trusted
/// blindly — a relayed report whose signature does not verify is DROPPED, so a
/// rogue `.com` can drop but not forge a verdict. Pure aside from the crypto
/// verify (no I/O), so it is unit-testable in the shared package.
public enum RelayTrustAggregator {
    /// Aggregate directly from the `/pods` wire entries. `identityPubKey` is the
    /// box's registered STK (hex); a garbled key / signature simply drops that
    /// pod's verdict.
    public static func aggregate(pods: [PodDirectoryEntry]) -> [RelayCertFailure] {
        // certHash → (servers, overridden)
        var servers: [String: [String]] = [:]
        var order: [String] = []
        var overridden: [String: Bool] = [:]

        for pod in pods {
            guard let ts = pod.trustStatus else { continue }
            guard let stk = HexUtil.decode(pod.identityPubKey), stk.count == 32 else { continue }
            guard BoxTrustStatus.verify(ts.report, signatureHex: ts.signatureHex, stkPub: stk) else {
                continue // unauthenticated verdict — drop
            }
            let report = ts.report
            guard report.relayVerdict == .untrusted,
                  let certHash = report.failingCertHash,
                  isHex64(certHash)
            else { continue }

            if servers[certHash] == nil {
                servers[certHash] = []
                order.append(certHash)
            }
            let domain = report.serverDomain.isEmpty ? pod.serverDomain : report.serverDomain
            if !domain.isEmpty, !(servers[certHash]?.contains(domain) ?? false) {
                servers[certHash]?.append(domain)
            }
            // Wire-driven standing override marker.
            if report.coveringExceptionCertHash == certHash {
                overridden[certHash] = true
            } else if overridden[certHash] == nil {
                overridden[certHash] = false
            }
        }

        return order
            .sorted()
            .map { certHash in
                RelayCertFailure(
                    certHash: certHash,
                    servers: (servers[certHash] ?? []).sorted(),
                    overridden: overridden[certHash] ?? false
                )
            }
    }

    private static func isHex64(_ s: String) -> Bool {
        guard s.count == 64 else { return false }
        return s.allSatisfy { $0.isHexDigit }
    }
}
