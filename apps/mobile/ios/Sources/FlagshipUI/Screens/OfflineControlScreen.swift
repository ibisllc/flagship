import SwiftUI
import FlagshipAPI
import FlagshipCore

/// Offline control (docs/data-sovereignty.md): reach your own server on this Wi-Fi when Flagship
/// can't be reached, check it by its own key, and see its status, start, stop or restart its apps,
/// restart or shut it down, and save its data. Reached from Settings (always), from a server's page
/// while it can't be reached, and from "This account was removed".
struct OfflineControlScreen: View {
    @Environment(\.colorScheme) private var scheme
    @State var vm: OfflineControlViewModel
    @State private var confirm: Pending?
    @State private var copied = false

    struct Pending: Identifiable {
        let action: OfflineControlOrder.Action
        let serviceId: String?
        let name: String
        var id: String { action.rawValue + (serviceId ?? "") }
    }

    var body: some View {
        let c = FSColors.scheme(scheme)
        ScrollView {
            VStack(alignment: .leading, spacing: FS.space.s4) {
                switch vm.phase {
                case .connected:
                    connected(c)
                default:
                    finding(c)
                }
            }
            .padding(FS.space.s4)
            .frame(maxWidth: 640, alignment: .leading)
            .frame(maxWidth: .infinity)
        }
        .background(c.bg.ignoresSafeArea())
        .navigationTitle(Text("Offline control"))
        .navigationBarTitleDisplayMode(.inline)
        .accessibilityIdentifier("offline-control")
        .onAppear { vm.start() }
        .onDisappear { vm.stop() }
        .alert(item: $confirm) { p in
            Alert(title: Text(Self.confirmTitle(p)), message: Text(Self.confirmBody(p)),
                  primaryButton: .destructive(Text(Self.confirmButton(p))) { Task { await vm.perform(p.action, serviceId: p.serviceId) } },
                  secondaryButton: .cancel())
        }
    }

    // MARK: finding

    @ViewBuilder
    private func finding(_ c: FSColors) -> some View {
        Text("Use your server without Flagship")
            .font(FS.font.scaled(22, weight: .semibold))
            .foregroundColor(c.text)
            .accessibilityAddTraits(.isHeader)
        Text("When Flagship or the relay can't be reached, this phone can still reach your server on the same Wi-Fi. It checks the server by its own key, and every action is signed by this phone and checked by the server. Adding devices, unlocking the server's disk after a restart, and changes to your account still need Flagship.")
            .font(FS.font.bodySm())
            .foregroundColor(c.textMuted)
            .fixedSize(horizontal: false, vertical: true)
        if case .connecting(let d) = vm.phase {
            HStack(spacing: FS.space.s2) {
                ProgressView()
                Text("Checking \(d) by its own key…").foregroundColor(c.text)
            }
            .accessibilityIdentifier("offline-connecting")
        }
        if case .failed(let message) = vm.phase {
            Text(message)
                .font(FS.font.bodySm())
                .foregroundColor(c.danger)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("offline-error")
        }
        if let notice = vm.notice {
            Text(notice)
                .font(FS.font.bodySm())
                .foregroundColor(c.text)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("offline-notice")
        }
        FSSectionLabel(String(localized: "Your servers"))
        if vm.servers.isEmpty {
            Text("This phone doesn't know any of your servers yet. Enter one below.")
                .font(FS.font.bodySm()).foregroundColor(c.textMuted)
                .accessibilityIdentifier("offline-no-servers")
        }
        ForEach(vm.servers) { s in
            FSCard {
                VStack(alignment: .leading, spacing: FS.space.s2) {
                    HStack {
                        Image(systemName: "server.rack").foregroundColor(c.textMuted)
                        Text(s.label).font(FS.font.scaled(17, weight: .semibold)).foregroundColor(c.text)
                        Spacer()
                    }
                    Text(s.domain).font(FS.font.caption()).foregroundColor(c.textMuted)
                        .accessibilityIdentifier("offline-domain-\(s.label)")
                    Group {
                        if let f = s.found {
                            Text("Found on this Wi-Fi at \(f.display)")
                                .foregroundColor(c.success)
                                .accessibilityIdentifier("offline-found-\(s.label)")
                        } else if vm.searching {
                            Text("Looking for it on this Wi-Fi…")
                                .foregroundColor(c.textMuted)
                                .accessibilityIdentifier("offline-searching-\(s.label)")
                        }
                    }
                    .font(FS.font.bodySm())
                    if !s.pinned {
                        Text("This phone never confirmed this server's own key, so it can't check it here.")
                            .font(FS.font.caption()).foregroundColor(c.textMuted)
                    }
                    FSPrimaryButton(String(localized: "Connect"), block: true) { Task { await vm.connect(s.domain) } }
                        .disabled(!s.pinned || isConnecting)
                        .accessibilityIdentifier("offline-connect-\(s.label)")
                }
            }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("offline-server-\(s.label)")
        }
        FSSectionLabel(String(localized: "Not found? Enter its address"))
        Text("The server shows its local address on its own screen. Your router's list of devices has it too.")
            .font(FS.font.caption()).foregroundColor(c.textMuted)
            .fixedSize(horizontal: false, vertical: true)
        TextField(String(localized: "Server name, like home.alice.flagship.services"), text: $vm.manualName)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .keyboardType(.URL)
            .fsInputBox()
            .accessibilityIdentifier("offline-manual-name")
        TextField(String(localized: "Address, like 192.168.1.20"), text: $vm.manualAddress)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .keyboardType(.numbersAndPunctuation)
            .fsInputBox()
            .accessibilityIdentifier("offline-manual-address")
        FSSecondaryButton(String(localized: "Connect to this address"), block: true) { Task { await vm.connectManually() } }
            .disabled(!vm.canConnectManually || isConnecting)
            .accessibilityIdentifier("offline-manual-connect")
    }

    private var isConnecting: Bool {
        if case .connecting = vm.phase { return true }
        return false
    }

    // MARK: connected

    @ViewBuilder
    private func connected(_ c: FSColors) -> some View {
        let s = vm.snapshot
        HStack {
            Image(systemName: "checkmark.shield.fill").foregroundColor(c.success)
            Text("Connected to \(vm.serverDomain ?? "")")
                .font(FS.font.scaled(19, weight: .semibold))
                .foregroundColor(c.text)
                .accessibilityIdentifier("offline-connected-title")
        }
        Text("Checked by its own key on this Wi-Fi. Flagship wasn't needed.")
            .font(FS.font.caption()).foregroundColor(c.textMuted)
        if let note = vm.certificateNote {
            Text(note)
                .font(FS.font.bodySm())
                .foregroundColor(c.text)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("offline-cert-note")
        }
        if let notice = vm.notice {
            Text(notice).font(FS.font.bodySm()).foregroundColor(c.text)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("offline-notice")
        }
        if let err = vm.actionError {
            Text(err).font(FS.font.bodySm()).foregroundColor(c.danger)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("offline-action-error")
        }
        if let st = s?.status { statusCard(st, c) }
        FSSectionLabel(String(localized: "Apps"))
        if (s?.apps ?? []).isEmpty {
            Text("No apps on this server.").font(FS.font.bodySm()).foregroundColor(c.textMuted)
        }
        ForEach(s?.apps ?? []) { a in appRow(a, c) }
        if vm.offersControls {
            FSSectionLabel(String(localized: "Server"))
            Text("A restarted server needs Flagship to unlock its disk. While Flagship can't be reached, it stays locked after a restart, with your data safe on it.")
                .font(FS.font.caption()).foregroundColor(c.textMuted)
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: FS.space.s2) {
                FSSecondaryButton(String(localized: "Restart")) { confirm = Pending(action: .serverRestart, serviceId: nil, name: vm.serverDomain ?? "") }
                    .accessibilityIdentifier("offline-server-restart")
                FSDangerButton(String(localized: "Shut down")) { confirm = Pending(action: .serverShutdown, serviceId: nil, name: vm.serverDomain ?? "") }
                    .accessibilityIdentifier("offline-server-shutdown")
            }
            .disabled(vm.busy != nil)
        }
        FSSectionLabel(String(localized: "Rescue my data"))
        backupSection(c)
        Button("Disconnect") { vm.disconnect() }
            .font(FS.font.bodySm())
            .accessibilityIdentifier("offline-disconnect")
    }

    private func statusCard(_ st: RescueServerStatus, _ c: FSColors) -> some View {
        FSCard {
            VStack(alignment: .leading, spacing: FS.space.s1) {
                if let v = st.version { Text("Software \(v)").foregroundColor(c.text) }
                if let started = st.startedAt, started > 0 {
                    Text("Running since \(Date(timeIntervalSince1970: Double(started) / 1000).formatted(date: .abbreviated, time: .shortened))")
                        .foregroundColor(c.text)
                }
                if let used = st.diskUsedBytes, let total = st.diskTotalBytes, total > 0 {
                    Text("Disk: \(ServerArchive.formatBytes(used)) of \(ServerArchive.formatBytes(total)) used").foregroundColor(c.text)
                }
                if let until = st.certValidUntil, until > 0 {
                    let date = Date(timeIntervalSince1970: Double(until) / 1000)
                    Text(date < Date() ? String(localized: "Web certificate expired \(date.formatted(date: .abbreviated, time: .omitted))")
                                       : String(localized: "Web certificate valid until \(date.formatted(date: .abbreviated, time: .omitted))"))
                        .foregroundColor(c.textMuted)
                }
            }
            .font(FS.font.bodySm())
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("offline-status")
    }

    private func appRow(_ a: RescueServerApp, _ c: FSColors) -> some View {
        FSCard {
            VStack(alignment: .leading, spacing: FS.space.s2) {
                HStack {
                    Text(a.name).font(FS.font.scaled(16, weight: .semibold)).foregroundColor(c.text)
                    Spacer()
                    Text(Self.stateLabel(a.state))
                        .font(FS.font.caption())
                        .foregroundColor(a.state == "running" ? c.success : c.textMuted)
                        .accessibilityIdentifier("offline-app-state-\(a.serviceId)")
                }
                if vm.offersControls {
                    HStack(spacing: FS.space.s2) {
                        if a.state == "stopped" {
                            FSSecondaryButton(String(localized: "Start")) { Task { await vm.perform(.appStart, serviceId: a.serviceId) } }
                                .accessibilityIdentifier("offline-app-start-\(a.serviceId)")
                        } else {
                            FSSecondaryButton(String(localized: "Restart")) { confirm = Pending(action: .appRestart, serviceId: a.serviceId, name: a.name) }
                                .accessibilityIdentifier("offline-app-restart-\(a.serviceId)")
                            FSSecondaryButton(String(localized: "Stop")) { confirm = Pending(action: .appStop, serviceId: a.serviceId, name: a.name) }
                                .accessibilityIdentifier("offline-app-stop-\(a.serviceId)")
                        }
                        if vm.busy?.hasPrefix(a.serviceId + "|") == true { ProgressView() }
                    }
                    .disabled(vm.busy != nil)
                }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("offline-app-\(a.serviceId)")
    }

    @ViewBuilder
    private func backupSection(_ c: FSColors) -> some View {
        switch vm.backup {
        case .idle:
            Text("Make a backup of this server and save it on this phone. To bring it back, make a new account and use Add a server, Import a backup.")
                .font(FS.font.bodySm()).foregroundColor(c.textMuted)
                .fixedSize(horizontal: false, vertical: true)
            FSPrimaryButton(String(localized: "Rescue my data"), block: true) { vm.askPasscode() }
                .accessibilityIdentifier("offline-rescue")
        case .passcode:
            passcodeStep(c)
        case .building(let label, let fraction):
            VStack(alignment: .leading, spacing: FS.space.s2) {
                Text(label).foregroundColor(c.text)
                ProgressView(value: fraction)
            }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("offline-backup-progress")
        case .downloading(let fraction):
            VStack(alignment: .leading, spacing: FS.space.s2) {
                Text("Downloading… \(Int(fraction * 100)) %").foregroundColor(c.text)
                ProgressView(value: fraction)
            }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("offline-backup-downloading")
        case .interrupted(_, let message):
            VStack(alignment: .leading, spacing: FS.space.s2) {
                Text(message).font(FS.font.bodySm()).foregroundColor(c.danger)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("offline-backup-interrupted")
                FSPrimaryButton(String(localized: "Resume the download"), block: true) { Task { await vm.download() } }
                    .accessibilityIdentifier("offline-backup-resume")
            }
        case .saved(let url):
            VStack(alignment: .leading, spacing: FS.space.s2) {
                Text("Your data is saved in one .flagship file. Keep it somewhere safe: Files, iCloud Drive, a USB drive, or AirDrop it to a computer. To restore it, make a new account and use Add a server, Import a backup, with its passcode.")
                    .foregroundColor(c.text)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("offline-backup-saved")
                Label(url.lastPathComponent, systemImage: "doc").font(FS.font.caption()).foregroundColor(c.textMuted)
                ShareLink(item: url) { Label("Save the backup…", systemImage: "square.and.arrow.up") }
                    .accessibilityIdentifier("offline-backup-share")
            }
        case .failed(let message):
            VStack(alignment: .leading, spacing: FS.space.s2) {
                Text(message).foregroundColor(c.danger)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("offline-backup-error")
                FSSecondaryButton(String(localized: "Try again"), block: true) { vm.askPasscode() }
            }
        }
    }

    @ViewBuilder
    private func passcodeStep(_ c: FSColors) -> some View {
        VStack(alignment: .leading, spacing: FS.space.s3) {
            Text("Set the backup's passcode").font(FS.font.h4()).foregroundColor(c.text)
            Text(ServerArchive.passcodeWhy).font(FS.font.bodySm()).foregroundColor(c.text)
                .fixedSize(horizontal: false, vertical: true)
            Text(ServerArchive.passcodeNote).font(FS.font.bodySm()).foregroundColor(c.textMuted)
                .fixedSize(horizontal: false, vertical: true)
            if vm.useOwnPasscode {
                SecureField("Your passcode", text: $vm.ownPasscode)
                    .textContentType(.newPassword).textInputAutocapitalization(.never).autocorrectionDisabled().fsInputBox()
                SecureField("Type it again", text: $vm.ownPasscodeAgain)
                    .textContentType(.newPassword).textInputAutocapitalization(.never).autocorrectionDisabled().fsInputBox()
                if let hint = vm.ownPasscodeHint { Text(hint).font(FS.font.caption()).foregroundColor(c.textMuted) }
                Button("Use the suggested passcode") { vm.useOwnPasscode = false }.font(FS.font.bodySm())
            } else {
                FSCard {
                    VStack(alignment: .leading, spacing: FS.space.s2) {
                        FSSectionLabel(String(localized: "Suggested passcode"))
                        Text(vm.suggestedPasscode)
                            .font(FS.font.scaled(20, weight: .semibold, design: .monospaced))
                            .foregroundColor(c.text)
                            .textSelection(.enabled)
                            .accessibilityIdentifier("offline-backup-passcode")
                        Button(copied ? String(localized: "Copied") : "Copy") {
                            UIPasteboard.general.string = vm.suggestedPasscode
                            copied = true
                        }
                        .font(FS.font.bodySm())
                    }
                }
                Button("Use my own passcode instead") { vm.useOwnPasscode = true }.font(FS.font.bodySm())
            }
            Toggle("I've saved the passcode somewhere safe", isOn: $vm.passcodeSaved)
                .font(FS.font.bodySm())
                .accessibilityIdentifier("offline-backup-passcode-saved")
            FSPrimaryButton(String(localized: "Make and download the backup"), block: true) { Task { await vm.startBackup() } }
                .disabled(!vm.canStartBackup)
                .accessibilityIdentifier("offline-backup-start")
        }
    }

    // MARK: words

    static func stateLabel(_ s: String) -> String {
        switch s {
        case "running": return String(localized: "Running")
        case "starting": return String(localized: "Starting")
        case "stopped": return String(localized: "Stopped")
        default: return String(localized: "Unknown")
        }
    }

    static func confirmTitle(_ p: Pending) -> String {
        switch p.action {
        case .appStop: return String(localized: "Stop \(p.name)?")
        case .appRestart: return String(localized: "Restart \(p.name)?")
        case .appStart: return String(localized: "Start \(p.name)?")
        case .serverRestart: return String(localized: "Restart the server?")
        case .serverShutdown: return String(localized: "Shut down the server?")
        }
    }

    static func confirmBody(_ p: Pending) -> String {
        switch p.action {
        case .appStop: return String(localized: "People using it lose it until you start it again. Its data stays.")
        case .appRestart, .appStart: return String(localized: "It's back in a moment.")
        case .serverRestart: return String(localized: "While Flagship can't be reached, the server can't unlock its disk after the restart, so it and its apps stay off until Flagship is back. Your data stays safe on it.")
        case .serverShutdown: return String(localized: "It stays off until someone turns it on. Turning it on needs Flagship to unlock its disk.")
        }
    }

    static func confirmButton(_ p: Pending) -> String {
        switch p.action {
        case .appStop: return String(localized: "Stop")
        case .appRestart, .serverRestart: return String(localized: "Restart")
        case .appStart: return String(localized: "Start")
        case .serverShutdown: return String(localized: "Shut down")
        }
    }
}

/// Builds the screen's view model for the signed-in account (or the gone one).
struct OfflineControlContainer: View {
    let username: String
    let focus: String?
    @State private var vm: OfflineControlViewModel?

    var body: some View {
        Group {
            if let vm { OfflineControlScreen(vm: vm) } else { ProgressView() }
        }
        .task {
            if vm == nil { vm = OfflineControlViewModel(username: username, focus: focus, env: .live(username: username)) }
        }
    }
}
