import Foundation

/// A lost server's peer-backup record as a restoring device sees it (the
/// box's `POST /api/screens/peer-backup/root`, or the record the device opened
/// itself). docs/peer-backup.md; MIRRORS lib/peerBackup.js.
public struct PeerRootSummary: Codable, Equatable, Sendable {
    public struct Archive: Codable, Equatable, Sendable {
        public let archiveId: String
        public let createdAt: Int64
        public let bytes: Int64
        public let sha256: String
        /// The small `.flagship` file (JSON text) the account slot opens.
        public let backupFile: String
        public init(archiveId: String, createdAt: Int64, bytes: Int64, sha256: String, backupFile: String) {
            self.archiveId = archiveId; self.createdAt = createdAt; self.bytes = bytes
            self.sha256 = sha256; self.backupFile = backupFile
        }
    }
    public let serverId: String
    public let generation: Int
    public let revision: Int
    public let createdAt: Int64
    public let archive: Archive
    public let holders: Int
    public let needed: Int
    public let keepUntil: Int64

    public init(serverId: String, generation: Int, revision: Int, createdAt: Int64, archive: Archive,
                holders: Int, needed: Int, keepUntil: Int64) {
        self.serverId = serverId; self.generation = generation; self.revision = revision
        self.createdAt = createdAt; self.archive = archive; self.holders = holders
        self.needed = needed; self.keepUntil = keepUntil
    }
}

/// The body of `peer-backup/root` and `server-restore/from-peers`: the lost
/// server and the key only the account's devices can make for it.
public struct PeerRestoreRequest: Codable, Equatable, Sendable {
    public let serverId: String
    public let pbkHex: String
    public init(serverId: String, pbkHex: String) { self.serverId = serverId; self.pbkHex = pbkHex }
}

/// The sealed record `.com` keeps (public; only the account's key opens it).
public struct PeerSealedRoot: Codable, Equatable, Sendable {
    public let nonceHex: String
    public let ciphertextHex: String
    public init(nonceHex: String, ciphertextHex: String) { self.nonceHex = nonceHex; self.ciphertextHex = ciphertextHex }
}

/// One server holding a piece of this server's backup, never named.
public struct PeerHolderRow: Codable, Equatable, Sendable {
    public let label: String
    /// `ok` | `checking` | `failing` | `offline`
    public let state: String
    public let lastProofAt: Int64?
    public let bricks: Int
    public init(label: String, state: String, lastProofAt: Int64? = nil, bricks: Int = 0) {
        self.label = label; self.state = state; self.lastProofAt = lastProofAt; self.bricks = bricks
    }
}

/// What this server keeps for others.
public struct PeerHostingView: Codable, Equatable, Sendable {
    public let poolBytes: Int64
    public let realBytes: Int64
    public let fillerBytes: Int64
    public let provenBytes: Int64
    public let reliability: Double?
    public let leaving: Bool
    public init(poolBytes: Int64 = 0, realBytes: Int64 = 0, fillerBytes: Int64 = 0, provenBytes: Int64 = 0,
                reliability: Double? = nil, leaving: Bool = false) {
        self.poolBytes = poolBytes; self.realBytes = realBytes; self.fillerBytes = fillerBytes
        self.provenBytes = provenBytes; self.reliability = reliability; self.leaving = leaving
    }
}

/// The words of the v2 peer-backup page and the restore card, the same on all
/// three apps (lib/peerBackup.js).
public enum PeerBackupText {
    public static func stateTitle(_ s: String?) -> String {
        switch s {
        case "waiting-for-peers": return String(localized: "Looking for servers to keep pieces")
        case "filling": return String(localized: "Getting ready")
        case "placing": return String(localized: "Sending pieces to other servers")
        case "protected": return "Protected"
        case "at-risk": return String(localized: "At risk")
        case "leaving": return String(localized: "Leaving peer backups")
        case "off": return "Off"
        default: return s ?? ""
        }
    }

    public static func stateNote(_ s: String?) -> String {
        switch s {
        case "waiting-for-peers": return String(localized: "Peer backup starts once enough other servers can hold it.")
        case "filling": return String(localized: "This server is setting aside space for other servers' pieces first.")
        case "placing": return String(localized: "Your newest backup is being spread over other servers.")
        case "protected": return String(localized: "Enough of the servers holding your pieces answer to bring your backup back.")
        case "at-risk": return String(localized: "Too few pieces are safe. Your server is moving them to other servers.")
        case "leaving": return String(localized: "This server stops taking new pieces and frees its space in two weeks.")
        case "off": return String(localized: "Choose Peer-distributed backups in this server's Backups to turn it on.")
        default: return ""
        }
    }

    private static func holderState(_ s: String) -> String {
        switch s {
        case "ok": return "Answering"
        case "checking": return "Checking"
        case "failing": return String(localized: "Not answering")
        case "offline": return "Offline"
        default: return s
        }
    }

    public static func formatSize(_ n: Int64) -> String {
        if n < 0 { return "" }
        let gb: Int64 = 1 << 30
        if n >= gb { return String(format: n < 10 * gb ? "%.1f GB" : "%.0f GB", Double(n) / Double(gb)) }
        if n >= 1 << 20 { return String(localized: "\(Int((Double(n) / Double(1 << 20)).rounded())) MB") }
        return String(localized: "\(max(0, Int((Double(n) / 1024).rounded()))) KB")
    }

    /// "Server 1" and "Answering · last proof Oct 16, 2026 · 12 pieces".
    public static func holderLine(_ h: PeerHolderRow, formatTime: (Int64) -> String) -> String {
        [
            holderState(h.state),
            (h.lastProofAt ?? 0) > 0 ? "last proof \(formatTime(h.lastProofAt!))" : "no proof yet",
            String(localized: "\(h.bricks) piece\(h.bricks == 1 ? "" : "s")"),
        ].joined(separator: " · ")
    }

    /// The date by which a lost server's backup must be restored, or "".
    public static func restoreByLine(keepUntil: Int64?, now: Int64, formatTime: (Int64) -> String) -> String {
        guard let keepUntil, keepUntil > 0 else { return "" }
        if keepUntil <= now { return String(localized: "The pieces of this backup are no longer kept.") }
        let days = Int((Double(keepUntil - now) / 86_400_000).rounded(.up))
        return String(localized: "Restore by \(formatTime(keepUntil)) (\(days) day\(days == 1 ? "" : "s") left).")
    }

    /// What this server keeps for others.
    public static func hostingLines(_ h: PeerHostingView?) -> [String] {
        guard let h, h.poolBytes > 0 else { return [] }
        var out = [
            "Pool: \(formatSize(h.poolBytes)), of which \(formatSize(h.realBytes)) holds other servers' pieces and \(formatSize(h.fillerBytes)) is proof filler.",
            String(localized: "Proven so far: \(formatSize(h.provenBytes))."),
        ]
        if h.leaving { out.append(String(localized: "This server is leaving peer backups.")) }
        return out
    }

    /// The card a restore shows once a lost server's record is found.
    public static func rootLines(_ s: PeerRootSummary, now: Int64, formatTime: (Int64) -> String) -> [String] {
        var out = [String(localized: "Backup of \(s.serverId), saved \(formatTime(s.archive.createdAt)) (\(formatSize(s.archive.bytes))).")]
        out.append(String(localized: "\(s.holders) server\(s.holders == 1 ? "" : "s") hold its pieces; \(s.needed) bring it back."))
        let by = restoreByLine(keepUntil: s.keepUntil, now: now, formatTime: formatTime)
        if !by.isEmpty { out.append(by) }
        return out
    }
}
