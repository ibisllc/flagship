import Foundation

/// A hosted server's own health report, read from `.com` by the order that
/// created it (`GET /api/order/<serial>/health`, control-plane
/// `serverHealth.ts`): the account's server list needs its read token, which
/// Studio doesn't hold, and the order serial is a capability it does. The guest signs these numbers
/// once a minute from a timer that keeps running when the daemon doesn't, so
/// Studio can say why a server went quiet. The verdict copy matches the phone
/// apps (`BoxHealth.verdict` on iOS).
public struct VMServerHealth: Codable, Sendable, Equatable {
    public struct Daemon: Codable, Sendable, Equatable {
        public let state: String
        public let restarts: Int
        public let lastExit: Int
    }

    public let uptimeS: Int64
    public let memTotalMB: Int
    public let memAvailMB: Int
    public let oomKills: Int
    public let daemon: Daemon
    public let tunnel: Bool
    public let diskUsedPct: Int
    /// `.com`'s clock, ms.
    public let receivedAt: Int64

    public struct Verdict: Sendable, Equatable {
        public let ok: Bool
        public let lines: [String]
    }

    /// True when this report shows the guest unlocked and serving after THIS
    /// boot began: the daemon is active, the relay tunnel is up, the report
    /// was received after power-on, the guest's uptime fits inside the time
    /// since power-on (+60 s slack, so an earlier boot's report never counts)
    /// and it is under 5 minutes old. Studio takes this, not a fetch of the
    /// server's own name, as the sign a sealed guest came up (`UnlockWatch`).
    /// Pinned by vm-core-vectors.json "bootEvidence".
    public func provesBoxIsUp(poweredOnAt: Date, now: Date) -> Bool {
        let poweredOnMs = Int64(poweredOnAt.timeIntervalSince1970 * 1000)
        let nowMs = Int64(now.timeIntervalSince1970 * 1000)
        return daemon.state == "active"
            && tunnel
            && receivedAt >= poweredOnMs
            && uptimeS * 1000 <= (nowMs - poweredOnMs) + 60_000
            && nowMs - receivedAt < 300_000
    }

    public func verdict(at now: Date) -> Verdict {
        let staleMin = (Int64(now.timeIntervalSince1970 * 1000) - receivedAt) / 60_000
        if staleMin >= 5 {
            return Verdict(ok: false, lines: ["No health report for \(staleMin) min. The server itself may be off or frozen."])
        }
        var lines: [String] = []
        if oomKills > 0 {
            lines.append("Ran out of memory \(oomKills)× since it started (\(memAvailMB) MB free of \(memTotalMB) MB now).")
        }
        if daemon.state != "active" {
            lines.append("The server software isn't running (\(daemon.state); restarted \(daemon.restarts)×, last exit code \(daemon.lastExit)).")
        } else if daemon.restarts >= 3 {
            lines.append("The server software restarted \(daemon.restarts)× since it started (last exit code \(daemon.lastExit)).")
        }
        if !tunnel { lines.append("Can't reach the Flagship relay.") }
        if diskUsedPct >= 90 { lines.append("Disk is \(diskUsedPct)% full.") }
        if !lines.isEmpty { return Verdict(ok: false, lines: lines) }
        return Verdict(ok: true, lines: [
            "Healthy · \(memAvailMB) MB free of \(memTotalMB) MB · disk \(diskUsedPct)% · up \(Self.uptime(uptimeS))"
        ])
    }

    static func uptime(_ s: Int64) -> String {
        let d = s / 86_400, h = (s % 86_400) / 3_600, m = (s % 3_600) / 60
        if d >= 1 { return "\(d)d \(h)h" }
        if h >= 1 { return "\(h)h \(m)m" }
        return "\(m)m"
    }

    public static func orderHealthURL(serial: String,
                                      environment: [String: String] = ProcessInfo.processInfo.environment) -> URL? {
        guard (8...64).contains(serial.count),
              serial.allSatisfy({ ($0.isLetter || $0.isNumber) && $0.isASCII || $0 == "-" || $0 == "_" })
        else { return nil }
        return ControlPlane.orderURL(serial: serial, leaf: "health", environment: environment)
    }

    /// The report out of an order-health response; nil when the response
    /// names another server or its box doesn't report yet.
    public static func fromOrderHealth(_ data: Data, serverDomain: String) -> VMServerHealth? {
        struct Body: Decodable {
            let serverDomain: String
            let health: VMServerHealth?
            init(from decoder: Decoder) throws {
                let c = try decoder.container(keyedBy: CodingKeys.self)
                serverDomain = try c.decode(String.self, forKey: .serverDomain)
                health = try? c.decodeIfPresent(VMServerHealth.self, forKey: .health)
            }
            enum CodingKeys: String, CodingKey { case serverDomain, health }
        }
        guard let body = try? JSONDecoder().decode(Body.self, from: data),
              body.serverDomain.lowercased() == serverDomain.lowercased()
        else { return nil }
        return body.health
    }
}
