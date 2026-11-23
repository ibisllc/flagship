import Foundation
import Observation
import FlagshipCore

/// One call in the Calls list (docs/voici-calls.md "Calling from the app"): kept on this device only. Nothing about
/// who called whom is synced or sent to any server; the missed calls `.com` already holds (sealed to the inbox key)
/// are merged in when the list is shown.
public struct VoiciCallRecord: Codable, Equatable, Identifiable, Sendable {
    public enum Direction: String, Codable, Sendable { case incoming, outgoing }
    public enum Outcome: String, Codable, Sendable { case answered, missed, declined, noAnswer = "no-answer", failed, browser }
    /// The other side: a page this account called as a visitor, or a visitor of this account's page (a pseudonym in
    /// one of its conversations, which can't be called back yet: the owner's decision on that path is pending).
    public enum Peer: Codable, Equatable, Sendable {
        case page(username: String, pageId: String)
        case visitor(conv: String, pseudonymPub: String)
    }

    public var id: String { "\(direction.rawValue)|\(callId)" }
    public var callId: String
    public var direction: Direction
    public var outcome: Outcome
    public var peer: Peer
    public var video: Bool
    public var at: Int64
    public var durationMs: Int64

    public init(callId: String, direction: Direction, outcome: Outcome, peer: Peer, video: Bool, at: Int64, durationMs: Int64 = 0) {
        self.callId = callId; self.direction = direction; self.outcome = outcome; self.peer = peer; self.video = video; self.at = at
        self.durationMs = durationMs
    }

    /// A page this device can call back from the list.
    public var callablePage: (username: String, pageId: String)? {
        if case .page(let u, let p) = peer { return (u, p) }
        return nil
    }
}

/// The device's own call records, per account, in the app's defaults. Capped; cleared when the account leaves the
/// device (MessagesStore.forgetLocal).
@MainActor
@Observable
public final class VoiciCallHistory {
    public static let shared = VoiciCallHistory()
    public static let maxRecords = 200

    public private(set) var records: [VoiciCallRecord] = []
    @ObservationIgnored private var username: String?
    @ObservationIgnored private let defaults: UserDefaults
    /// A record was added or forgotten (the locked-names table follows the calls, docs/voici-locked-caller-names.md).
    @ObservationIgnored public var onChange: (() -> Void)?

    public init(defaults: UserDefaults = .standard) { self.defaults = defaults }

    nonisolated static func key(_ username: String) -> String { "flagship.voici.callHistory.\(username.lowercased())" }

    public func configure(username: String?) {
        guard username?.lowercased() != self.username else { return }
        self.username = username?.lowercased()
        records = username.flatMap { u in defaults.data(forKey: Self.key(u)).flatMap { try? JSONDecoder().decode([VoiciCallRecord].self, from: $0) } } ?? []
    }

    /// Adds (or replaces, by direction and call id) one record.
    public func record(_ r: VoiciCallRecord) {
        records.removeAll { $0.id == r.id }
        records.append(r)
        records.sort { $0.at > $1.at }
        if records.count > Self.maxRecords { records.removeLast(records.count - Self.maxRecords) }
        guard let u = username, let data = try? JSONEncoder().encode(records) else { return }
        defaults.set(data, forKey: Self.key(u))
        onChange?()
    }

    /// Drops the records a deleted conversation covers (docs/voici-and-messages.md §10.1.1).
    public func forget(where drop: (VoiciCallRecord) -> Bool) {
        let before = records.count
        records.removeAll(where: drop)
        guard records.count != before, let u = username, let data = try? JSONEncoder().encode(records) else { return }
        defaults.set(data, forKey: Self.key(u))
        onChange?()
    }

    /// The list as shown: this device's records and the page's missed calls, newest first. A missed call this device
    /// already has a record of (it rang here and was declined, say) shows once, as this device's record.
    public func entries(missed: [VoiciMissedCallRow]) -> [VoiciCallRecord] {
        Self.merge(records: records, missed: missed)
    }

    nonisolated static func merge(records: [VoiciCallRecord], missed: [VoiciMissedCallRow]) -> [VoiciCallRecord] {
        var out = records
        let known = Set(records.filter { $0.direction == .incoming }.map(\.callId))
        for m in missed where !known.contains(m.callId) {
            out.append(VoiciCallRecord(callId: m.callId, direction: .incoming, outcome: m.reason == "decline" ? .declined : .missed,
                                       peer: .visitor(conv: m.conv, pseudonymPub: m.pseudonymPub), video: m.video, at: m.ringingAt))
        }
        return out.sorted { $0.at == $1.at ? $0.id < $1.id : $0.at > $1.at }
    }

    /// The account left this device.
    nonisolated static func forget(username: String?, allProfiles: Bool, defaults: UserDefaults = .standard) {
        if allProfiles {
            for k in defaults.dictionaryRepresentation().keys where k.hasPrefix("flagship.voici.callHistory.") { defaults.removeObject(forKey: k) }
        } else if let u = username, !u.isEmpty {
            defaults.removeObject(forKey: key(u))
        }
    }

    func forgetInMemory() {
        records = []
        username = nil
        onChange = nil
    }
}

/// What the Calls page's "Who to call" field takes: a voi.ci username, `voi.ci/<username>`, `@<username>` or the
/// page's https link. Phone numbers come later (docs/social-tabs.md). Nil when it isn't one.
public enum VoiciCallTarget {
    nonisolated public static func username(from input: String, voiciHost: String = "voi.ci") -> String? {
        var s = input.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        for p in ["https://", "http://"] where s.hasPrefix(p) { s.removeFirst(p.count) }
        for p in ["www.\(voiciHost)/", "\(voiciHost)/", "voi.ci/", "@"] where s.hasPrefix(p) { s.removeFirst(p.count) }
        if let cut = s.firstIndex(where: { $0 == "?" || $0 == "#" }) { s = String(s[..<cut]) }
        while s.hasSuffix("/") { s.removeLast() }
        guard (1...63).contains(s.count), let first = s.unicodeScalars.first,
              CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyz0123456789").contains(first),
              s.unicodeScalars.allSatisfy({ CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyz0123456789-").contains($0) }) else { return nil }
        return s
    }
}
