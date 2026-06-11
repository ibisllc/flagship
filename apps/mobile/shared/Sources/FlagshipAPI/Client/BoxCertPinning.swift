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
}

public enum CertPinDecision {
    public static func verdict(
        host: String,
        leafDerSha256Hex: String?,
        pinFor: (String) -> String?
    ) -> CertPinVerdict {
        guard let pin = pinFor(host), !pin.isEmpty else { return .noPin }
        guard let leaf = leafDerSha256Hex, leaf.lowercased() == pin.lowercased() else {
            return .mismatch
        }
        return .match
    }
}

/// URLSession delegate enforcing the pin on `NSURLAuthenticationMethodServerTrust`
/// challenges. Thin by design — see `CertPinDecision` for the logic.
public final class BoxCertPinningDelegate: NSObject, URLSessionDelegate, @unchecked Sendable {
    private let pinFor: @Sendable (String) -> String?

    public init(pinFor: @escaping @Sendable (String) -> String?) {
        self.pinFor = pinFor
    }

    public func urlSession(
        _ session: URLSession,
        didReceive challenge: URLAuthenticationChallenge,
        completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
    ) {
        let (disposition, credential) = Self.handle(challenge, pinFor: pinFor)
        completionHandler(disposition, credential)
    }

    static func handle(
        _ challenge: URLAuthenticationChallenge,
        pinFor: (String) -> String?
    ) -> (URLSession.AuthChallengeDisposition, URLCredential?) {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              let trust = challenge.protectionSpace.serverTrust
        else { return (.performDefaultHandling, nil) }

        // Default platform evaluation FIRST: a cert that fails ordinary
        // chain/hostname validation is never rescued by a pin.
        guard SecTrustEvaluateWithError(trust, nil) else {
            return (.performDefaultHandling, nil)
        }

        switch CertPinDecision.verdict(
            host: challenge.protectionSpace.host,
            leafDerSha256Hex: Self.leafDerSha256Hex(trust),
            pinFor: pinFor
        ) {
        case .noPin:
            return (.performDefaultHandling, nil)
        case .match:
            return (.useCredential, URLCredential(trust: trust))
        case .mismatch:
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
