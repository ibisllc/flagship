import SwiftUI
import FlagshipAPI
import FlagshipCore
import Flagship

/// Free space on this phone, as iOS counts it for things the user asked for.
enum DeviceStorage {
    static func freeBytes() -> Int64 {
        let home = URL(fileURLWithPath: NSHomeDirectory())
        let v = try? home.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey])
        return v?.volumeAvailableCapacityForImportantUsage ?? 0
    }
}

/// The three backup policies with their words (the same on all three apps),
/// and the reserve for a phone-side server. Used by the create form and the
/// server page's "Change".
struct BackupPolicyOptions: View {
    @Environment(\.colorScheme) private var scheme
    /// nil until the owner picks: nothing is preselected.
    @Binding var policy: CreateServerDraftStore.BackupPolicy?
    @Binding var reserveBytes: Int64
    /// Accessibility id prefix (`cs-backup-policy` on the create form).
    var idPrefix = "backup-policy"
    var freeBytes: Int64 = DeviceStorage.freeBytes()

    static let pickHint = "Pick one to continue. You can change it any time in the server's Backups section."
    static let noneText = "Nothing is copied. You can turn backups on later."
    static let phoneText = "An encrypted copy is kept on this phone."
    static let peerText = "Encrypted pieces are kept on other Flagship servers, and yours keeps theirs."

    private static let gb: Int64 = 1 << 30

    var body: some View {
        let c = FSColors.scheme(scheme)
        VStack(alignment: .leading, spacing: FS.space.s2) {
            option(.none, "No backup", Self.noneText, c: c)
            option(.phoneOnly, "On my phone", Self.phoneText, c: c)
            if policy == .phoneOnly { reservePicker(c) }
            option(.peer, "On other servers", Self.peerText, c: c)
        }
    }

    private func reservePicker(_ c: FSColors) -> some View {
        let gbs = Binding<Int>(
            get: { Int(max(1, reserveBytes / Self.gb)) },
            set: { reserveBytes = Int64($0) * Self.gb }
        )
        return VStack(alignment: .leading, spacing: 4) {
            Stepper(value: gbs, in: 1...4096) {
                Text("Keep \(gbs.wrappedValue) GB on this phone")
                    .font(.subheadline.weight(.medium))
                    .foregroundColor(c.text)
            }
            .accessibilityIdentifier("\(idPrefix)-reserve")
            Text("This phone has \(ServerArchive.formatBytes(freeBytes)) free.")
                .font(.caption)
                .foregroundColor(c.textMuted)
        }
        .padding(.horizontal, FS.space.s3)
    }

    private func option(_ p: CreateServerDraftStore.BackupPolicy, _ title: String, _ subtitle: String,
                        warning: Bool = false, c: FSColors) -> some View {
        let selected = policy == p
        let accent = warning ? c.warning : c.accent
        return Button {
            policy = p
        } label: {
            HStack(alignment: .top, spacing: FS.space.s3) {
                Image(systemName: selected ? "largecircle.fill.circle" : "circle")
                    .foregroundColor(selected ? accent : c.textMuted)
                    .padding(.top, 2)
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 6) {
                        if warning { Image(systemName: "exclamationmark.triangle.fill").foregroundColor(c.warning).font(.caption) }
                        Text(title).font(.subheadline.weight(.medium)).foregroundColor(c.text)
                    }
                    Text(subtitle).font(.caption).foregroundColor(warning && selected ? c.warning : c.textMuted)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 0)
            }
            .padding(FS.space.s3)
            .background(
                RoundedRectangle(cornerRadius: FS.radius.md, style: .continuous)
                    .stroke(selected ? accent : c.border, lineWidth: selected ? 2 : 1)
            )
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("\(idPrefix)-\(p.rawValue)")
    }
}

/// The server page's Backups section (docs/server-backup-and-clone.md): the
/// backup policy and the limit it sets, the schedule, the saved backups and
/// Back up now into the list, this phone's copy, then the one-off
/// Back up now (with a passcode) and Migrate buttons.
struct ServerBackupsSection: View {
    @Environment(\.colorScheme) private var scheme
    @Environment(\.podScreensClients) private var clients
    @Environment(AppState.self) private var app

    let serverDomain: String
    @State private var vm: ServerBackupsViewModel?

    var body: some View {
        let c = FSColors.scheme(scheme)
        VStack(alignment: .leading, spacing: FS.space.s3) {
            FSSectionLabel("Backups")
            if let vm {
                ServerBackupsCard(vm: vm)
            }
            // One-off backup and Migrate are admin orders: another device
            // doesn't get buttons the box would refuse (the card above says why).
            if AdminOrderGate.allows(app) {
                FSCard {
                    VStack(alignment: .leading, spacing: FS.space.s2) {
                        ServerBackupButton(serverDomain: serverDomain)
                        MigrateServerButton(serverDomain: serverDomain)
                    }
                }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("sd-backups-section")
        .task(id: serverDomain) {
            let m = vm ?? ServerBackupsViewModel(serverFqdn: serverDomain, isAdminDevice: AddServerGate.allows(app), clients: clients)
            vm = m
            await m.start()
        }
        .onDisappear { vm?.stop() }
    }
}

struct ServerBackupsCard: View {
    @Environment(\.colorScheme) private var scheme
    @Bindable var vm: ServerBackupsViewModel
    @State private var editingSchedule = false
    @State private var editingPolicy = false
    @State private var deleting: SavedBackup?

    var body: some View {
        let c = FSColors.scheme(scheme)
        FSCard {
            VStack(alignment: .leading, spacing: FS.space.s3) {
                switch vm.load {
                case .loading:
                    HStack(spacing: FS.space.s2) { ProgressView(); Text("Checking backups…").foregroundColor(c.textMuted) }
                case .unavailable:
                    policyBlock(c)
                    Text("This server's release doesn't keep backups yet. Update it to get scheduled backups.")
                        .font(FS.font.bodySm()).foregroundColor(c.textMuted)
                case .failed(let why):
                    Text(why).font(FS.font.bodySm()).foregroundColor(c.danger)
                        .accessibilityIdentifier("sd-backups-load-error")
                case .loaded:
                    policyBlock(c)
                    Divider()
                    statusBlock(c)
                    if vm.scheduleShown { scheduleBlock(c) }
                    runBlock(c)
                    if !vm.isAdminDevice {
                        Text(ServerBackupsViewModel.adminOnly)
                            .font(FS.font.caption()).foregroundColor(c.textMuted)
                            .accessibilityIdentifier("sd-backups-admin-only")
                    }
                    listBlock(c)
                    if vm.phoneCopyShown { phoneBlock(c) }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .sheet(isPresented: $editingSchedule) {
            NavigationStack { BackupScheduleEditor(vm: vm, onDone: { editingSchedule = false }) }
        }
        .sheet(isPresented: $editingPolicy) {
            NavigationStack { BackupPolicyEditor(vm: vm, onDone: { editingPolicy = false }) }
        }
        .alert("Delete this backup from the server?", isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } })) {
            Button("Delete", role: .destructive) {
                if let b = deleting { Task { await vm.delete(b) } }
                deleting = nil
            }
            .accessibilityIdentifier("sd-backup-delete-confirm")
            Button("Cancel", role: .cancel) { deleting = nil }
        } message: {
            if let b = deleting { Text("The backup from \(Date(timeIntervalSince1970: Double(b.createdAt) / 1000).formatted(date: .abbreviated, time: .shortened)) is removed from the server. Copies you saved stay.") }
        }
    }

    // MARK: Policy

    @ViewBuilder
    private func policyBlock(_ c: FSColors) -> some View {
        VStack(alignment: .leading, spacing: FS.space.s2) {
            HStack(alignment: .firstTextBaseline) {
                Text(vm.policyLine)
                    .font(FS.font.scaled(15, weight: .semibold))
                    .foregroundColor(c.text)
                    .accessibilityIdentifier("sd-backups-policy")
                Spacer()
                Button(vm.policyKind == "unset" ? "Choose" : "Change") { editingPolicy = true }
                    .font(FS.font.bodySm())
                    .disabled(!vm.isAdminDevice)
                    .accessibilityIdentifier("sd-backups-policy-change")
            }
            if let usage = vm.usageLine {
                if let f = vm.usageFraction {
                    ProgressView(value: f)
                        .tint(vm.overLimitLine != nil ? c.danger : c.accent)
                }
                Text(usage).font(FS.font.caption()).foregroundColor(c.textMuted)
                    .accessibilityIdentifier("sd-backups-usage")
            }
            ForEach(Array(vm.storageNotes.enumerated()), id: \.offset) { i, note in
                Text(note).font(FS.font.caption()).foregroundColor(c.danger)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("sd-backups-storage-\(i)")
            }
            if let over = vm.overLimitLine {
                Text(over).font(FS.font.bodySm()).foregroundColor(c.danger)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("sd-backups-over-limit")
            }
            if !vm.peerLines.isEmpty {
                VStack(alignment: .leading, spacing: 2) {
                    ForEach(vm.peerLines, id: \.self) { Text($0).font(FS.font.caption()).foregroundColor(c.textMuted) }
                }
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier("sd-backups-peer")
            }
        }
    }

    // MARK: Status, next run, approval

    @ViewBuilder
    private func statusBlock(_ c: FSColors) -> some View {
        VStack(alignment: .leading, spacing: FS.space.s2) {
            HStack(spacing: FS.space.s2) {
                if vm.saved?.running != nil { ProgressView() }
                Text(vm.statusLine).font(FS.font.body()).foregroundColor(c.text)
                    .accessibilityIdentifier("sd-backups-status")
            }
            if let failed = vm.failedLine {
                Text(failed).font(FS.font.bodySm()).foregroundColor(c.danger)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("sd-backups-failed")
            }
            if let next = vm.nextLine {
                Text(next).font(FS.font.bodySm()).foregroundColor(c.textMuted)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("sd-backups-next")
            }
            if vm.needsApproval {
                FSPrimaryButton(vm.approving ? "Approving…" : "Approve backups for this server", block: true) {
                    Task { await vm.depositKeys() }
                }
                .disabled(vm.approving)
                .accessibilityIdentifier("sd-backups-approve")
                Text("One Face ID approves about a year of backups. The server can seal new backups with them, never open old ones.")
                    .font(FS.font.caption()).foregroundColor(c.textMuted)
            }
            if let e = vm.actionError {
                Text(e).font(FS.font.bodySm()).foregroundColor(c.danger)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("sd-backups-error")
            }
        }
    }

    // MARK: Schedule

    private func scheduleBlock(_ c: FSColors) -> some View {
        HStack(alignment: .firstTextBaseline) {
            Text(vm.scheduleLine())
                .font(FS.font.bodySm()).foregroundColor(c.text)
                .accessibilityIdentifier("sd-backups-schedule")
            Spacer()
            Button("Change") { editingSchedule = true }
                .font(FS.font.bodySm())
                .disabled(!vm.isAdminDevice)
                .accessibilityIdentifier("sd-backups-schedule-change")
        }
    }

    private func runBlock(_ c: FSColors) -> some View {
        FSSecondaryButton(vm.startingRun ? "Starting…" : "Back up now", block: true) {
            Task { await vm.backUpNow() }
        }
        .disabled(!vm.canRun)
        .accessibilityIdentifier("sd-backups-run")
    }

    // MARK: The list

    @ViewBuilder
    private func listBlock(_ c: FSColors) -> some View {
        if let backups = vm.saved?.backups, !backups.isEmpty {
            VStack(alignment: .leading, spacing: FS.space.s2) {
                FSSectionLabel("On this server")
                ForEach(backups) { b in row(b, c) }
                Text(ServerBackupsViewModel.oneFileNote)
                    .font(FS.font.caption()).foregroundColor(c.textMuted)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("sd-backups-note")
            }
        }
    }

    private func row(_ b: SavedBackup, _ c: FSColors) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(vm.rowLine(b)).font(FS.font.bodySm()).foregroundColor(c.text)
                .accessibilityIdentifier("sd-backup-row-\(b.archiveId)")
            if let left = vm.leftLine(b) {
                Text(left).font(FS.font.caption()).foregroundColor(c.warning)
            }
            HStack(spacing: FS.space.s3) {
                switch vm.downloads[b.archiveId] {
                case .downloading(let f):
                    ProgressView(value: f).frame(maxWidth: 140)
                case .done(let url):
                    ShareLink(item: url) { Label("Save…", systemImage: "square.and.arrow.up") }
                        .font(FS.font.bodySm())
                        .accessibilityIdentifier("sd-backup-save-\(b.archiveId)")
                case .failed(let why):
                    Text(why).font(FS.font.caption()).foregroundColor(c.danger)
                    Button("Try again") { Task { await vm.download(b) } }.font(FS.font.bodySm())
                case nil:
                    Button { Task { await vm.download(b) } } label: { Label("Download", systemImage: "arrow.down.circle") }
                        .font(FS.font.bodySm())
                        .accessibilityIdentifier("sd-backup-download-\(b.archiveId)")
                }
                Spacer()
                Button(role: .destructive) { deleting = b } label: { Label("Delete", systemImage: "trash") }
                    .font(FS.font.bodySm())
                    .disabled(!vm.isAdminDevice)
                    .accessibilityIdentifier("sd-backup-delete-\(b.archiveId)")
            }
        }
        .padding(.vertical, 4)
    }

    // MARK: This phone's copy

    private func phoneBlock(_ c: FSColors) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Divider()
            Toggle(isOn: $vm.keepCopyOnPhone) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Keep a copy on this phone").font(FS.font.bodySm()).foregroundColor(c.text)
                    Text("Only on Wi-Fi while charging.").font(FS.font.caption()).foregroundColor(c.textMuted)
                }
            }
            .tint(c.accent)
            .accessibilityIdentifier("sd-backups-keep-copy")
            if vm.keepCopyOnPhone, let line = vm.phoneCopyLine {
                HStack {
                    Text(line).font(FS.font.caption()).foregroundColor(c.textMuted)
                        .accessibilityIdentifier("sd-backups-phone-copy")
                    Spacer()
                    if let url = vm.phoneCopyURL {
                        ShareLink(item: url) { Text("Save…") }
                            .font(FS.font.bodySm())
                            .accessibilityIdentifier("sd-backups-phone-save")
                    }
                }
            }
        }
    }
}

/// "Change" on the schedule: frequency, a local time (and weekday), and how many to keep.
struct BackupScheduleEditor: View {
    @Environment(\.colorScheme) private var scheme
    @Bindable var vm: ServerBackupsViewModel
    var onDone: () -> Void
    @State private var draft: ServerBackupsViewModel.ScheduleDraft?

    var body: some View {
        let c = FSColors.scheme(scheme)
        Form {
            if let binding = Binding($draft) {
                Section {
                    Picker("How often", selection: binding.frequency) {
                        Text("Daily").tag("daily")
                        Text("Weekly").tag("weekly")
                        Text("Off").tag("off")
                    }
                    .pickerStyle(.segmented)
                    .accessibilityIdentifier("backup-schedule-frequency")
                    if binding.wrappedValue.frequency != "off" {
                        if binding.wrappedValue.frequency == "weekly" {
                            Picker("Day", selection: binding.weekday) {
                                ForEach(0..<7, id: \.self) { Text(BackupScheduleClock.weekdayName($0)).tag($0) }
                            }
                            .accessibilityIdentifier("backup-schedule-weekday")
                        }
                        DatePicker("Time", selection: timeBinding(binding.minute), displayedComponents: .hourAndMinute)
                            .accessibilityIdentifier("backup-schedule-time")
                    }
                } footer: {
                    Text("In this phone's time zone (\(TimeZone.current.localizedName(for: .generic, locale: .current) ?? TimeZone.current.identifier)).")
                }
                Section("Keep") {
                    Stepper("\(binding.wrappedValue.keepDaily) daily", value: binding.keepDaily, in: 0...60)
                        .accessibilityIdentifier("backup-schedule-keep-daily")
                    Stepper("\(binding.wrappedValue.keepWeekly) weekly", value: binding.keepWeekly, in: 0...52)
                        .accessibilityIdentifier("backup-schedule-keep-weekly")
                }
                if let e = vm.scheduleError {
                    Text(e).foregroundColor(c.danger).accessibilityIdentifier("backup-schedule-error")
                }
            }
        }
        .navigationTitle("Backup schedule")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) { Button("Cancel") { onDone() } }
            ToolbarItem(placement: .confirmationAction) {
                Button(vm.savingSchedule ? "Saving…" : "Save") {
                    guard let d = draft else { return }
                    Task { if await vm.saveSchedule(d) { onDone() } }
                }
                .disabled(draft == nil || vm.savingSchedule)
                .accessibilityIdentifier("backup-schedule-save")
            }
        }
        .onAppear { if draft == nil { draft = vm.scheduleDraft() } }
    }

    /// A local wall time for the picker, kept as minutes of the day.
    private func timeBinding(_ minute: Binding<Int>) -> Binding<Date> {
        Binding(
            get: {
                Calendar.current.date(bySettingHour: minute.wrappedValue / 60, minute: minute.wrappedValue % 60, second: 0, of: Date()) ?? Date()
            },
            set: { d in
                let c = Calendar.current.dateComponents([.hour, .minute], from: d)
                minute.wrappedValue = (c.hour ?? 0) * 60 + (c.minute ?? 0)
            }
        )
    }
}

/// "Change" / "Choose" on the backup policy: the same three options as the create form.
struct BackupPolicyEditor: View {
    @Environment(\.colorScheme) private var scheme
    @Bindable var vm: ServerBackupsViewModel
    var onDone: () -> Void
    @State private var policy: CreateServerDraftStore.BackupPolicy? = nil
    @State private var reserve: Int64 = PhoneBackupRetention.defaultReserveBytes(freeBytes: DeviceStorage.freeBytes())
    @State private var loaded = false

    var body: some View {
        let c = FSColors.scheme(scheme)
        ScrollView {
            VStack(alignment: .leading, spacing: FS.space.s4) {
                Text("Where should this server's backups go? The choice also sets how much the server's apps may hold.")
                    .font(FS.font.bodySm()).foregroundColor(c.textMuted)
                BackupPolicyOptions(policy: $policy, reserveBytes: $reserve)
                if let e = vm.policyError {
                    Text(e).font(FS.font.bodySm()).foregroundColor(c.danger)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("backup-policy-error")
                }
                FSPrimaryButton(vm.savingPolicy ? "Saving…" : "Save", block: true) {
                    guard let policy else { return }
                    Task { if await vm.changePolicy(to: policy, reserveBytes: reserve) { onDone() } }
                }
                .disabled(vm.savingPolicy || policy == nil)
                .accessibilityIdentifier("backup-policy-save")
            }
            .padding(FS.space.s4)
        }
        .background(c.bg.ignoresSafeArea())
        .navigationTitle("Backup policy")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { onDone() } } }
        .onAppear {
            guard !loaded else { return }
            loaded = true
            policy = vm.policyKind == "unset" ? nil : vm.policyDraft
            if vm.policyKind == "phone", let r = vm.policy?.policy.phoneReserveBytes, r > 0 { reserve = r }
        }
    }
}
