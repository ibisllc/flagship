#if os(iOS)
import SwiftUI
import FlagshipCore

/// Settings → Messages → Calls (docs/voici-calls.md §8): calls on/off and who may call (published in the page index by
/// an admin device), this device's Do Not Disturb hours, and the China mainland note (no CallKit there, D4).
struct VoiciCallsSettingsSection: View {
    private let store = MessagesStore.shared
    @State private var center = VoiciCallCenter.shared
    @State private var quiet = CallSettingsStore.quietHours()
    @State private var busy = false

    var body: some View {
        let v = VoiciCallSettings.viewState(isAdmin: store.isAdmin, isPublic: store.isPublic, callsOn: store.callsOn, noRingMode: center.noRingMode)
        Section {
            Toggle("Accept calls", isOn: Binding(get: { store.callsOn }, set: { on in change(on: on, from: store.callsFrom) }))
                .disabled(!v.canEdit || busy)
                .accessibilityIdentifier("page-accept-calls")
            if v.showsWho {
                Picker("Who can call", selection: Binding(get: { store.callsFrom }, set: { f in change(on: true, from: f) })) {
                    Text("People whose conversation you accepted").tag(VoiciCallSettings.fromAccepted)
                    Text("Anyone signed in with Flagship").tag(VoiciCallSettings.fromSignedIn)
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
                case nil: Text("Visitors signed in with Flagship can call you from your page. Your admin devices ring.")
                }
                if v.noRingNote {
                    Text("In your region, calls ring only while Flagship is open.").accessibilityIdentifier("calls-no-ring-note")
                }
            }
        }
        Section {
            Toggle("Do Not Disturb", isOn: Binding(get: { quiet.on }, set: { quiet.on = $0; save() }))
                .accessibilityIdentifier("calls-dnd")
            if quiet.on {
                DatePicker(selection: minuteBinding(\.startMinute), displayedComponents: .hourAndMinute) { Text("From") }
                    .accessibilityIdentifier("calls-dnd-from")
                DatePicker(selection: minuteBinding(\.endMinute), displayedComponents: .hourAndMinute) { Text("Until") }
                    .accessibilityIdentifier("calls-dnd-until")
            }
        } footer: {
            Text("This device doesn't ring during these hours. Your other devices keep their own setting.")
        }
    }

    private func change(on: Bool, from: String) {
        busy = true
        Task {
            await store.setCalls(on: on, from: from)
            busy = false
        }
    }

    private func save() { CallSettingsStore.setQuietHours(quiet) }

    private func minuteBinding(_ kp: WritableKeyPath<CallQuietHours, Int>) -> Binding<Date> {
        Binding(get: {
            Calendar.current.date(bySettingHour: quiet[keyPath: kp] / 60, minute: quiet[keyPath: kp] % 60, second: 0, of: Date()) ?? Date()
        }, set: { d in
            let c = Calendar.current.dateComponents([.hour, .minute], from: d)
            quiet[keyPath: kp] = (c.hour ?? 0) * 60 + (c.minute ?? 0)
            save()
        })
    }
}
#endif
