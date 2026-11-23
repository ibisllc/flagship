// The certificate check for the TLS connection a call's caller opens to the callee phone's TURN server
// (turns:<account>.<apex>:443). libwebrtc's own check trusts only its built-in roots (rtc_base/ssl_roots.h, Google's
// list), which hold no Let's Encrypt root, and phones' certificates come from Let's Encrypt: the call never connected
// from the app, while browsers (system roots) did. This checks the phone's certificate the way the system checks any
// TLS server: the system's roots, the exact name the call dialled, and the missing intermediates fetched by the
// system from the address the certificate names. WebRTC hands over only the server's own certificate.

import Foundation
import Security

#if os(iOS) && canImport(WebRTC)
import WebRTC

final class TurnCertVerifier: NSObject, RTCSSLCertificateVerifier {
    private let lock = NSLock()
    private var host: String?

    /// The name the call dials, taken from the TURN URL once the callee's answer arrives (before any connection).
    func expect(turnUrl: String) {
        lock.withLock { host = TurnCertCheck.host(ofTurnUrl: turnUrl) }
    }

    func verify(_ derCertificate: Data) -> Bool {
        guard let host = lock.withLock({ host }) else {
            voiciCallLog.notice("turn tls: refused (no expected name)")
            return false
        }
        let ok = TurnCertCheck.evaluate(derCertificate, host: host)
        voiciCallLog.notice("turn tls: \(ok ? "trusted" : "refused", privacy: .public)")
        return ok
    }
}
#endif

enum TurnCertCheck {

    static func evaluate(_ der: Data, host: String, at date: Date? = nil) -> Bool {
        guard let cert = SecCertificateCreateWithData(nil, der as CFData) else { return false }
        var trust: SecTrust?
        guard SecTrustCreateWithCertificates(cert, SecPolicyCreateSSL(true, host as CFString), &trust) == errSecSuccess,
              let trust else { return false }
        SecTrustSetNetworkFetchAllowed(trust, true)
        if let date { SecTrustSetVerifyDate(trust, date as CFDate) }
        var error: CFError?
        return SecTrustEvaluateWithError(trust, &error)
    }

    /// `turns:<host>:443?transport=tcp` → `<host>`; nil for anything else.
    static func host(ofTurnUrl url: String) -> String? {
        guard url.hasPrefix("turns:") else { return nil }
        let rest = url.dropFirst("turns:".count)
        let hostPort = rest.split(separator: "?", maxSplits: 1).first.map(String.init) ?? ""
        guard let host = hostPort.split(separator: ":", omittingEmptySubsequences: false).first, !host.isEmpty else { return nil }
        return host.lowercased()
    }
}
