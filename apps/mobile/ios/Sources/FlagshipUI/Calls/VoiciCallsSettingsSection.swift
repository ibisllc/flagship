#if os(iOS)
import SwiftUI
import FlagshipCore

/// Social options → Calls (docs/voici-calls.md §8): calls on/off and who may call (published in the page index by an
/// admin device), the business hours (synced, sealed), and the China mainland note (no CallKit there, D4). There is no
/// Do Not Disturb of the app's own: the phone's Do Not Disturb and Focus decide through CallKit.
struct VoiciCallsSettingsSection: View {
    private let store = MessagesStore.shared
    @State private var center = VoiciCallCenter.shared
    @State private var busy = false
    @State private var lockedNote: String?

    var body: some View {
        let v = VoiciCallSettings.viewState(isAdmin: store.isAdmin, isPublic: store.isPublic, callsOn: store.callsOn, noRingMode: center.noRingMode)
        Section {
            Toggle("Accept calls", isOn: Binding(get: { store.callsOn }, set: { on in change(on: on, from: VoiciCallSettings.mode(store.callsFrom)) }))
                .disabled(!v.canEdit || busy)
                .accessibilityIdentifier("page-accept-calls")
            if v.showsWho {
                Picker("Who can call", selection: Binding(get: { VoiciCallSettings.mode(store.callsFrom) }, set: { f in change(on: true, from: f) })) {
                    Text("Anyone on the internet").tag(VoiciCallSettings.fromAnyone)
                    Text("People who let you call them back").tag(VoiciCallSettings.fromCallback)
                }
                .pickerStyle(.inline)
                .disabled(!v.canEdit || busy)
                .accessibilityIdentifier("page-calls-from")
            }
        } header: {
            Text("Calls")
        } footer: {
            VStack(alignment: .leading, spacing: 4) {
                switch v.note {
                case .publishFirst: Text("Publish your page to take calls.")
                case .adminOnly: Text("Only an admin device can change this")
                case nil:
                    switch VoiciCallSettings.mode(store.callsFrom) {
                    case VoiciCallSettings.fromAnyone:
                        Text("Anyone can call you from your page, with or without a Flagship account. Your admin devices ring.")
                    default:
                        Text("Callers sign in with Flagship and let you call them back in that conversation. You never learn who they are. Your admin devices ring.")
                    }
                }
                if v.noRingNote {
                    Text("In your region, calls ring only while Flagship is open.").accessibilityIdentifier("calls-no-ring-note")
                }
            }
        }
        if v.showsWho {
            Section {
                Toggle("Set business hours", isOn: Binding(get: { store.callHours != nil }, set: { on in
                    publishHours(on ? (VoiciCallHoursDraft(store.callHours) ?? .standard()).hours : nil)
                }))
                .disabled(busy)
                .accessibilityIdentifier("calls-hours")
                if let draft = VoiciCallHoursDraft(store.callHours) {
                    HStack {
                        ForEach(0..<7, id: \.self) { d in
                            Button(Self.dayLetter(d)) {
                                var x = draft
                                x.days[d].toggle()
                                if let h = x.hours { publishHours(h) }
                            }
                            .buttonStyle(.bordered)
                            .tint(draft.days[d] ? .accentColor : .secondary)
                            .accessibilityLabel(Text(Self.dayName(d)))
                            .accessibilityAddTraits(draft.days[d] ? .isSelected : [])
                            .accessibilityIdentifier("calls-hours-day-\(d)")
                        }
                    }
                    .disabled(busy)
                    DatePicker(selection: hoursBinding(draft, \.startMinute), displayedComponents: .hourAndMinute) { Text("From") }
                        .disabled(busy)
                        .accessibilityIdentifier("calls-hours-from")
                    DatePicker(selection: hoursBinding(draft, \.endMinute), displayedComponents: .hourAndMinute) { Text("Until") }
                        .disabled(busy)
                        .accessibilityIdentifier("calls-hours-until")
                }
            } footer: {
                if let draft = VoiciCallHoursDraft(store.callHours) {
                    Text(verbatim: String(localized: "Your devices ring only at these hours, in the time zone \(draft.zone); outside them a call becomes a missed call. Only your own devices know these hours. An end before the start runs past midnight."))
                } else {
                    Text("Calls can ring at any time.")
                }
            }
        }
        if v.showsWho && store.isAdmin {
            Section {
                Toggle("Answer calls while Flagship is locked", isOn: Binding(get: { store.answersWhileLocked }, set: { on in
                    busy = true
                    Task {
                        lockedNote = await store.setAnswerWhileLocked(on)
                        busy = false
                    }
                }))
                .disabled(busy)
                .accessibilityIdentifier("calls-answer-locked")
            } footer: {
                VStack(alignment: .leading, spacing: 4) {
                    Text("This device keeps a key that can answer calls and nothing else, so a call can be answered from the lock screen. The caller shows as “Someone on voi.ci” until you unlock.")
                    if let lockedNote { Text(verbatim: lockedNote) }
                }
            }
        }
    }

    private func change(on: Bool, from: String) {
        busy = true
        Task {
            await store.setCalls(on: on, from: from)
            busy = false
        }
    }

    private func publishHours(_ hours: VoiciCallHours?) {
        busy = true
        Task {
            _ = await store.setCallHours(hours)
            busy = false
        }
    }

    /// A time picker over one end of the published hours; a change publishes the hours again.
    private func hoursBinding(_ draft: VoiciCallHoursDraft, _ kp: WritableKeyPath<VoiciCallHoursDraft, Int>) -> Binding<Date> {
        Binding(get: {
            Calendar.current.date(bySettingHour: draft[keyPath: kp] / 60, minute: draft[keyPath: kp] % 60, second: 0, of: Date()) ?? Date()
        }, set: { d in
            let c = Calendar.current.dateComponents([.hour, .minute], from: d)
            var x = draft
            x[keyPath: kp] = (c.hour ?? 0) * 60 + (c.minute ?? 0)
            if let h = x.hours { publishHours(h) }
        })
    }

    /// Monday first, in the device's language.
    static func dayName(_ d: Int) -> String {
        let f = DateFormatter()
        f.locale = .current
        return f.standaloneWeekdaySymbols[(d + 1) % 7]
    }

    static func dayLetter(_ d: Int) -> String {
        let f = DateFormatter()
        f.locale = .current
        return f.veryShortStandaloneWeekdaySymbols[(d + 1) % 7]
    }
}
#endif
