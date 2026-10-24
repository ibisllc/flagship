import SwiftUI
import FlagshipAPI
import FlagshipCore

/// The server page's "Start from your watch": an owner opt-in, off by default, that lets the watch approve
/// this server's start-up while the iPhone is locked. Shown on an admin device.
struct WatchBootKeyCard: View {
    @Environment(\.colorScheme) private var scheme
    @Environment(\.secretMailboxClient) private var mailbox
    @Environment(AppState.self) private var app

    let serverDomain: String
    @State private var vm: WatchBootKeyViewModel?
    @State private var confirmOn = false

    var body: some View {
        let c = FSColors.scheme(scheme)
        VStack(alignment: .leading, spacing: FS.space.s3) {
            FSSectionLabel(String(localized: "Start from your watch"))
            FSCard {
                if let vm {
                    content(vm, c: c)
                } else {
                    ProgressView()
                }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("sd-watch-boot")
        .task(id: serverDomain) {
            if vm == nil { vm = WatchBootKeyViewModel.live(serverDomain: serverDomain, mailbox: mailbox, username: app.currentUser ?? "") }
            vm?.reload()
        }
        .alert(String(localized: "Let your watch start this server?"), isPresented: $confirmOn) {
            Button(String(localized: "Turn on")) { Task { await vm?.turnOn() } }
                .accessibilityIdentifier("sd-watch-boot-confirm")
            Button(String(localized: "Cancel"), role: .cancel) {}
        } message: {
            Text(String(localized: "For up to 7 days your watch can approve this server's start-up, even while your iPhone is locked. Anyone wearing your unlocked watch could do it too. If you lock the server, only your iPhone can start it."))
        }
    }

    @ViewBuilder
    private func content(_ vm: WatchBootKeyViewModel, c: FSColors) -> some View {
        VStack(alignment: .leading, spacing: FS.space.s2) {
            if vm.watchReady {
                Toggle(isOn: Binding(
                    get: { vm.isOn },
                    set: { want in
                        if want { confirmOn = true } else { Task { await vm.turnOff() } }
                    }
                )) {
                    Text(String(localized: "Approve from watch while iPhone is locked"))
                        .font(FS.font.body()).foregroundColor(c.text)
                }
                .tint(c.accent)
                .disabled(vm.phase == .working)
                .accessibilityIdentifier("sd-watch-boot-toggle")
                if let ends = vm.expiresAt {
                    Text(String(localized: "On until \(Date(timeIntervalSince1970: Double(ends) / 1000).formatted(date: .abbreviated, time: .shortened)). Turn it on again after that."))
                        .font(FS.font.caption()).foregroundColor(c.success)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("sd-watch-boot-until")
                } else {
                    Text(String(localized: "Off. Your watch can approve this server's start-up only while Flagship is unlocked on this iPhone."))
                        .font(FS.font.caption()).foregroundColor(c.textMuted)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("sd-watch-boot-off")
                }
            } else {
                Text(String(localized: "Turn on Approve from watch in Account security to let your watch start this server while your iPhone is locked."))
                    .font(FS.font.bodySm()).foregroundColor(c.textMuted)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("sd-watch-boot-not-ready")
            }
            if case .failed(let msg) = vm.phase {
                Text(msg).font(FS.font.caption()).foregroundColor(c.danger)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("sd-watch-boot-error")
            }
        }
    }
}
