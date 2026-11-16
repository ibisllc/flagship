import Foundation
import FlagshipAPI
import FlagshipCore

/// The owner's calls settings (docs/voici-calls.md §8), Settings → Messages → Calls.
///
/// Calls on/off and who may call are part of the signed page index (`flagship/voici-page/v2`, §6): `.com` reads them
/// before ringing, so they change only by a publish from an admin device and every device sees them in the index.
/// Writers sign v2 only while calls are on, so a page without calls stays readable by v1 readers; the last "who can
/// call" choice is remembered on the device for the next time calls are turned on.
///
/// Do Not Disturb is per device and never leaves it: each ringing device checks its own hours when a call arrives and
/// stays silent (it does not join the room, so another device can still answer and an unanswered call becomes a
/// missed call). Keeping the hours off `.com` and the page index means no server learns the owner's time zone or
/// habits (AGENTS.md, "An AI never learns who or where the owner is").
public enum VoiciCallSettings {
    public static let fromAccepted = "accepted"
    public static let fromSignedIn = "signed-in"
    /// The page call modes the owner approved (docs/voici-calls.md "Who may call a page"): anyone on the internet, no
    /// account needed; or callback accounts only, where calling counts as consent to a ring-back in that conversation.
    public static let fromAnyone = "anyone"
    public static let fromCallback = "callback"
    public static let fromValues = [fromAccepted, fromSignedIn, fromAnyone, fromCallback]
    /// The modes the Social page offers; an older value turns into "callback" at the next change.
    public static let modes = [fromAnyone, fromCallback]
    public static func mode(_ from: String) -> String { modes.contains(from) ? from : fromCallback }

    /// The index fields for a calls setting: v2 fields while on, none (a v1 index) while off.
    public static func indexFields(on: Bool, from: String) -> (acceptsCalls: Int64?, callsFrom: String?) {
        on ? (1, fromValues.contains(from) ? from : fromAccepted) : (nil, nil)
    }

    /// What a calls setting in a published index reads as.
    public static func read(acceptsCalls: Int64?, callsFrom: String?) -> (on: Bool, from: String) {
        (acceptsCalls == 1, callsFrom.flatMap { fromValues.contains($0) ? $0 : nil } ?? fromAccepted)
    }

    /// Why the Calls controls can't be changed here, if they can't.
    public enum Note: Equatable { case publishFirst, adminOnly }

    public struct ViewState: Equatable {
        public var canEdit: Bool
        /// "Who can call" shows only while calls are on.
        public var showsWho: Bool
        public var note: Note?
        /// The China mainland storefront (no CallKit, owner decision D4): calls ring only while the app is open.
        public var noRingNote: Bool
    }

    public static func viewState(isAdmin: Bool, isPublic: Bool, callsOn: Bool, noRingMode: Bool) -> ViewState {
        let note: Note? = !isPublic ? .publishFirst : (!isAdmin ? .adminOnly : nil)
        return ViewState(canEdit: note == nil, showsWho: isPublic && callsOn, note: note, noRingNote: noRingMode)
    }
}

/// This device's Do Not Disturb hours for calls, minutes after local midnight. Start == end means all day.
public struct CallQuietHours: Codable, Equatable, Sendable {
    public var on: Bool
    public var startMinute: Int
    public var endMinute: Int

    public init(on: Bool, startMinute: Int, endMinute: Int) {
        self.on = on
        self.startMinute = Self.clamp(startMinute)
        self.endMinute = Self.clamp(endMinute)
    }

    public static let standard = CallQuietHours(on: false, startMinute: 22 * 60, endMinute: 7 * 60)

    static func clamp(_ m: Int) -> Int { ((m % 1440) + 1440) % 1440 }

    public func isQuiet(minuteOfDay m: Int) -> Bool {
        guard on else { return false }
        let m = Self.clamp(m)
        if startMinute == endMinute { return true }
        if startMinute < endMinute { return m >= startMinute && m < endMinute }
        return m >= startMinute || m < endMinute
    }

    public func isQuiet(at date: Date, calendar: Calendar = .current) -> Bool {
        let c = calendar.dateComponents([.hour, .minute], from: date)
        return isQuiet(minuteOfDay: (c.hour ?? 0) * 60 + (c.minute ?? 0))
    }
}

/// Where this device keeps its own calls preferences (UserDefaults; nothing synced).
public enum CallSettingsStore {
    static let quietKey = "flagship.voici.calls.quiet"
    static let fromKey = "flagship.voici.calls.from"

    public static func quietHours(_ d: UserDefaults = .standard) -> CallQuietHours {
        guard let data = d.data(forKey: quietKey), let q = try? JSONDecoder().decode(CallQuietHours.self, from: data) else { return .standard }
        return q
    }

    public static func setQuietHours(_ q: CallQuietHours, _ d: UserDefaults = .standard) {
        if let data = try? JSONEncoder().encode(q) { d.set(data, forKey: quietKey) }
    }

    /// The last "who can call" picked here, for turning calls on again.
    public static func lastFrom(_ d: UserDefaults = .standard) -> String {
        d.string(forKey: fromKey).flatMap { VoiciCallSettings.fromValues.contains($0) ? $0 : nil } ?? VoiciCallSettings.fromAccepted
    }

    public static func setLastFrom(_ from: String, _ d: UserDefaults = .standard) {
        if VoiciCallSettings.fromValues.contains(from) { d.set(from, forKey: fromKey) }
    }
}

/// A missed call, opened and checked on this device, shown in its conversation's thread.
public struct VoiciMissedCallRow: Equatable, Sendable, Identifiable {
    public var id: String { callId }
    public var callId: String
    public var conv: String
    public var pseudonymPub: String
    public var reason: String
    public var ringingAt: Int64
    public var video: Bool
}

/// One thread line: a message or a missed call, in time order.
public enum VoiciThreadEntry: Equatable, Identifiable {
    case message(VoiciThreadMessage)
    case missedCall(VoiciMissedCallRow)

    public var id: String {
        switch self {
        case .message(let m): return "m:" + m.msgId
        case .missedCall(let c): return "c:" + c.callId
        }
    }

    public var at: Int64 {
        switch self {
        case .message(let m): return m.sentAt
        case .missedCall(let c): return c.ringingAt
        }
    }

    /// Messages keep their order; each missed call goes in before the first message sent after it rang.
    public static func timeline(messages: [VoiciThreadMessage], calls: [VoiciMissedCallRow], conv: String) -> [VoiciThreadEntry] {
        var pending = calls.filter { $0.conv == conv }.sorted { $0.ringingAt < $1.ringingAt }
        var out: [VoiciThreadEntry] = []
        for m in messages {
            while let c = pending.first, c.ringingAt <= m.sentAt {
                out.append(.missedCall(c))
                pending.removeFirst()
            }
            out.append(.message(m))
        }
        out += pending.map(VoiciThreadEntry.missedCall)
        return out
    }

    /// "Missed call" or "Missed video call".
    public static func missedLabel(_ c: VoiciMissedCallRow) -> String {
        c.video ? String(localized: "Missed video call") : String(localized: "Missed call")
    }
}

/// The calls' one session to `.com` (the VoIP token, the room WebSocket): the pinning factory's session, like every
/// other client that may dial a box, so a call request can never skip the pin.
enum VoiciCallNetwork {
    static let session: URLSession = BoxPinnedURLSession.make(pinFor: { CertPinRegistry.shared.pinFor(host: $0) })
}

/// The call-hours value of the page index, "<days> <HHMM>-<HHMM> <time zone>" (VoiciPage.isCallHours), as the editor
/// shows it: seven days from Monday, minutes after midnight, the zone.
public struct VoiciCallHoursDraft: Equatable, Sendable {
    public var days: [Bool]
    public var startMinute: Int
    public var endMinute: Int
    public var zone: String

    public init(days: [Bool], startMinute: Int, endMinute: Int, zone: String) {
        self.days = days; self.startMinute = startMinute; self.endMinute = endMinute; self.zone = zone
    }

    /// Weekdays 9:00 to 17:30 in this device's zone.
    public static func standard(zone: String = TimeZone.current.identifier) -> VoiciCallHoursDraft {
        VoiciCallHoursDraft(days: [true, true, true, true, true, false, false], startMinute: 9 * 60, endMinute: 17 * 60 + 30, zone: zone)
    }

    public init?(_ value: String?) {
        guard let value, VoiciPage.isCallHours(value) else { return nil }
        let f = value.split(separator: " ").map(String.init)
        let t = f[1].split(separator: "-").map(String.init)
        days = f[0].map { $0 == "1" }
        startMinute = VoiciPage.hhmm(t[0])!
        endMinute = VoiciPage.hhmm(t[1])!
        zone = f[2]
    }

    /// The index value, or nil when it isn't a valid one (no day, start equal to end, an unknown zone).
    public var value: String? {
        func hm(_ m: Int) -> String { String(format: "%02d%02d", (m / 60) % 24, m % 60) }
        let v = "\(days.map { $0 ? "1" : "0" }.joined()) \(hm(startMinute))-\(hm(endMinute)) \(zone)"
        return days.count == 7 && VoiciPage.isCallHours(v) ? v : nil
    }
}
