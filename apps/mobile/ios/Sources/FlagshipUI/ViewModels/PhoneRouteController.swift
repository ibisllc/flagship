import Foundation
import Flagship
import FlagshipAPI
import FlagshipCore

/// The app's wiring of the phone route (docs/architecture-v2/phone-route.md §4): a foreground-only facility on an
/// admin device. Coming to the foreground: make the TLS key if there is none, order a certificate only when one is
/// due, and while a valid one is held, open the tunnel and claim the bare name. Leaving the foreground: release and
/// close. A refusal or a lost route is final until the next foreground.
@MainActor
public enum PhoneRouteController {
    private static weak var app: AppState?
    private static var client: PhoneTunnelClient?
    private static var task: Task<Void, Never>?
    public private(set) static var state: PhoneTunnelState?

    public static func install(app: AppState) {
        self.app = app
    }

    public static func appForeground() {
        guard client == nil, task == nil, let app, let user = app.currentUser, !user.isEmpty, !app.isDemoAccount, Keystore.hasAdminRoot,
              let deviceId = app.activeProfile?.deviceId, !deviceId.isEmpty,
              let deviceKey = Keystore.sessionAccountDeviceKey(accountId: user, deviceId: deviceId) else { return }
        let apex = Endpoints.dataApex
        let base = Endpoints.controlBaseUrl
        task = Task {
            defer { task = nil }
            guard let key = try? PhoneTlsKey.loadOrCreate(account: user) else { return }
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

    private static func tunnelHub(_ base: URL) async -> String? {
        guard let (data, _) = try? await URLSession.shared.data(from: base.appendingPathComponent("api/services/endpoints")),
              let o = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let hub = o["tunnelHub"] as? String, hub.hasPrefix("wss://") else { return nil }
        return hub
    }
}
