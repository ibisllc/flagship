import SwiftUI
import UniformTypeIdentifiers
import FlagshipAPI
import FlagshipCore

/// "Backup/clone server" button in the server page's Backup / Migrate card
/// (docs/server-backup-and-clone.md).
struct ServerBackupButton: View {
    @Environment(\.podScreensClients) private var clients

    let serverDomain: String
    @State private var showSheet = false

    var body: some View {
        FSPrimaryButton("Backup/clone server", block: true) { showSheet = true }
            .accessibilityIdentifier("sd-backup-server")
            .sheet(isPresented: $showSheet) {
                NavigationStack {
                    ServerBackupSheet(vm: ServerBackupViewModel(serverFqdn: serverDomain, clients: clients))
                        .toolbar {
                            ToolbarItem(placement: .cancellationAction) { Button("Done") { showSheet = false } }
                        }
                }
            }
    }
}

struct ServerBackupSheet: View {
    @Environment(\.colorScheme) private var scheme
    @State var vm: ServerBackupViewModel
    @State private var copied = false

    var body: some View {
        let c = FSColors.scheme(scheme)
        ScrollView {
            VStack(alignment: .leading, spacing: FS.space.s4) {
                Text("Backup/clone server")
                    .font(.system(size: 22, weight: .semibold))
                    .foregroundColor(c.text)
                content(c)
                Text(ServerArchive.excludesNote)
                    .font(FS.font.caption())
                    .foregroundColor(c.textMuted)
            }
            .padding(FS.space.s4)
        }
        .background(c.bg.ignoresSafeArea())
        .task { await vm.load() }
    }

    @ViewBuilder
    private func content(_ c: FSColors) -> some View {
        switch vm.phase {
        case .checking:
            ProgressView()
        case .passcode:
            passcodeStep(c)
        case .building(let label, let fraction):
            VStack(alignment: .leading, spacing: FS.space.s2) {
                Text(label).foregroundColor(c.text)
                ProgressView(value: fraction)
            }
        case .ready(let bytes):
            VStack(alignment: .leading, spacing: FS.space.s2) {
                Text("Backup ready: two files, \(ServerArchive.formatBytes(bytes)) in all. Keep them together.").foregroundColor(c.text)
                if !vm.leftOut.isEmpty {
                    Text("Left out (no source to rebuild them from): \(vm.leftOut.joined(separator: ", ")).")
                        .font(FS.font.caption()).foregroundColor(c.danger)
                }
                FSPrimaryButton("Download both files", block: true) { Task { await vm.download() } }
                    .accessibilityIdentifier("backup-download")
            }
        case .downloading(let fraction):
            VStack(alignment: .leading, spacing: FS.space.s2) {
                Text("Downloading…").foregroundColor(c.text)
                ProgressView(value: fraction)
            }
        case .saved(let urls):
            VStack(alignment: .leading, spacing: FS.space.s2) {
                Text("Downloaded. The server has removed its copy. Save both files together: to Files (a folder on this phone, iCloud Drive or a USB drive), or AirDrop them to a computer.")
                    .foregroundColor(c.text)
                ForEach(urls, id: \.self) { u in
                    Label(u.lastPathComponent, systemImage: "doc").font(FS.font.caption()).foregroundColor(c.textMuted)
                }
                ShareLink(items: urls) { Label("Save both files…", systemImage: "square.and.arrow.up") }
                    .accessibilityIdentifier("backup-share")
            }
        case .failed(let message):
            VStack(alignment: .leading, spacing: FS.space.s2) {
                Text(message).foregroundColor(c.danger)
                FSSecondaryButton("Try again", block: true) { vm.tryAgain() }
            }
        }
    }

    @ViewBuilder
    private func passcodeStep(_ c: FSColors) -> some View {
        VStack(alignment: .leading, spacing: FS.space.s3) {
            Text("Set the backup's passcode").font(FS.font.h4()).foregroundColor(c.text)
            Text(ServerArchive.passcodeNote).font(FS.font.bodySm()).foregroundColor(c.textMuted)
            if vm.useOwnPasscode {
                SecureField("Your passcode", text: $vm.ownPasscode)
                    .textContentType(.newPassword)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .padding(FS.space.s3)
                    .background(RoundedRectangle(cornerRadius: FS.radius.sm).stroke(c.border))
                    .accessibilityIdentifier("backup-own-passcode")
                SecureField("Type it again", text: $vm.ownPasscodeAgain)
                    .textContentType(.newPassword)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .padding(FS.space.s3)
                    .background(RoundedRectangle(cornerRadius: FS.radius.sm).stroke(c.border))
                if let hint = vm.ownPasscodeHint {
                    Text(hint).font(FS.font.caption()).foregroundColor(c.textMuted)
                }
                Button("Use the suggested passcode") { vm.useOwnPasscode = false }
                    .font(FS.font.bodySm())
            } else {
                FSCard {
                    VStack(alignment: .leading, spacing: FS.space.s2) {
                        Text("SUGGESTED PASSCODE").font(.system(size: 11, weight: .semibold)).tracking(1).foregroundColor(c.textMuted)
                        Text(vm.suggestedPasscode)
                            .font(.system(size: 20, weight: .semibold, design: .monospaced))
                            .foregroundColor(c.text)
                            .textSelection(.enabled)
                            .accessibilityIdentifier("backup-suggested-passcode")
                        Button(copied ? "Copied" : "Copy") {
                            UIPasteboard.general.string = vm.suggestedPasscode
                            copied = true
                        }
                        .font(FS.font.bodySm())
                    }
                }
                Button("Use my own passcode instead") { vm.useOwnPasscode = true }
                    .font(FS.font.bodySm())
                    .accessibilityIdentifier("backup-use-own-passcode")
            }
            Toggle("I've saved the passcode somewhere safe", isOn: $vm.passcodeSaved)
                .font(FS.font.bodySm())
                .accessibilityIdentifier("backup-passcode-saved")
            FSPrimaryButton("Make the backup", block: true) { Task { await vm.start() } }
                .disabled(!vm.canStart)
                .accessibilityIdentifier("backup-start")
        }
    }
}

/// Home → Add/Import a server → Import a backup (or a waiting server's "Send
/// the backup"): builds the view model from the account's servers and hands
/// the create step to the existing create screen.
struct ImportBackupContainer: View {
    let targetFqdn: String?
    /// The create screen made a server (put it on Home like any new server).
    let onServerCreated: (_ serverDomain: String, _ serial: String, _ name: String) -> Void
    let onClose: () -> Void
    @Environment(\.flagshipServerClient) private var serverClient
    @Environment(\.qrRelayClient) private var qrRelay
    @Environment(\.secretMailboxClient) private var mailbox
    @Environment(\.sessionStore) private var sessionStore
    @Environment(\.podScreensClients) private var clients
    @Environment(AppState.self) private var app
    @State private var vm: ImportBackupViewModel?
    @State private var createVM: CreateServerViewModel?

    var body: some View {
        ZStack {
            FSColors.scheme(.light).bg.ignoresSafeArea()
            if let vm {
                if vm.phase == .creating, let createVM {
                    CreateServerStubScreen(
                        vm: createVM,
                        onDeliveredVisible: { serverDomain, name, _ in
                            onServerCreated(serverDomain, createVM.lastDeliveredSerial ?? "", name)
                            vm.send(to: serverDomain)
                        },
                        onDelivered: { serverDomain, _, _ in
                            vm.leaveCreate(fqdn: serverDomain)
                            self.createVM = nil
                        },
                        onCancel: {
                            vm.cancelCreate()
                            self.createVM = nil
                        }
                    )
                } else {
                    ImportBackupScreen(vm: vm, onClose: onClose)
                }
            } else {
                ProgressView()
            }
        }
        .onChange(of: vm?.phase) { _, phase in
            guard phase == .creating, createVM == nil, let target = vm?.createTarget else { return }
            let m = CreateServerViewModel(
                username: app.currentUser ?? "you",
                server: serverClient,
                relay: qrRelay,
                mailbox: mailbox,
                sessionStore: sessionStore,
                isDemoAccount: app.isDemoAccount
            )
            m.name = target.name
            m.bootUnlockMode = target.bootUnlockMode == "approve" ? .approve : .auto
            m.encryptDisk = target.diskEncryption != "none"
            m.restore = target.restore
            m.proceedToDelivery()
            createVM = m
        }
        .task {
            if vm == nil {
                let taken = Set(app.pods.compactMap { pod -> String? in
                    let label = pod.fqdn.split(separator: ".").first.map(String.init) ?? pod.name
                    return label.isEmpty ? nil : label.lowercased()
                })
                var waiting: [String: String] = [:]
                for (fqdn, w) in app.podsAwaitingBackup { waiting[w.archiveId] = fqdn }
                vm = ImportBackupViewModel(
                    username: app.currentUser ?? "you",
                    takenNames: taken,
                    waitingServers: waiting,
                    targetFqdn: targetFqdn,
                    clients: clients,
                    onRestored: { fqdn in app.podsAwaitingBackup[fqdn.lowercased()] = nil }
                )
            }
        }
        .onDisappear { vm?.stop() }
    }
}

/// The restore flow's own pages (the create step is the create screen).
struct ImportBackupScreen: View {
    @Environment(\.colorScheme) private var scheme
    @Bindable var vm: ImportBackupViewModel
    var onClose: () -> Void = {}
    @State private var picking = false

    var body: some View {
        let c = FSColors.scheme(scheme)
        ScrollView {
            VStack(alignment: .leading, spacing: FS.space.s4) {
                content(c)
                if let e = vm.fileError {
                    Text(e).foregroundColor(c.danger).accessibilityIdentifier("import-backup-error")
                }
            }
            .padding(FS.space.s4)
            .fsReadingColumn()
        }
        .background(c.bg.ignoresSafeArea())
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .fileImporter(isPresented: $picking, allowedContentTypes: [.data], allowsMultipleSelection: true) { result in
            if case .success(let urls) = result { Task { await vm.choose(urls) } }
        }
    }

    private var title: String {
        switch vm.phase {
        case .waiting, .sending, .restoring, .done: return "Restore a backup"
        default: return "Import a backup"
        }
    }

    private func serverName(_ fqdn: String) -> String {
        fqdn.split(separator: ".").first.map(String.init) ?? fqdn
    }

    @ViewBuilder
    private func content(_ c: FSColors) -> some View {
        switch vm.phase {
        case .pick:
            VStack(alignment: .leading, spacing: FS.space.s3) {
                Text(vm.targetFqdn.map { "\(serverName($0)) is waiting for its backup. Pick the backup's two files and this screen sends it." } ?? ServerArchive.importIntro)
                    .font(FS.font.body())
                    .foregroundColor(c.textMuted)
                FSCard {
                    Text(vm.filesSummary).font(FS.font.bodySm()).foregroundColor(c.text)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .accessibilityIdentifier("import-backup-files")
                }
                FSPrimaryButton(vm.backupFileName == nil && vm.dataFileName == nil ? "Choose the backup files" : "Choose the other file", block: true) {
                    // Gym: the system file picker can't be driven, so a
                    // smoke launch hands over its fixture files instead.
                    if let urls = GymSweepSeams.importArchiveURLs { Task { await vm.choose(urls) } } else { picking = true }
                }
                    .accessibilityIdentifier("import-backup-choose")
                Text("You can pick both at once. They're read where they are; nothing is copied onto this phone.")
                    .font(FS.font.caption())
                    .foregroundColor(c.textMuted)
            }
        case .passcode:
            VStack(alignment: .leading, spacing: FS.space.s3) {
                Text("This backup was made on another account. Enter its passcode to open it.")
                    .foregroundColor(c.text)
                SecureField("Passcode", text: $vm.passcode)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .padding(FS.space.s3)
                    .background(RoundedRectangle(cornerRadius: FS.radius.sm).stroke(c.border))
                    .accessibilityIdentifier("import-backup-passcode")
                FSPrimaryButton("Open the backup", block: true) { Task { await vm.unlock() } }
                    .disabled(vm.passcode.isEmpty)
                    .accessibilityIdentifier("import-backup-unlock")
            }
        case .opening:
            HStack(spacing: FS.space.s2) { ProgressView(); Text("Opening the backup…").foregroundColor(c.text) }
        case .checking(let fraction):
            VStack(alignment: .leading, spacing: FS.space.s2) {
                summary(c)
                Text("Checking the data file…").foregroundColor(c.text)
                ProgressView(value: fraction)
            }
        case .chooseTarget(let fqdn):
            VStack(alignment: .leading, spacing: FS.space.s3) {
                summary(c)
                Text("\(serverName(fqdn)) is waiting for this backup.").foregroundColor(c.text)
                FSPrimaryButton("Send it to \(serverName(fqdn))", block: true) { vm.send(to: fqdn) }
                    .accessibilityIdentifier("import-backup-send-existing")
                FSSecondaryButton("Create a new server instead", block: true) { vm.showName() }
            }
        case .name:
            VStack(alignment: .leading, spacing: FS.space.s3) {
                summary(c)
                FSField(value: $vm.name, label: "Name of the new server", placeholder: "home", error: vm.nameProblem)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .accessibilityIdentifier("import-backup-name")
                if vm.nameProblem == nil && !vm.name.isEmpty {
                    Text(vm.previewFqdn).font(.system(size: 13, design: .monospaced)).foregroundColor(c.textMuted)
                }
                if let s = vm.settingsLine {
                    Text(s).font(FS.font.bodySm()).foregroundColor(c.textMuted)
                }
                FSPrimaryButton("Create the server", block: true) { vm.create() }
                    .disabled(!vm.canCreate)
                    .accessibilityIdentifier("import-backup-create")
                Text("Next you choose how to set it up (Flagship Studio, a recipe file, a USB stick), like any new server.")
                    .font(FS.font.caption())
                    .foregroundColor(c.textMuted)
            }
        case .creating:
            ProgressView()
        case .waiting(let fqdn):
            VStack(alignment: .leading, spacing: FS.space.s3) {
                HStack(spacing: FS.space.s2) { ProgressView(); Text("Waiting for \(serverName(fqdn)) to come online…").foregroundColor(c.text) }
                Text("Set it up with the recipe if you haven't yet. Keep this screen open: the backup goes as soon as the server is up. If you leave, \(serverName(fqdn)) keeps waiting and shows on Home with Send the backup.")
                    .font(FS.font.bodySm())
                    .foregroundColor(c.textMuted)
            }
            .accessibilityIdentifier("import-backup-waiting")
        case .sending(let fqdn, let fraction):
            VStack(alignment: .leading, spacing: FS.space.s2) {
                Text("Sending the backup to \(serverName(fqdn))…").foregroundColor(c.text)
                ProgressView(value: fraction)
                Text("Keep this screen open. If it stops, it picks up where it left off.")
                    .font(FS.font.caption()).foregroundColor(c.textMuted)
            }
        case .restoring(let fqdn, let apps):
            VStack(alignment: .leading, spacing: FS.space.s2) {
                Text("Restoring the apps on \(serverName(fqdn))…").foregroundColor(c.text)
                ProgressView()
                ForEach(apps, id: \.serviceId) { Text(ImportBackupViewModel.describe($0)).font(FS.font.caption()).foregroundColor(c.textMuted) }
            }
        case .done(let fqdn, let apps):
            VStack(alignment: .leading, spacing: FS.space.s3) {
                Text("\(serverName(fqdn)) is restored.").font(FS.font.h4()).foregroundColor(c.success)
                ForEach(apps, id: \.serviceId) { Text(ImportBackupViewModel.describe($0)).font(FS.font.bodySm()).foregroundColor(c.textMuted) }
                FSPrimaryButton("Done", block: true) { onClose() }
                    .accessibilityIdentifier("import-backup-done")
            }
        case .failed(let message, let keepsWaiting):
            VStack(alignment: .leading, spacing: FS.space.s3) {
                Text(message).foregroundColor(c.danger)
                if keepsWaiting {
                    Text("The server keeps waiting for its backup. Pick the backup again from Home to send it, or delete the server there.")
                        .font(FS.font.bodySm())
                        .foregroundColor(c.textMuted)
                }
                FSSecondaryButton("Close", block: true) { onClose() }
            }
        }
    }

    @ViewBuilder
    private func summary(_ c: FSColors) -> some View {
        if let s = vm.summary {
            Text(s).font(FS.font.bodySm()).foregroundColor(c.textMuted)
        }
    }
}

/// Opened by the QR on a backup's browser download page.
struct BackupDownloadApprovalScreen: View {
    @Environment(\.colorScheme) private var scheme
    @State var vm: BackupDownloadApprovalViewModel
    var onDone: () -> Void = {}

    var body: some View {
        let c = FSColors.scheme(scheme)
        ScrollView {
            VStack(alignment: .leading, spacing: FS.space.s4) {
                Text("Download a backup in a browser?")
                    .font(.system(size: 22, weight: .semibold))
                    .foregroundColor(c.text)
                Text("A browser is asking to download the backup of \(vm.serverFqdn). Approve only if this code is on the page in front of you:")
                    .foregroundColor(c.textMuted)
                Text(vm.code)
                    .font(.system(size: 34, weight: .semibold, design: .monospaced))
                    .tracking(6)
                    .foregroundColor(c.text)
                    .accessibilityIdentifier("backup-approve-code")
                Text("The backup opens only with its passcode or on your own devices, but anyone at that browser can save the files.")
                    .font(FS.font.caption())
                    .foregroundColor(c.textMuted)
                switch vm.phase {
                case .idle, .working:
                    FSPrimaryButton(vm.phase == .working ? "Approving…" : "Approve with Face ID", block: true) {
                        Task { await vm.approve() }
                    }
                    .disabled(vm.phase == .working)
                    .accessibilityIdentifier("backup-approve")
                    FSSecondaryButton("Don't approve", block: true) { onDone() }
                case .approved:
                    Text("Approved. The downloads start in that browser.").foregroundColor(c.success)
                    FSPrimaryButton("Done", block: true) { onDone() }
                case .failed(let message):
                    Text(message).foregroundColor(c.danger)
                    FSSecondaryButton("Try again", block: true) { Task { await vm.approve() } }
                }
            }
            .padding(FS.space.s4)
        }
        .background(c.bg.ignoresSafeArea())
    }
}
