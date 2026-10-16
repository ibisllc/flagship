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
        .task { await vm.start() }
    }

    @ViewBuilder
    private func content(_ c: FSColors) -> some View {
        switch vm.phase {
        case .idle:
            ProgressView()
        case .building(let label, let fraction):
            VStack(alignment: .leading, spacing: FS.space.s2) {
                Text(label).foregroundColor(c.text)
                ProgressView(value: fraction)
            }
        case .ready(let bytes):
            VStack(alignment: .leading, spacing: FS.space.s2) {
                Text("Backup ready (\(ServerArchive.formatBytes(bytes))). Save it somewhere safe.").foregroundColor(c.text)
                if !vm.leftOut.isEmpty {
                    Text("Left out (no source to rebuild them from): \(vm.leftOut.joined(separator: ", ")).")
                        .font(FS.font.caption()).foregroundColor(c.danger)
                }
                FSPrimaryButton("Download backup", block: true) { Task { await vm.download() } }
                    .accessibilityIdentifier("backup-download")
            }
        case .downloading(let fraction):
            VStack(alignment: .leading, spacing: FS.space.s2) {
                Text("Downloading…").foregroundColor(c.text)
                ProgressView(value: fraction)
            }
        case .saved(let url):
            VStack(alignment: .leading, spacing: FS.space.s2) {
                Text("Downloaded. The server has removed its copy. Save the file to Files, AirDrop it, or send it to yourself.")
                    .foregroundColor(c.text)
                ShareLink(item: url) { Label("Save backup…", systemImage: "square.and.arrow.up") }
                    .accessibilityIdentifier("backup-share")
            }
        case .failed(let message):
            VStack(alignment: .leading, spacing: FS.space.s2) {
                Text(message).foregroundColor(c.danger)
                FSSecondaryButton("Try again", block: true) { Task { await vm.start() } }
            }
        }
    }
}

/// The chooser Home's "Add/Import a server" opens, and the import itself.
struct ImportBackupSheet: View {
    @Environment(\.colorScheme) private var scheme
    @State var vm: ImportBackupViewModel
    @State private var picking = false

    var body: some View {
        let c = FSColors.scheme(scheme)
        ScrollView {
            VStack(alignment: .leading, spacing: FS.space.s4) {
                Text("Import a backup")
                    .font(.system(size: 22, weight: .semibold))
                    .foregroundColor(c.text)
                Text(ServerArchive.cloneHint)
                    .font(FS.font.caption())
                    .foregroundColor(c.textMuted)
                if vm.targets.isEmpty {
                    Text("No server of yours is online right now. Add the new server first, wait for it to come online, then import.")
                        .foregroundColor(c.danger)
                } else {
                    body(c)
                }
            }
            .padding(FS.space.s4)
        }
        .background(c.bg.ignoresSafeArea())
        .fileImporter(isPresented: $picking, allowedContentTypes: [.data]) { result in
            if case .success(let url) = result { vm.choose(url) }
        }
    }

    @ViewBuilder
    private func body(_ c: FSColors) -> some View {
        switch vm.phase {
        case .picking:
            filePicker(c)
        case .chosen(let header, let bytes):
            VStack(alignment: .leading, spacing: FS.space.s3) {
                Text("From \(header.sourceServer.isEmpty ? "a server" : header.sourceServer): \(header.appNames.isEmpty ? "no apps" : header.appNames.joined(separator: ", ")) (\(ServerArchive.formatBytes(bytes))).")
                    .foregroundColor(c.text)
                Picker("Import onto", selection: $vm.selectedFqdn) {
                    ForEach(vm.targets) { t in Text(t.label).tag(Optional(t.fqdn)) }
                }
                Text("Apps already on that server are left alone. Apps are installed under that server's own name.")
                    .font(FS.font.caption())
                    .foregroundColor(c.textMuted)
                FSPrimaryButton("Import", block: true) { Task { await vm.startImport() } }
                    .accessibilityIdentifier("import-backup-go")
                FSSecondaryButton("Choose another file", block: true) { picking = true }
            }
        case .uploading(let fraction):
            VStack(alignment: .leading, spacing: FS.space.s2) {
                Text("Sending the backup to the server…").foregroundColor(c.text)
                ProgressView(value: fraction)
            }
        case .restoring(let apps):
            VStack(alignment: .leading, spacing: FS.space.s2) {
                Text("Restoring the apps…").foregroundColor(c.text)
                ProgressView()
                ForEach(apps, id: \.serviceId) { Text(ImportBackupViewModel.describe($0)).font(FS.font.caption()).foregroundColor(c.textMuted) }
            }
        case .done(let apps):
            VStack(alignment: .leading, spacing: FS.space.s2) {
                Text("Import finished.").foregroundColor(c.text)
                ForEach(apps, id: \.serviceId) { Text(ImportBackupViewModel.describe($0)).font(FS.font.caption()).foregroundColor(c.textMuted) }
            }
        case .failed(let message):
            VStack(alignment: .leading, spacing: FS.space.s2) {
                Text(message).foregroundColor(c.danger)
                FSSecondaryButton("Try again", block: true) { vm.retry() }
            }
        }
    }

    @ViewBuilder
    private func filePicker(_ c: FSColors) -> some View {
        VStack(alignment: .leading, spacing: FS.space.s2) {
            FSPrimaryButton("Choose backup file", block: true) { picking = true }
                .accessibilityIdentifier("import-backup-choose")
            if let e = vm.fileError { Text(e).foregroundColor(c.danger) }
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
                Text("The file opens only on your own devices, but anyone at that browser can save it.")
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
                    Text("Approved. The download starts in that browser.").foregroundColor(c.success)
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
