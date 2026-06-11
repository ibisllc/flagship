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
/// Any failure ⇒ NO pin for that box (default TLS validation stands) and the
/// list rendering is never affected. With a pin, enforcement is HARD-FAIL
/// (locked decision): see `BoxCertPinningDelegate` (FlagshipAPI).
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
    /// CACHED STK pubs (no UMK access ⇒ no biometric). Every pod either
    /// installs its verified pin or CLEARS any previously recorded one (so a
    /// renewal whose new report hasn't verified yet falls back to default
    /// validation rather than hard-failing on the old pin). Never throws —
    /// a malformed entry simply yields no pin.
    public func update(
        pods: [PodDirectoryEntry],
        nowMs: Int64 = Int64(Date().timeIntervalSince1970 * 1000)
    ) {
        for pod in pods {
            let domain = Self.normalize(pod.serverDomain)
            guard !domain.isEmpty else { continue }
            let pin = verifiedPin(for: pod, domain: domain, nowMs: nowMs)
            lock.lock()
            if let pin { pins[domain] = pin } else { pins.removeValue(forKey: domain) }
            lock.unlock()
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

    private func verifiedPin(for pod: PodDirectoryEntry, domain: String, nowMs: Int64) -> String? {
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
        return pin
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

    /// Drop every pin (sign-out / profile switch). The STK-pub cache is
    /// also dropped — a different account's boxes derive differently.
    public func clear() {
        lock.lock()
        pins.removeAll()
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
