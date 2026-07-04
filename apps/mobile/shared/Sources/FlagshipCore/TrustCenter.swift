import Foundation
import Observation

/// One control-/relay-blessing failure the app surfaces — a single failing CA
/// cert, slugged by its cert-hash. The red trust sliver renders ONE line per
/// failing cert; the line persists even after the owner overrides it (the
/// degraded state stays visible — overriding only un-halts backend traffic).
public struct TrustFailure: Identifiable, Equatable, Sendable {
    public let certClass: TrustException.CertClass
    /// `sha256hex(utf8(caPubkey))` — lower-case hex.
    public let certHash: String
    /// The served CA pubkey (hex) this failure was raised against — carried so
    /// an override can sign a `TrustException` scoped to its cert-hash.
    public let caPubkey: String

    public var id: String { "\(certClass.rawValue):\(certHash)" }

    public init(certClass: TrustException.CertClass, certHash: String, caPubkey: String) {
        self.certClass = certClass
        self.certHash = certHash
        self.caPubkey = caPubkey
    }

    /// First 8 hex of the cert-hash — the sliver slug.
    public var slug: String { String(certHash.prefix(8)) }

    /// The sliver line — one canonical shape per class.
    public var label: String {
        switch certClass {
        case .control: return "Control server certificate expired · \(slug)"
        case .relay:   return "Relay certificate expired · \(slug)"
        }
    }
}

/// App-wide trust verdict + the failing-cert registry that drives the red
/// persistent sliver. Mirrors the `ActiveOperationsCenter` / `ToastCenter`
/// app-scope-observable pattern: an `@Observable @MainActor` singleton injected
/// at the App scope, the single source of truth the trust sliver + the backend
/// short-circuit read.
///
/// `verdict`:
///   - `.unknown` — no valid `/api/maintainer-blessing` response has been
///     evaluated yet (cold start, or a NETWORK error). NOT a halt: we never
///     brick on the absence of a verdict, only on a valid response that fails.
///   - `.trusted` — the last valid blessing verified.
///   - `.untrusted` — the last valid blessing FAILED verification.
///
/// `isServerTrusted` is the foundation boolean the gate reads: false ONLY when
/// the verdict is `.untrusted` AND every failing cert has not been overridden.
/// While false, all backend interaction is short-circuited.
@Observable
@MainActor
public final class TrustCenter {
    public enum Verdict: Equatable, Sendable { case unknown, trusted, untrusted }

    public private(set) var verdict: Verdict = .unknown
    /// The failing certs behind an `.untrusted` verdict — one per cert. Deduped
    /// by `id` (class+certHash). Empty whenever the verdict isn't `.untrusted`.
    public private(set) var failures: [TrustFailure] = []
    /// Cert-hashes the owner has accepted (a signed `TrustException` was made).
    /// An override un-halts traffic but the failure line STAYS in `failures`.
    public private(set) var overriddenCertHashes: Set<String> = []

    /// PER-CERT RELAY failures aggregated across the user's pods
    /// (`RelayTrustAggregator`) — a SEPARATE source from the control-CA
    /// `failures`/`verdict`. It drives the red sliver (one line per DISTINCT
    /// faulty relay authority) but NEVER `isServerTrusted` — a relay-cert
    /// failure is a WARNING + override, not the control-CA `.com` I/O halt. The
    /// "overridden" marker on each entry is wire-driven (`coveringException-
    /// CertHash`), persisting until a fresh valid blessing clears it.
    public private(set) var relayFailures: [RelayCertFailure] = []

    public init() {}

    /// True unless we positively know the control server is untrusted AND at
    /// least one failing cert is still un-overridden. `.unknown` and `.trusted`
    /// are both "let traffic through". An override of every failing cert flips
    /// this back to true (traffic resumes; the red sliver persists).
    public var isServerTrusted: Bool {
        guard verdict == .untrusted else { return true }
        // Untrusted, but if every failing cert is overridden, traffic resumes.
        return !failures.contains { !overriddenCertHashes.contains($0.certHash) }
    }

    /// The sliver shows nothing once the verdict isn't `.untrusted`. While
    /// untrusted it shows one line per failing cert, even after override.
    public var sliverFailures: [TrustFailure] {
        verdict == .untrusted ? failures : []
    }

    // MARK: - Verdict transitions

    /// A valid blessing verified — clear the failure state.
    public func markTrusted() {
        if verdict != .trusted { verdict = .trusted }
        if !failures.isEmpty { failures = [] }
    }

    /// A valid blessing FAILED — record the failing cert(s). Idempotent: the
    /// same failure set never churns observers, and overrides survive a
    /// re-evaluation (a steady poll of the same broken blessing keeps the user's
    /// acceptance). Dedups by id; control + relay can both fail at once.
    public func markUntrusted(_ newFailures: [TrustFailure]) {
        var merged: [TrustFailure] = []
        var seen = Set<String>()
        for f in newFailures where !seen.contains(f.id) {
            seen.insert(f.id)
            merged.append(f)
        }
        if verdict != .untrusted { verdict = .untrusted }
        if merged != failures { failures = merged }
        // Prune overrides for certs no longer failing (a fixed-then-rebroken
        // cert must be re-accepted — its hash changed, so this is automatic).
        let live = Set(merged.map { $0.certHash })
        let kept = overriddenCertHashes.intersection(live)
        if kept != overriddenCertHashes { overriddenCertHashes = kept }
    }

    /// A NETWORK error — no verdict. Leaves any existing verdict UNTOUCHED so a
    /// previously-known `.untrusted` keeps halting, and a never-evaluated state
    /// stays `.unknown` (never bricks on a network failure).
    public func markNoVerdict() {}

    /// Replace the per-cert RELAY failure set (verified + aggregated from
    /// `/pods` by `RelayTrustAggregator`). Idempotent — an unchanged set never
    /// churns observers. Independent of `verdict`/`failures`, so it never
    /// affects `isServerTrusted` (no `.com` halt).
    public func setRelayFailures(_ next: [RelayCertFailure]) {
        if next != relayFailures { relayFailures = next }
    }

    /// Record that the owner signed a `TrustException` for [certHash]. The
    /// failure line stays visible; traffic for that cert resumes.
    public func recordOverride(certHash: String) {
        if !overriddenCertHashes.contains(certHash) {
            overriddenCertHashes.insert(certHash)
        }
    }

    /// Is [certHash] still blocking traffic (failing AND not overridden)?
    public func isBlocking(certHash: String) -> Bool {
        verdict == .untrusted
            && failures.contains { $0.certHash == certHash }
            && !overriddenCertHashes.contains(certHash)
    }
}
