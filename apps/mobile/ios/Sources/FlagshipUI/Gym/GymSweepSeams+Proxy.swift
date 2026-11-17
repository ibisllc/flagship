#if DEBUG
import Foundation
import FlagshipAPI
import FlagshipCore

extension GymSweepSeams {
    /// The outbound proxy's failure UX (docs/outbound-proxy.md "Failure UX"), for GymProxyTests.
    ///
    /// - `-smoke-proxy-failing <code>`: the box reports its proxy failing with that code.
    /// - `-smoke-proxy-fallback`: the box connects around its failing proxy.
    /// - `-smoke-proxy-pods-alert`: `/pods` says the Home server's proxy is failing (auth).
    /// - `-smoke-proxy-offline`: the Home server can't be reached, and `/pods` says its proxy is why.
    /// - `-smoke-proxy-set-unreachable`: the next proxy order to the box finds no box (a timeout).
    /// - `-smoke-account-free`: `.com` says the account is on Free.
    static func proxy(_ args: [String], _ app: AppState, _ mocks: GymMocks) {
        let home = app.pods.first { $0.name == "Home" } ?? app.pods.first { $0.status == .online }
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        let socks = OutboundProxySummary.Proxy(kind: "socks5", host: "proxy.example.net", port: 1080, auth: false,
                                               fallbackDirect: false, issuedAt: now - 86_400_000)
        if let code = value(args, "-smoke-proxy-failing") {
            mocks.screens.outboundProxyInDetail = true
            mocks.screens.outboundProxySummary = OutboundProxySummary(
                proxy: socks, hasCredentials: false,
                status: .init(state: "failing", since: now - 600_000, lastError: "box English", code: code))
        }
        if args.contains("-smoke-proxy-fallback") {
            mocks.screens.outboundProxyInDetail = true
            mocks.screens.outboundProxySummary = OutboundProxySummary(
                proxy: OutboundProxySummary.Proxy(kind: "http", host: "10.0.0.2", port: 3128, auth: false, fallbackDirect: true, issuedAt: now),
                hasCredentials: false, status: .init(state: "fallback", since: now - 600_000, code: "refused"))
        }
        if args.contains("-smoke-proxy-pods-alert") || args.contains("-smoke-proxy-offline"), let home {
            let alert = ProxyAlertWire(state: "failing", code: "auth", since: now - 600_000)
            app.podsProxyAlert[home.fqdn.lowercased()] = alert
            // `/pods` carries it too, so a reconcile keeps it (the path the live app takes).
            for pod in app.pods where pod.status == .online {
                if let stk = HexUtil.decode(stkHex(pod.fqdn)) { ServerKeyPins().pin(stk, for: pod.fqdn) }
            }
            mocks.mailbox.directory = app.pods.filter { $0.status == .online }.map {
                PodDirectoryEntry(serverDomain: $0.fqdn, identityPubKey: stkHex($0.fqdn), lastReported: now,
                                  registeredAt: now - 86_400_000, hasCert: true, liveness: "live", lastSeenMsAgo: 0,
                                  proxyAlert: $0.podId == home.podId ? alert : nil)
            }
        }
        if args.contains("-smoke-proxy-offline"), let home {
            mocks.screens.unreachablePodIds.insert(home.podId)
        }
        if args.contains("-smoke-proxy-set-unreachable") {
            mocks.screens.outboundProxySetError = URLError(.timedOut)
        }
        if args.contains("-smoke-account-free") {
            mocks.server?.accountTierAnswer = "free"
        }
    }
}
#endif
