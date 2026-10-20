import Foundation

/// A short, stable reason for a failure that the screen words calmly (`UserErrorText`): the same
/// code on iOS and Android (`DiagnosticCode.kt`), safe to copy to support. The sentence stays
/// simple; the code keeps the class of failure apart (name lookup, route, trust, refusal, ...).
public enum DiagnosticCode {
    public static let relayRouteUnverified = "relay-route-unverified"
    public static let relayPinMismatch = "relay-pin-mismatch"
    public static let relayEchoMismatch = "relay-echo-mismatch"

    public static func of(_ error: Error) -> String {
        if error is CancellationError { return "cancelled" }
        if let e = error as? ScreensClientError {
            switch e {
            case let .http(status, _): return "http-\(status)"
            case .certPinMismatch: return "tls-pin-mismatch"
            default: break
            }
        }
        if error is DecodingError { return "unreadable-answer" }
        let ns = error as NSError
        if ns.domain == NSURLErrorDomain { return forURL(URLError.Code(rawValue: ns.code)) }
        if let underlying = ns.userInfo[NSUnderlyingErrorKey] as? NSError, underlying.domain == NSURLErrorDomain {
            return forURL(URLError.Code(rawValue: underlying.code))
        }
        if ns.domain == NSPOSIXErrorDomain {
            switch Int32(ns.code) {
            case ETIMEDOUT: return "net-timeout"
            case ECONNRESET, EPIPE, ECONNABORTED, ENOTCONN: return "net-dropped"
            case ECONNREFUSED: return "net-refused"
            default: return "net-offline"
            }
        }
        return "error"
    }

    private static func forURL(_ code: URLError.Code) -> String {
        switch code {
        case .cannotFindHost, .dnsLookupFailed: return "net-name-lookup"
        case .timedOut: return "net-timeout"
        case .networkConnectionLost: return "net-dropped"
        case .notConnectedToInternet, .dataNotAllowed, .internationalRoamingOff: return "net-offline"
        case .cannotConnectToHost: return "net-refused"
        case .cancelled: return "cancelled"
        case .secureConnectionFailed, .serverCertificateUntrusted, .serverCertificateHasBadDate,
             .serverCertificateNotYetValid, .serverCertificateHasUnknownRoot, .clientCertificateRejected:
            return "tls-failed"
        default: return "net-error"
        }
    }
}

/// The last few failures the apps worded calmly, with the real class kept: what a person copies
/// when asked "what went wrong". Never holds a body, a key or a name a person chose.
public final class DiagnosticsLog: @unchecked Sendable {
    public static let shared = DiagnosticsLog()
    public static let capacity = 50

    public struct Entry: Equatable, Sendable {
        public let at: Date
        public let code: String
        public let host: String
        public let detail: String
    }

    private let lock = NSLock()
    private var entries: [Entry] = []

    public init() {}

    public func record(code: String, host: String, detail: String = "", at: Date = Date()) {
        lock.lock()
        entries.append(Entry(at: at, code: code, host: host, detail: detail))
        if entries.count > Self.capacity { entries.removeFirst(entries.count - Self.capacity) }
        lock.unlock()
    }

    public func recent() -> [Entry] { lock.lock(); defer { lock.unlock() }; return entries }

    public func clear() { lock.lock(); entries.removeAll(); lock.unlock() }

    /// One line per entry, newest last: `2026-10-20T10:00:00Z relay-route-unverified home.x.flagship.services net-dropped`.
    public func text() -> String {
        let f = ISO8601DateFormatter()
        return recent().map { "\(f.string(from: $0.at)) \($0.code) \($0.host)\($0.detail.isEmpty ? "" : " \($0.detail)")" }.joined(separator: "\n")
    }
}
