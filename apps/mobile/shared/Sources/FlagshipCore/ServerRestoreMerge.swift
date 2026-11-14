import Foundation
import CryptoKit

/// Restore a backup into a running server (docs/restore-into-server.md §4): the canonical bytes of the
/// stage, plan and undo orders and the plan's digest. Mirrors packages/protocol/src/serverRestoreMerge.ts;
/// `test-vectors/server-restore-merge/` is the shared reference. All three are sensitive orders: an admin
/// device signs them with the account's admin root.
public enum ServerRestoreMerge {
    public static let tagStage = "flagship/server-restore-stage/v1"
    public static let tagMerge = "flagship/server-restore-merge/v1"
    public static let tagUndo = "flagship/app-restore-undo/v1"
    public static let planMaxTtlMs: Int64 = 24 * 60 * 60_000

    public enum Failure: Error, Equatable { case invalid(String) }

    public static let sources = ["upload", "saved", "pull", "peers"]
    public static let actions = ["install", "skip", "keep", "replace", "replace-data", "copy"]

    public struct StageOrder: Equatable {
        public var serverDomain: String
        public var archiveId: String
        public var bytes: Int64
        public var sha256: String
        public var source: String
        public var issuedAt: Int64
        public init(serverDomain: String, archiveId: String, bytes: Int64, sha256: String, source: String, issuedAt: Int64) {
            self.serverDomain = serverDomain; self.archiveId = archiveId; self.bytes = bytes; self.sha256 = sha256; self.source = source; self.issuedAt = issuedAt
        }
    }

    public struct PlanLine: Equatable {
        public var archivedServiceId: String
        public var action: String
        public var targetServiceId: String?
        public var sameApp: Bool
        public var guardCode: String?
        public var guardSchema: String?
        public var guardGen: Int?
        public init(archivedServiceId: String, action: String, targetServiceId: String? = nil, sameApp: Bool = false, guardCode: String? = nil, guardSchema: String? = nil, guardGen: Int? = nil) {
            self.archivedServiceId = archivedServiceId; self.action = action; self.targetServiceId = targetServiceId; self.sameApp = sameApp
            self.guardCode = guardCode; self.guardSchema = guardSchema; self.guardGen = guardGen
        }
    }

    public struct MergeOrder: Equatable {
        public var serverDomain: String
        public var restoreId: String
        public var archiveId: String
        public var sha256: String
        public var planSha256: String
        public var issuedAt: Int64
        public var expiresAt: Int64
        public init(serverDomain: String, restoreId: String, archiveId: String, sha256: String, planSha256: String, issuedAt: Int64, expiresAt: Int64) {
            self.serverDomain = serverDomain; self.restoreId = restoreId; self.archiveId = archiveId; self.sha256 = sha256
            self.planSha256 = planSha256; self.issuedAt = issuedAt; self.expiresAt = expiresAt
        }
    }

    public struct UndoOrder: Equatable {
        public var serverDomain: String
        public var restoreId: String
        public var serviceId: String
        public var action: String
        public var issuedAt: Int64
        public init(serverDomain: String, restoreId: String, serviceId: String, action: String, issuedAt: Int64) {
            self.serverDomain = serverDomain; self.restoreId = restoreId; self.serviceId = serviceId; self.action = action; self.issuedAt = issuedAt
        }
    }

    private static func matches(_ s: String, _ pattern: String) -> Bool {
        s.range(of: pattern, options: .regularExpression) != nil
    }
    private static let hex32 = "^[0-9a-f]{32}$"
    private static let hex64 = "^[0-9a-f]{64}$"
    private static let label = "[a-z0-9](-?[a-z0-9]){0,31}"
    private static var serviceIdPattern: String { "^\(label)--\(label)$" }
    private static let codeDigest = "^(tree|sha256|wasi|manifest):[0-9a-f]{64}$"

    private static func domain(_ d: String, _ tag: String) throws {
        if d.isEmpty || d.contains("|") { throw Failure.invalid("\(tag): bad serverDomain") }
    }

    public static func stageBytes(_ o: StageOrder) throws -> Data {
        try domain(o.serverDomain, tagStage)
        guard matches(o.archiveId, hex32), o.bytes >= 1, matches(o.sha256, hex64), sources.contains(o.source), o.issuedAt >= 0 else {
            throw Failure.invalid("\(tagStage): bad order")
        }
        return Data([tagStage, o.serverDomain, o.archiveId, String(o.bytes), o.sha256, o.source, String(o.issuedAt)].joined(separator: "|").utf8)
    }

    public static func lineString(_ l: PlanLine) throws -> String {
        guard matches(l.archivedServiceId, serviceIdPattern), actions.contains(l.action) else { throw Failure.invalid("restore plan: bad line") }
        if l.action == "copy" {
            guard let t = l.targetServiceId, matches(t, serviceIdPattern) else { throw Failure.invalid("restore plan: a copy names its new app") }
        } else if l.targetServiceId != nil {
            throw Failure.invalid("restore plan: only a copy names a new app")
        }
        if l.sameApp && l.action != "replace" { throw Failure.invalid("restore plan: bad sameApp") }
        if l.action == "replace" || l.action == "replace-data" {
            guard let c = l.guardCode, matches(c, codeDigest), let s = l.guardSchema, matches(s, hex64), let g = l.guardGen, g >= 0, g <= 999_999 else {
                throw Failure.invalid("restore plan: bad guards")
            }
        } else if l.guardCode != nil || l.guardSchema != nil || l.guardGen != nil {
            throw Failure.invalid("restore plan: guards on an unguarded line")
        }
        return [l.archivedServiceId, l.action, l.targetServiceId ?? "-", l.sameApp ? "1" : "0", l.guardCode ?? "-", l.guardSchema ?? "-", l.guardGen.map(String.init) ?? "-"].joined(separator: "|")
    }

    /// SHA-256 hex of the lines sorted by archived id (byte order) and joined with "\n".
    public static func planSha256(_ lines: [PlanLine]) throws -> String {
        guard !lines.isEmpty, lines.count <= 500 else { throw Failure.invalid("restore plan: bad number of lines") }
        let sorted = lines.sorted { Array($0.archivedServiceId.utf8).lexicographicallyPrecedes(Array($1.archivedServiceId.utf8)) }
        for i in 1..<max(1, sorted.count) where sorted[i].archivedServiceId == sorted[i - 1].archivedServiceId {
            throw Failure.invalid("restore plan: an app named twice")
        }
        let joined = try sorted.map(lineString).joined(separator: "\n")
        return SHA256.hash(data: Data(joined.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    public static func mergeBytes(_ o: MergeOrder) throws -> Data {
        try domain(o.serverDomain, tagMerge)
        guard matches(o.restoreId, hex32), matches(o.archiveId, hex32), matches(o.sha256, hex64), matches(o.planSha256, hex64),
              o.issuedAt >= 0, o.expiresAt > o.issuedAt, o.expiresAt - o.issuedAt <= planMaxTtlMs else {
            throw Failure.invalid("\(tagMerge): bad order")
        }
        return Data([tagMerge, o.serverDomain, o.restoreId, o.archiveId, o.sha256, o.planSha256, String(o.issuedAt), String(o.expiresAt)].joined(separator: "|").utf8)
    }

    public static func undoBytes(_ o: UndoOrder) throws -> Data {
        try domain(o.serverDomain, tagUndo)
        guard matches(o.restoreId, hex32), matches(o.serviceId, serviceIdPattern), o.action == "undo" || o.action == "discard", o.issuedAt >= 0 else {
            throw Failure.invalid("\(tagUndo): bad order")
        }
        return Data([tagUndo, o.serverDomain, o.restoreId, o.serviceId, o.action, String(o.issuedAt)].joined(separator: "|").utf8)
    }
}
