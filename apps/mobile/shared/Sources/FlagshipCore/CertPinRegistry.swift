import Foundation
import FlagshipAPI

/// Cert-fingerprint pin registry (cert-model A′, phase 4) — the phone-side
/// half of "the client pins the box's real cert fingerprint and rejects
/// anything else".
///
/// Populated from `/pods` responses: each pod may carry the box's STK-signed
/// daemon-status report relayed VERBATIM (`signedStatus`). A pin is recorded
/// for the box FQDN only when ALL of these hold:
///   - the box key this device PINNED at the server's first blessing
///     (`ServerKeyPins.pinnedStk`, docs/first-contact.md — `.com`'s
///     `identityPubKey` echo is NOT a trust input) verifies the report signature,
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
public final class CertPinRegistry: @unchecked Sendable {
    /// Process-wide registry consulted by the shared pinned URLSession.
    public static let shared = CertPinRegistry()

    private static let hex64 = try! NSRegularExpression(pattern: "^[0-9a-f]{64}$")

    private let lock = NSLock()
    /// box FQDN (lowercase) → leaf-cert DER SHA-256 (lowercase hex).
    private var pins: [String: String] = [:]
    /// Last STK-verified daemon-status report for each box. This is the same
    /// evidence that installed `pins`; retaining it lets detail UI show real
    /// certificate metadata without trusting an unsigned relay projection.
    private var reports: [String: DaemonStatusReport] = [:]
    /// The server keys this device pinned at first blessing: the only STK source.
    public let serverKeys: ServerKeyPins

    /// `defaults == nil` ⇒ the key pins live only in memory (tests / previews).
    public init(persistingIn defaults: UserDefaults? = .standard, serverKeys: ServerKeyPins? = nil) {
        self.serverKeys = serverKeys ?? defaults.map { ServerKeyPins(defaults: $0) } ?? ServerKeyPins.volatile()
        UserDefaults.standard.removeObject(forKey: "flagship.certpin.boxStkPubs.v1")
    }

    // MARK: - STK

    /// The pinned STK pubkey for a box, if this device has blessed it — used
    /// to verify the box's LAN hint and status reports without unlocking the UMK.
    public func stkPub(forDomain domain: String) -> Data? {
        serverKeys.pinnedStk(Self.normalize(domain))
    }

    // MARK: - /pods reconciliation

    /// Reconcile the registry against a fresh `/pods` response using the
    /// PINNED server keys (no UMK access ⇒ no biometric). KEEP-LAST-KNOWN-GOOD
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
        guard let stkPub = serverKeys.pinnedStk(domain),
              DaemonStatus.verify(signed.report, signatureHex: signed.signatureHex, stkPub: stkPub),
              nowMs - signed.report.issuedAt <= DaemonStatus.maxReportAgeMs,
              let pin = signed.report.certSha256?.lowercased(),
              Self.isHex64(pin)
        else { return nil }
        return (pin, signed.report)
    }

    // MARK: - Lookup (the enforcement input)

    /// True when `host` is a box this phone knows (it pinned the box's STK at first blessing): the
    /// box itself or any name under its wildcard. Used to refuse a request to
    /// a known box that has no verified pin rather than fall back to ordinary web trust.
    public func isKnownBox(host: String) -> Bool {
        let h = Self.normalize(host)
        guard !h.isEmpty else { return false }
        lock.lock()
        defer { lock.unlock() }
        if now() < enrollmentAllowedUntil[h] ?? 0 { return false }
        return serverKeys.pinnedServer(forHost: h) != nil
    }

    /// The one narrow window in which a freshly created box may be reached before its first signed
    /// status gives the phone a pin: the caller names the exact host and the exchange it makes is
    /// authenticated by the paired STK, not by this connection. Expires on its own.
    public func allowUnpinnedEnrollment(host: String, forSeconds seconds: Double = 120) {
        let h = Self.normalize(host)
        guard !h.isEmpty else { return }
        lock.lock()
        enrollmentAllowedUntil[h] = now() + min(seconds, 300)
        lock.unlock()
    }

    private var enrollmentAllowedUntil: [String: TimeInterval] = [:]
    private func now() -> TimeInterval { Date().timeIntervalSince1970 }

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

    /// One verified box name and its pin, to test a relay address with, or nil
    /// when no box is known yet.
    public func anyPin() -> (host: String, pin: String)? {
        lock.lock()
        defer { lock.unlock() }
        return pins.first.map { (host: $0.key, pin: $0.value) }
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

    /// Drop every cert pin and server-key pin (sign-out / profile switch / wipe):
    /// the next approval of each server pins on first sight with the code box.
    public func clear() {
        lock.lock()
        pins.removeAll()
        reports.removeAll()
        lock.unlock()
        serverKeys.clear()
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
