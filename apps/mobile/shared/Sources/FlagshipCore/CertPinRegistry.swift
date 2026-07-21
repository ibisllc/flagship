import Foundation
import FlagshipAPI

/// Cert-fingerprint pin registry (cert-model A′, phase 4) — the phone-side
/// half of "the client pins the box's real cert fingerprint and rejects
/// anything else".
///
/// Populated from `/pods` responses: each pod may carry the box's STK-signed
/// daemon-status report relayed VERBATIM (`signedStatus`). A pin is recorded
/// for the box FQDN only when ALL of these hold:
///   - the STK pubkey derived LOCALLY from the phone's UMK
///     (`ServerKeys.deriveStkPub` — `.com`'s `identityPubKey` echo is NOT a
///     trust input) verifies the report signature,
///   - the report's `serverDomain` matches the pod's domain,
///   - the report is fresh (`issuedAt` within `DaemonStatus.maxReportAgeMs`),
///   - the report carries a well-formed `certSha256` (64 hex).
/// A first-time failure ⇒ NO pin for that box (default TLS validation stands)
/// and the list rendering is never affected. Once a box HAS a pin, though, a
/// later `/pods` that fails to re-verify it does NOT clear it — see
/// `update(pods:)` for the keep-last-known-good reconcile (SEC-1). With a pin,
/// enforcement is HARD-FAIL (locked decision): see `BoxCertPinningDelegate`
/// (FlagshipAPI).
///
/// A service host `x.<server>.<user>.flagship.services` pins to the box's
/// fingerprint — the per-box wildcard `*.<server>.<user>` is the same cert.
///
/// iOS twist vs Android: the UMK is biometric-gated on iOS, so the STK pub
/// (PUBLIC key material) is derived at moments the UMK is already unlocked
/// (server creation — `Keystore.deriveIRKAndBoxStkPub`) and CACHED here
/// persistently; the per-refresh `update(pods:)` then verifies with the
/// cached pubs and never prompts. A pod with no cached STK pub simply gets
/// no pin.
public final class CertPinRegistry: @unchecked Sendable {
    /// Process-wide registry consulted by the shared pinned URLSession.
    public static let shared = CertPinRegistry()

    private static let stkPubsDefaultsKey = "flagship.certpin.boxStkPubs.v1"
    private static let hex64 = try! NSRegularExpression(pattern: "^[0-9a-f]{64}$")

    private let lock = NSLock()
    /// box FQDN (lowercase) → leaf-cert DER SHA-256 (lowercase hex).
    private var pins: [String: String] = [:]
    /// Last STK-verified daemon-status report for each box. This is the same
    /// evidence that installed `pins`; retaining it lets detail UI show real
    /// certificate metadata without trusting an unsigned relay projection.
    private var reports: [String: DaemonStatusReport] = [:]
    /// box FQDN (lowercase) → locally derived STK pubkey (32 bytes).
    private var stkPubs: [String: Data] = [:]
    private let defaults: UserDefaults?

    /// `defaults == nil` ⇒ fully in-memory (tests / previews).
    public init(persistingIn defaults: UserDefaults? = .standard) {
        self.defaults = defaults
        if let stored = defaults?.dictionary(forKey: Self.stkPubsDefaultsKey) as? [String: String] {
            for (domain, hex) in stored {
                if let pub = HexUtil.decode(hex), pub.count == 32 {
                    stkPubs[domain] = pub
                }
            }
        }
    }

    // MARK: - STK-pub cache

    /// Record a box's locally derived STK pubkey (public material — safe to
    /// persist unprotected). Called where the UMK is already unlocked.
    public func registerBoxStk(domain: String, stkPub: Data) {
        guard stkPub.count == 32 else { return }
        let key = Self.normalize(domain)
        guard !key.isEmpty else { return }
        lock.lock()
        stkPubs[key] = stkPub
        let snapshot = stkPubs
        lock.unlock()
        persist(snapshot)
    }

    private func persist(_ snapshot: [String: Data]) {
        guard let defaults else { return }
        defaults.set(snapshot.mapValues { HexUtil.encode($0) }, forKey: Self.stkPubsDefaultsKey)
    }

    // MARK: - /pods reconciliation

    /// Reconcile the registry against a fresh `/pods` response using the
    /// CACHED STK pubs (no UMK access ⇒ no biometric). KEEP-LAST-KNOWN-GOOD
    /// (SEC-1): a pin is the phone's only defense against a `.com`-minted
    /// rogue cert, so it is dropped ONLY on an explicit signal, never on the
    /// mere ABSENCE of a fresh verified report. Three cases per the user's
    /// `/pods` directory (the full registered-server list):
    ///   1. pod ABSENT from the response entirely (released / decommissioned)
    ///      ⇒ the box is gone, so its pin is pruned (a stale pin can't strand
    ///      a hard-fail on a name the user no longer owns).
    ///   2. pod PRESENT + a NEW report VERIFIES ⇒ replace the pin (handles a
    ///      legitimate cert renewal — the new fingerprint supersedes).
    ///   3. pod PRESENT but the report is missing / stale / fails verification
    ///      (incl. a relay that DROPPED `signedStatus`, or a MITM on the
    ///      `.com` path that tampered it) ⇒ RETAIN the existing pin. A
    ///      transiently-unverifiable still-listed box must NOT silently
    ///      downgrade to default TLS validation, which a CA-valid rogue cert
    ///      (exactly what the pin defends against) would pass.
    ///
    /// A revoked pod (`revokedAt != nil`) is an EXPLICIT owner/server signal
    /// that the box's identity is retired — that pin is dropped (case 1-like).
    /// Never throws — a malformed entry simply yields no fresh pin (case 3).
    public func update(
        pods: [PodDirectoryEntry],
        nowMs: Int64 = Int64(Date().timeIntervalSince1970 * 1000)
    ) {
        // Domains still present and not explicitly retired — the survivors of
        // the absent-prune. A revoked pod is treated as absent (its identity
        // is retired), so it is NOT a survivor and its pin is pruned.
        var listed = Set<String>()
        for pod in pods {
            let domain = Self.normalize(pod.serverDomain)
            guard !domain.isEmpty else { continue }
            if pod.revokedAt == nil { listed.insert(domain) }
        }

        lock.lock()
        // Case 1 — prune pins for domains the directory no longer vouches for.
        for domain in pins.keys where !listed.contains(domain) {
            pins.removeValue(forKey: domain)
            reports.removeValue(forKey: domain)
        }
        lock.unlock()

        for pod in pods {
            let domain = Self.normalize(pod.serverDomain)
            guard !domain.isEmpty else { continue }
            // Case 2 — a fresh verified report replaces the pin. Case 3 — no
            // fresh pin ⇒ LEAVE the existing pin untouched (keep-last-good).
            if let verified = verifiedStatus(for: pod, domain: domain, nowMs: nowMs) {
                lock.lock()
                pins[domain] = verified.pin
                reports[domain] = verified.report
                lock.unlock()
            }
        }
    }

    /// Seed-supplied variant (mirrors Android `update(pods, umkSeed)`):
    /// derives + caches each pod's STK pub from the UMK seed, then
    /// reconciles. For call sites that already hold the unwrapped UMK.
    public func update(
        pods: [PodDirectoryEntry],
        umkSeed: Data,
        nowMs: Int64 = Int64(Date().timeIntervalSince1970 * 1000)
    ) {
        guard umkSeed.count == 32 else {
            update(pods: pods, nowMs: nowMs)
            return
        }
        for pod in pods {
            if let pub = ServerKeys.deriveStkPub(umkSeed: umkSeed, serverId: pod.serverDomain) {
                registerBoxStk(domain: pod.serverDomain, stkPub: pub)
            }
        }
        update(pods: pods, nowMs: nowMs)
    }

    private func verifiedStatus(
        for pod: PodDirectoryEntry,
        domain: String,
        nowMs: Int64
    ) -> (pin: String, report: DaemonStatusReport)? {
        guard pod.revokedAt == nil,
              let signed = pod.signedStatus,
              // The signed report must be ABOUT this pod — a valid report
              // for some other box must not pin this one.
              Self.normalize(signed.report.serverDomain) == domain
        else { return nil }
        lock.lock()
        let stkPub = stkPubs[domain]
        lock.unlock()
        guard let stkPub,
              DaemonStatus.verify(signed.report, signatureHex: signed.signatureHex, stkPub: stkPub),
              nowMs - signed.report.issuedAt <= DaemonStatus.maxReportAgeMs,
              let pin = signed.report.certSha256?.lowercased(),
              Self.isHex64(pin)
        else { return nil }
        return (pin, signed.report)
    }

    // MARK: - Lookup (the enforcement input)

    /// The pin governing `host`, or nil when no verified pin exists (⇒
    /// default TLS validation stands). Matches the box FQDN exactly OR any
    /// host under it (`<service>.<server>.<user>` rides the box wildcard).
    public func pinFor(host: String) -> String? {
        let h = Self.normalize(host)
        guard !h.isEmpty else { return nil }
        lock.lock()
        defer { lock.unlock() }
        if let exact = pins[h] { return exact }
        for (domain, pin) in pins where h.hasSuffix(".\(domain)") {
            return pin
        }
        return nil
    }

    /// The last fresh, STK-verified status report for this exact box. Unlike
    /// `pinFor`, this deliberately does not inherit to service subdomains: the
    /// server-detail screen asks about one canonical box FQDN.
    public func verifiedReport(for domain: String) -> DaemonStatusReport? {
        let key = Self.normalize(domain)
        guard !key.isEmpty else { return nil }
        lock.lock()
        defer { lock.unlock() }
        return reports[key]
    }

    /// Drop every pin (sign-out / profile switch). The STK-pub cache is
    /// also dropped — a different account's boxes derive differently.
    public func clear() {
        lock.lock()
        pins.removeAll()
        reports.removeAll()
        stkPubs.removeAll()
        lock.unlock()
        defaults?.removeObject(forKey: Self.stkPubsDefaultsKey)
    }

    // MARK: - Helpers

    private static func normalize(_ host: String) -> String {
        var h = host.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        while h.hasSuffix(".") { h.removeLast() }
        return h
    }

    private static func isHex64(_ s: String) -> Bool {
        hex64.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)) != nil
    }
}
