import Foundation
import FlagshipAPI

// UX-A + UX-B — the ONE place an iOS surface turns a caught `Error` into a
// short, plain-language sentence safe to show a normal person, and surfaces
// the one security-relevant failure (a box cert-pin mismatch) as its own
// distinguishable category rather than folding it into "you're offline".
//
// This is a PURE STATIC MAPPING — a switch over a known error shape
// (`ScreensClientError`, `URLError`, `DecodingError`, an HTTP status, the
// cert-pin sentinel) to a hand-written string. No AI, no network, no runtime
// generation of any kind. Developer detail belongs in a log/`print`, never in
// the returned string (UX-B: a bare "HTTP 503" / Apple's developer-facing
// `localizedDescription` means nothing to a person).
//
// PARITY: the categories mirror Android's `NetworkErrorHumanizer.Kind`
// (cert-pin-mismatch / offline / server-problem / request-problem / unknown)
// and the webapp `humanError.js`, so the three surfaces give equivalent copy
// for equivalent failures. `ScreensClientError` already carries the canonical
// plain-language copy (incl. the cert-pin wording + the HTTP-status map), so
// for that type we delegate to its `errorDescription` rather than re-author
// the strings — a single source of truth for the wire-error copy.

/// The classification of a caught error, mirroring Android's
/// `NetworkErrorHumanizer.Kind`. Exposed so a view that wants to react to the
/// security case (e.g. show a louder banner) can branch on `.certPinMismatch`
/// without string-matching the message.
public enum HumanErrorKind: Sendable, Equatable {
    /// The box served a cert that did NOT match its STK-signed fingerprint —
    /// someone may be intercepting the connection. Never "offline".
    case certPinMismatch
    /// No usable network round-trip (offline / DNS / timeout / cancelled).
    case offline
    /// A 5xx from the backend — transient, try again.
    case serverProblem
    /// A 4xx (other than the cert case) / a malformed response — check the
    /// connection or the request.
    case requestProblem
    /// Anything we can't classify — never leak the raw text.
    case unknown
}

public enum HumanError {
    /// Classify a caught error into a `(kind, message)` pair. The message is
    /// always safe to show a person; the kind lets a caller special-case the
    /// security warning.
    public static func classify(_ error: Error) -> (kind: HumanErrorKind, message: String) {
        // 1. The shared wire-error type already owns the canonical copy
        //    (cert-pin warning + HTTP-status plain language). Delegate to it so
        //    there's a single source of truth for those strings.
        if let e = error as? ScreensClientError {
            return (kind(for: e), screensMessage(e))
        }

        // 2. A raw URLSession transport error. NSURLErrorCancelled is how
        //    URLSession reports a cert-pin hard-fail (the delegate cancels the
        //    auth challenge), so consult the mismatch sink before calling it a
        //    plain cancellation/offline.
        if let urlError = error as? URLError {
            if let host = urlError.flagshipFailingHost,
               CertPinMismatchSink.shared.consumeRecentMismatch(host: host) {
                return (.certPinMismatch, certPinCopy)
            }
            return urlErrorClassification(urlError)
        }

        // 3. A JSON-decode failure — the server returned something we couldn't
        //    read. Never surface the (developer-facing) coding-path detail.
        if error is DecodingError {
            return (.requestProblem, decodingCopy)
        }

        // 4. A bare cancellation (Task.cancel) is not a user-facing failure;
        //    callers usually skip it, but if shown, frame it as offline-ish.
        if error is CancellationError {
            return (.offline, offlineCopy)
        }

        return (.unknown, genericCopy)
    }

    /// The plain-language string only (the common case). Equivalent to
    /// Android's `NetworkErrorHumanizer.humanize(_:)` and the webapp
    /// `humanError(e)`.
    public static func humanize(_ error: Error) -> String {
        classify(error).message
    }

    /// True only for the box cert-fingerprint hard-fail — for callers that
    /// want to branch without inspecting the kind tuple.
    public static func isCertPinMismatch(_ error: Error) -> Bool {
        classify(error).kind == .certPinMismatch
    }

    // MARK: - ScreensClientError bridge

    private static func kind(for e: ScreensClientError) -> HumanErrorKind {
        switch e {
        case .certPinMismatch:
            return .certPinMismatch
        case .notPaired, .noSessionToken:
            return .requestProblem
        case .http(let status, _):
            if status == 0 { return .offline }
            if status >= 500 { return .serverProblem }
            return .requestProblem
        case .decoding:
            return .requestProblem
        case .notImplemented:
            return .requestProblem
        case .controlServerUntrusted:
            // The `GlobalTrustBar` red sliver is the PRIMARY surface for the
            // untrusted-control-server state; `HumanError` is only the inline-
            // text fallback when a halted call's error is shown directly.
            return .requestProblem
        }
    }

    /// `ScreensClientError.errorDescription` is non-nil for every case, but
    /// guard defensively so we never return an empty string.
    private static func screensMessage(_ e: ScreensClientError) -> String {
        e.errorDescription ?? genericCopy
    }

    // MARK: - URLError mapping

    private static func urlErrorClassification(
        _ e: URLError
    ) -> (kind: HumanErrorKind, message: String) {
        switch e.code {
        case .notConnectedToInternet,
             .networkConnectionLost,
             .dataNotAllowed,
             .internationalRoamingOff:
            return (.offline, "You're offline. Check your connection and try again.")
        case .timedOut:
            return (.offline, "The request timed out. Check your connection and try again.")
        case .cannotFindHost,
             .cannotConnectToHost,
             .dnsLookupFailed,
             .cannotLoadFromNetwork:
            return (.offline, offlineCopy)
        case .badServerResponse,
             .zeroByteResource,
             .cannotParseResponse:
            return (.serverProblem, "The server had a temporary problem. Please try again in a moment.")
        case .cancelled:
            // Not a pin mismatch (that was consumed above) — a deliberate or
            // transport cancellation. Treat as a try-again offline-ish case.
            return (.offline, offlineCopy)
        default:
            return (.offline, offlineCopy)
        }
    }

    // MARK: - Canonical copy (parity with Android + webapp)

    private static let certPinCopy =
        "This box's security certificate doesn't match what we expected — "
        + "someone may be intercepting the connection. Reinstall the box, or "
        + "contact whoever runs it before continuing."
    private static let offlineCopy =
        "Couldn't reach the server. Check your connection and try again."
    private static let decodingCopy =
        "Something came back we couldn't read. Try again in a moment."
    private static let genericCopy =
        "Something went wrong. Please try again."
}

private extension URLError {
    /// The host the failing request targeted, used to consult the cert-pin
    /// mismatch sink. Foundation surfaces the failing URL on `URLError`
    /// directly (`failingURL`); fall back to the userInfo string key for the
    /// cancelled-auth-challenge case where only the URL string is populated.
    var flagshipFailingHost: String? {
        if let h = failingURL?.host { return h }
        if let s = userInfo[NSURLErrorFailingURLStringErrorKey] as? String,
           let h = URL(string: s)?.host {
            return h
        }
        return nil
    }
}
