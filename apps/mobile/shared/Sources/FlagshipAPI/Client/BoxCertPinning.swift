import Foundation
import CryptoKit
import Security

// Cert-fingerprint pinning enforcement for BOX-bound URLSessions (cert-model
// A′, phase 4 — HARD-FAIL, locked decision).
//
// Every URLSession that dials a user's box (`https://<server>.<user>.
// flagship.services` and service names under it) gets a
// `BoxCertPinningDelegate`: the platform's default SecTrust evaluation runs
// FIRST (the pin narrows trust, never widens it); then, if the registry
// holds a verified STK-signed fingerprint for the box owning the host, the
// served leaf cert's DER SHA-256 must equal it or the connection is
// cancelled. No pin known → the default result stands; non-box hosts never
// match the registry at all. WebSocket tasks on the same session ride the
// same delegate, so the browser-stream socket is covered too.
//
// FlagshipAPI is the LEAF package (FlagshipCore depends on it, not the
// reverse), so the pin lookup arrives as an injected closure — the app wires
// `CertPinRegistry.shared.pinFor` (FlagshipCore) in. The accept/refuse logic
// itself is the pure `CertPinDecision.verdict` — the delegate is only glue.

/// The pure pinning decision, factored out of the TLS glue so it is
/// unit-testable without a SecTrust.
public enum CertPinVerdict: Equatable, Sendable {
    /// No pin governs this host — the default trust result stands.
    case noPin
    /// The served leaf matches the pinned fingerprint.
    case match
    /// HARD-FAIL: a pin governs this host and the served leaf differs
    /// (or could not be read) — refuse the connection.
    case mismatch
    /// HARD-FAIL: this is a box the phone knows but it holds no verified pin for it yet.
    /// A request to a known box never falls back to ordinary web trust
    /// (SECURITY-HARDENING-PLAN.md 7.1): the phone refreshes the signed status first.
    case blocked
}

/// Which hosts are boxes this phone knows. The app installs it once at launch
/// (`CertPinRegistry.shared.isKnownBox`); every pinning delegate consults it.
public enum BoxPinPolicy {
    private static let lock = NSLock()
    nonisolated(unsafe) private static var known: (@Sendable (String) -> Bool)?

    public static func install(isKnownBox: @escaping @Sendable (String) -> Bool) {
        lock.lock(); known = isKnownBox; lock.unlock()
    }

    public static func isKnownBox(_ host: String) -> Bool {
        lock.lock(); let k = known; lock.unlock()
        return k?(host) ?? false
    }
}

public enum CertPinDecision {
    public static func verdict(
        host: String,
        leafDerSha256Hex: String?,
        pinFor: (String) -> String?,
        isKnownBox: (String) -> Bool = { _ in false }
    ) -> CertPinVerdict {
        guard let pin = pinFor(host), !pin.isEmpty else { return isKnownBox(host) ? .blocked : .noPin }
        guard let leaf = leafDerSha256Hex, leaf.lowercased() == pin.lowercased() else {
            return .mismatch
        }
        return .match
    }
}

/// UX-A — a process-wide sink that records the most-recent per-host pin
/// MISMATCH so a client whose request then fails with a generic transport
/// error (URLSession reports a cancelled auth challenge as a nondescript
/// `NSURLErrorCancelled`) can recognise it was a pinning hard-fail and
/// surface the distinct "someone may be intercepting this box" message
/// instead of a generic "offline / try again". A mismatch is only meaningful
/// for a few seconds around the failing request, so entries are timestamped
/// and consumed with a freshness window.
public final class CertPinMismatchSink: @unchecked Sendable {
    public static let shared = CertPinMismatchSink()

    /// How long after a recorded mismatch a failing request may still claim
    /// it (the delegate fires synchronously just before the request fails).
    public static let freshnessMs: Int64 = 5_000

    private let lock = NSLock()
    private var lastMismatchMs: [String: Int64] = [:]
    private var lastMissingPinMs: [String: Int64] = [:]

    public init() {}

    public static func nowMs() -> Int64 { Int64(Date().timeIntervalSince1970 * 1000) }

    private static func normalize(_ host: String) -> String {
        var h = host.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        while h.hasSuffix(".") { h.removeLast() }
        return h
    }

    /// Called by the delegate on a `.mismatch` verdict.
    public func record(host: String, nowMs: Int64 = CertPinMismatchSink.nowMs()) {
        let key = Self.normalize(host)
        guard !key.isEmpty else { return }
        lock.lock(); lastMismatchMs[key] = nowMs; lock.unlock()
    }

    /// True iff `host` had a mismatch recorded within the freshness window.
    /// Consumes the entry so it can't bleed into an unrelated later failure.
    public func consumeRecentMismatch(host: String, nowMs: Int64 = CertPinMismatchSink.nowMs()) -> Bool {
        let key = Self.normalize(host)
        guard !key.isEmpty else { return false }
        lock.lock(); defer { lock.unlock() }
        guard let at = lastMismatchMs[key] else { return false }
        lastMismatchMs.removeValue(forKey: key)
        return nowMs - at <= Self.freshnessMs
    }

    /// Called by the delegate when a known box had no verified pin and the request was refused.
    public func recordMissingPin(host: String, nowMs: Int64 = CertPinMismatchSink.nowMs()) {
        let key = Self.normalize(host)
        guard !key.isEmpty else { return }
        lock.lock(); lastMissingPinMs[key] = nowMs; lock.unlock()
    }

    /// True iff a request to `host` was refused for want of a pin within the freshness window; the
    /// caller then refreshes the server's signed status instead of showing a generic network error.
    public func consumeRecentMissingPin(host: String, nowMs: Int64 = CertPinMismatchSink.nowMs()) -> Bool {
        let key = Self.normalize(host)
        guard !key.isEmpty else { return false }
        lock.lock(); defer { lock.unlock() }
        guard let at = lastMissingPinMs[key] else { return false }
        lastMissingPinMs.removeValue(forKey: key)
        return nowMs - at <= Self.freshnessMs
    }

    public func clear() {
        lock.lock(); lastMismatchMs.removeAll(); lastMissingPinMs.removeAll(); lock.unlock()
    }
}

/// URLSession delegate enforcing the pin on `NSURLAuthenticationMethodServerTrust`
/// challenges. Thin by design — see `CertPinDecision` for the logic.
public final class BoxCertPinningDelegate: NSObject, URLSessionDelegate, @unchecked Sendable {
    private let pinFor: @Sendable (String) -> String?
    private let isKnownBox: @Sendable (String) -> Bool

    public init(
        pinFor: @escaping @Sendable (String) -> String?,
        isKnownBox: @escaping @Sendable (String) -> Bool = { BoxPinPolicy.isKnownBox($0) }
    ) {
        self.pinFor = pinFor
        self.isKnownBox = isKnownBox
    }

    public func urlSession(
        _ session: URLSession,
        didReceive challenge: URLAuthenticationChallenge,
        completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
    ) {
        let (disposition, credential) = Self.handle(challenge, pinFor: pinFor, isKnownBox: isKnownBox)
        completionHandler(disposition, credential)
    }

    static func handle(
        _ challenge: URLAuthenticationChallenge,
        pinFor: (String) -> String?,
        isKnownBox: (String) -> Bool = { _ in false }
    ) -> (URLSession.AuthChallengeDisposition, URLCredential?) {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              let trust = challenge.protectionSpace.serverTrust
        else { return (.performDefaultHandling, nil) }

        // Default platform evaluation FIRST: a cert that fails ordinary
        // chain/hostname validation is never rescued by a pin.
        guard SecTrustEvaluateWithError(trust, nil) else {
            return (.performDefaultHandling, nil)
        }

        let host = challenge.protectionSpace.host
        switch CertPinDecision.verdict(
            host: host,
            leafDerSha256Hex: Self.leafDerSha256Hex(trust),
            pinFor: pinFor,
            isKnownBox: isKnownBox
        ) {
        case .noPin:
            return (.performDefaultHandling, nil)
        case .match:
            return (.useCredential, URLCredential(trust: trust))
        case .blocked:
            CertPinMismatchSink.shared.recordMissingPin(host: host)
            return (.cancelAuthenticationChallenge, nil)
        case .mismatch:
            // UX-A — flag the host so the client that's about to see this
            // request fail can surface the pin-mismatch message specifically.
            CertPinMismatchSink.shared.record(host: host)
            return (.cancelAuthenticationChallenge, nil)
        }
    }

    /// Lowercase-hex SHA-256 of the LEAF certificate's DER — the exact
    /// value the daemon reports as `certSha256` in its signed status.
    static func leafDerSha256Hex(_ trust: SecTrust) -> String? {
        guard let chain = SecTrustCopyCertificateChain(trust) as? [SecCertificate],
              let leaf = chain.first
        else { return nil }
        let der = SecCertificateCopyData(leaf) as Data
        return SHA256.hash(data: der).map { String(format: "%02x", $0) }.joined()
    }
}

/// Factory for the shared box-bound URLSession. Route every client that
/// dials a box through one of these (the screens client covers HTTP + SSE +
/// the browser-stream WebSocket via the same session).
public enum BoxPinnedURLSession {
    public static func make(pinFor: @escaping @Sendable (String) -> String?) -> URLSession {
        URLSession(
            configuration: .default,
            delegate: BoxCertPinningDelegate(pinFor: pinFor),
            delegateQueue: nil
        )
    }
}
