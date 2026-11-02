import Foundation
import FlagshipAPI

/// "Sign in with Flagship" from voi.ci (docs/voici-and-messages.md §6.5, and the "D:" note there): the browser shows
/// `https://<control apex>/voici-sign-in?s=<sid>&k=<browser X25519>&p=<pageId>&u=<username>&d=<delegatePub>&n=<nonce>`
/// as a QR or an "Open Flagship" link. The request the app signs for (`flagship/voici-sign-in-request/v1`) rides in the
/// link itself, because the `/qr-pipe` relay carries nothing from the browser to the phone: the 6-digit code both
/// sides show is derived from the X25519 exchange, and the answer is sealed under the same key, so a changed link
/// shows a different code and its answer cannot be read.
public struct VoiciSignInLink: Equatable, Sendable {
    public static let path = "/voici-sign-in"
    public let session: QrRelay.QrSession
    public let request: VoiciSignInRequest

    public static func parse(_ raw: String, origin: String = Endpoints.voiciOrigin) -> VoiciSignInLink? {
        guard let url = URL(string: raw.trimmingCharacters(in: .whitespacesAndNewlines)), DeepLink.isControlHostLink(url),
              DeepLink.trimmedPath(url) == path, let comps = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return nil }
        // The browser puts the fields in the fragment (it names a person); a query works too.
        var q: [String: String] = [:]
        var frag = URLComponents()
        frag.percentEncodedQuery = comps.percentEncodedFragment
        for item in (frag.queryItems ?? []) + (comps.queryItems ?? []) { if let v = item.value, q[item.name] == nil { q[item.name] = v } }
        guard let s = q["s"], let sid = Base64URL.decode(s), sid.count == 16,
              let k = q["k"], let pk = Base64URL.decode(k), pk.count == 32 else { return nil }
        let request: JSONValue = ["kind": .string(VoiciMessages.tagVoiciSignInRequest), "origin": .string(origin),
                                  "pageId": .string(q["p"] ?? ""), "username": .string((q["u"] ?? "")),
                                  "delegatePub": .string(q["d"] ?? ""), "nonce": .string(q["n"] ?? "")]
        guard let r = VoiciMessages.parseVoiciSignInRequest(request) else { return nil }
        return VoiciSignInLink(session: QrRelay.QrSession(sid: s, browserPublicKey: pk), request: r)
    }
}
