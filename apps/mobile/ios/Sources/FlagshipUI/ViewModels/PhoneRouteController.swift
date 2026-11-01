import Foundation
import CryptoKit
import Flagship
import FlagshipAPI
import FlagshipCore

/// The app's wiring of the phone route (docs/architecture-v2/phone-route.md §4): a foreground-only facility. Coming to
/// the foreground, every device says a signed hello to `https://<account>.<apex>/`; an admin device then makes its TLS
/// key if there is none, orders a certificate only when one is due, and while a valid one is held, opens the tunnel and
/// claims (refused while another phone holds the name: it waits as a standby). Leaving the foreground closes the
/// tunnel and the relay makes the route vacant at once. No background wake: a phone not in the foreground claims nothing.
@MainActor
public enum PhoneRouteController {
    private static weak var app: AppState?
    private static var client: PhoneTunnelClient?
    private static var task: Task<Void, Never>?
    public private(set) static var state: PhoneTunnelState?
    /// Whether a phone answered this device's hello on the last foreground (nil: not asked yet).
    public private(set) static var holderPresent: Bool?

    /// Give the held route up so another admin phone can claim it (the trigger, an ask through `.com`, is a follow-up).
    @discardableResult
    public static func release() -> Bool { client?.release() ?? false }

    public static func install(app: AppState) {
        self.app = app
    }

    public static func appForeground() {
        guard client == nil, task == nil, let app, let user = app.currentUser, !user.isEmpty, !app.isDemoAccount,
              let deviceId = app.activeProfile?.deviceId, !deviceId.isEmpty,
              let deviceKey = Keystore.sessionAccountDeviceKey(accountId: user, deviceId: deviceId) else { return }
        let apex = Endpoints.dataApex
        let base = Endpoints.controlBaseUrl
        let admin = Keystore.hasAdminRoot
        task = Task {
            defer { task = nil }
            // A 2xx means a holder exists: an admin phone's claim will be refused and it waits as a standby.
            holderPresent = await sayHello(account: user, apex: apex, deviceKey: deviceKey)
            guard admin, !Task.isCancelled, let key = try? PhoneTlsKey.loadOrCreate(account: user) else { return }
            let certs = PhoneCertManager(store: DefaultsPhoneCertStore(), issuer: ComPhoneCertIssuer(base: base))
            _ = await certs.ensure(account: user, apex: apex, publicKey: key.publicUncompressed, signCsr: { try key.signDer($0) },
                                   deviceKey: deviceKey, leafKey: { PhoneTlsKey.leafKey(pem: $0) })
            guard !Task.isCancelled, let pem = certs.current(user), let identity = try? key.identity(account: user, chainPem: pem),
                  let hub = await tunnelHub(base), let url = URL(string: TunnelFrames.phoneTunnelURL(hub)), !Task.isCancelled,
                  let c = try? PhoneTunnelClient(url: url, account: user, apex: apex, deviceKey: deviceKey, identity: identity,
                                                 onState: { s in Task { @MainActor in state = s } }) else { return }
            client = c
            c.start()
        }
    }

    public static func appBackground() {
        task?.cancel()
        task = nil
        client?.stop()
        client = nil
        state = nil
    }

    /// The signed hello: `GET https://<account>.<apex>/` with the presence headers. True on a 2xx.
    static func sayHello(account: String, apex: String, deviceKey: Curve25519.Signing.PrivateKey) async -> Bool {
        let host = PhoneRoute.hostname(account: account, apex: apex)
        let device = HexUtil.encode(deviceKey.publicKey.rawRepresentation)
        let at = Int64(Date().timeIntervalSince1970 * 1000)
        guard let url = URL(string: "https://\(host)/"),
              let bytes = try? PhoneRoute.canonicalPresence(account: account, devicePub: device, hostname: host, issuedAt: at),
              let sig = try? PhoneRoute.signEd25519(bytes, key: deviceKey) else { return false }
        var req = URLRequest(url: url, timeoutInterval: 5)
        req.setValue(device, forHTTPHeaderField: "x-flagship-presence-device")
        req.setValue(String(at), forHTTPHeaderField: "x-flagship-presence-at")
        req.setValue(sig, forHTTPHeaderField: "x-flagship-presence-sig")
        guard let (_, res) = try? await URLSession.shared.data(for: req), let http = res as? HTTPURLResponse else { return false }
        return (200..<300).contains(http.statusCode)
    }

    private static func tunnelHub(_ base: URL) async -> String? {
        guard let (data, _) = try? await URLSession.shared.data(from: base.appendingPathComponent("api/services/endpoints")),
              let o = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let hub = o["tunnelHub"] as? String, hub.hasPrefix("wss://") else { return nil }
        return hub
    }
}
