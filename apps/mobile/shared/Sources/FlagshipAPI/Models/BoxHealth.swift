import Foundation

/// A box's latest health report as `/pods` relays it (control-plane
/// `serverHealth.ts`): a timer on the box, independent of the daemon, signs
/// these numbers once a minute so the owner can see why a server went quiet.
/// Mirrored in Android `BoxHealth` and the webapp `lib/server-health.js`.
public struct BoxHealth: Codable, Equatable, Hashable, Sendable {
    public struct Daemon: Codable, Equatable, Hashable, Sendable {
        public let state: String
        public let restarts: Int
        public let lastExit: Int
        public init(state: String, restarts: Int, lastExit: Int) {
            self.state = state; self.restarts = restarts; self.lastExit = lastExit
        }
    }

    public let at: Int64
    public let uptimeS: Int64
    public let memTotalMB: Int
    public let memAvailMB: Int
    public let swapUsedMB: Int
    public let oomKills: Int
    public let daemon: Daemon
    public let tunnel: Bool
    public let diskUsedPct: Int
    /// `.com`'s clock, ms: when the report arrived.
    public let receivedAt: Int64

    public init(at: Int64, uptimeS: Int64, memTotalMB: Int, memAvailMB: Int, swapUsedMB: Int,
                oomKills: Int, daemon: Daemon, tunnel: Bool, diskUsedPct: Int, receivedAt: Int64) {
        self.at = at; self.uptimeS = uptimeS; self.memTotalMB = memTotalMB
        self.memAvailMB = memAvailMB; self.swapUsedMB = swapUsedMB; self.oomKills = oomKills
        self.daemon = daemon; self.tunnel = tunnel; self.diskUsedPct = diskUsedPct
        self.receivedAt = receivedAt
    }

    public struct Verdict: Equatable, Sendable {
        public let ok: Bool
        public let lines: [String]
    }

    /// Plain-sentence reading of the report. A report older than five minutes
    /// is itself the finding: its other numbers are out of date.
    public func verdict(nowMs: Int64) -> Verdict {
        let staleMin = (nowMs - receivedAt) / 60_000
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
}
