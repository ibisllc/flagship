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
/// The app has no Do Not Disturb of its own (owner, 2026-11-20): CallKit honours the phone's Do Not Disturb and Focus.
/// Business hours ("Set business hours") are the owner's synced, sealed setting (`VoiciCallSettingsSync`): outside
/// them no device rings and the call becomes a missed call; no server learns the hours or the time zone.
public enum VoiciCallSettings {
    public static let fromAccepted = "accepted"
    public static let fromSignedIn = "signed-in"
    /// The page call modes the owner approved (docs/voici-calls.md "Who may call a page"): anyone on the internet, no
    /// account needed; or callback accounts only, where calling counts as consent to a ring-back in that conversation.
    public static let fromAnyone = "anyone"
    public static let fromCallback = "callback"
    public static let fromValues = [fromAccepted, fromSignedIn, fromAnyone, fromCallback]
    /// The modes the Social page offers; an older value ("accepted", or "signed-in", which is no longer offered:
    /// owner, 2026-11-20) shows as "callback" and turns into it at the next publish. `.com` and voi.ci still accept
    /// "signed-in" in indexes old apps publish.
    public static let modes = [fromAnyone, fromCallback]
    /// What a page's first publish carries (owner decisions 2026-11-16 and 2026-11-20, docs/voici-and-messages.md §5.4):
    /// calls on from people who let the owner call them back (never anonymous), and messages on. A later publish keeps
    /// the owner's choices.
    public static let firstPublish = (on: true, from: fromCallback)
    public static let firstPublishAcceptsMessages: Int64 = 1
    public static func mode(_ from: String) -> String { modes.contains(from) ? from : fromCallback }

    /// The index fields for a calls setting: v2 fields while on, none (a v1 index) while off.
    public static func indexFields(on: Bool, from: String) -> (acceptsCalls: Int64?, callsFrom: String?) {
        on ? (1, fromValues.contains(from) ? from : fromAccepted) : (nil, nil)
    }

    /// What a calls setting in a published index reads as, and so what the next publish carries: "signed-in" reads as
    /// "callback" (no longer offered).
    public static func read(acceptsCalls: Int64?, callsFrom: String?) -> (on: Bool, from: String) {
        if callsFrom == fromSignedIn { return (acceptsCalls == 1, fromCallback) }
        return (acceptsCalls == 1, callsFrom.flatMap { fromValues.contains($0) ? $0 : nil } ?? fromAccepted)
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

/// Where this device keeps its own calls preferences (UserDefaults; nothing synced).
public enum CallSettingsStore {
    /// Where the app's own Do Not Disturb hours were kept until 2026-11-20; dropped, not migrated (they meant "quiet on
    /// this device", the opposite of business hours), and removed once by `forgetRemovedSettings`.
    static let removedQuietKey = "flagship.voici.calls.quiet"
    static let fromKey = "flagship.voici.calls.from"

    /// Deletes what removed settings left on this device.
    public static func forgetRemovedSettings(_ d: UserDefaults = .standard) {
        d.removeObject(forKey: removedQuietKey)
    }

    /// The last "who can call" picked here, for turning calls on again.
    public static func lastFrom(_ d: UserDefaults = .standard) -> String {
        d.string(forKey: fromKey).flatMap { VoiciCallSettings.fromValues.contains($0) ? $0 : nil } ?? VoiciCallSettings.firstPublish.from
    }

    public static func setLastFrom(_ from: String, _ d: UserDefaults = .standard) {
        if VoiciCallSettings.fromValues.contains(from) { d.set(from, forKey: fromKey) }
    }

    static let ownerHoursKey = "flagship.voici.calls.ownerHours"

    /// This device's copy of the owner's synced call hours (it rings while the account may be locked).
    public static func ownerHours(_ d: UserDefaults = .standard) -> VoiciCallSettingsValue? {
        d.data(forKey: ownerHoursKey).flatMap { try? JSONDecoder().decode(VoiciCallSettingsValue.self, from: $0) }
    }

    public static func setOwnerHours(_ s: VoiciCallSettingsValue?, _ d: UserDefaults = .standard) {
        if let s, let data = try? JSONEncoder().encode(s) { d.set(data, forKey: ownerHoursKey) } else { d.removeObject(forKey: ownerHoursKey) }
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

/// The owner's call hours as the editor shows them: seven days from Monday, minutes after midnight, the zone.
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

    public init?(_ hours: VoiciCallHours?) {
        guard let hours, let h = VoiciCallSettingsSync.parseHours(hours.json), let a = Self.minutes(h.from), let b = Self.minutes(h.to) else { return nil }
        days = h.days.map { $0 == "1" }
        startMinute = a
        endMinute = b
        zone = h.zone
    }

    static func minutes(_ s: String) -> Int? {
        guard s.count == 4, let n = Int(s) else { return nil }
        return (n / 100) * 60 + n % 100
    }

    /// The synced setting's hours, or nil when they aren't valid ones (no day, start equal to end, an unknown zone).
    public var hours: VoiciCallHours? {
        func hm(_ m: Int) -> String { String(format: "%02d%02d", (m / 60) % 24, m % 60) }
        guard days.count == 7 else { return nil }
        let h = VoiciCallHours(days: days.map { $0 ? "1" : "0" }.joined(), from: hm(startMinute), to: hm(endMinute), zone: zone)
        return VoiciCallSettingsSync.parseHours(h.json)
    }
}
