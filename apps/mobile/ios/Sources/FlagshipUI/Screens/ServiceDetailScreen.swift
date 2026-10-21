import SwiftUI
import FlagshipAPI
import FlagshipCore

/// Per-app management surface. Sections:
///   1. Header — slug, creator, status, version
///   2. RUNS ON — each of the account's servers, ticked where the app is
///      (from that server's own apps list). Tick copies the app there;
///      untick removes it (docs/app-placement.md §4).
///   3. WEB DOMAINS — canonical FQDN + per-pod aliases + user-defined
///      custom URLs; each shows where it currently resolves. User can
///      claim, release, or add new ones.
///   4. API keys (docs/app-apis.md §3), unless the box has none.
///   5. Database (docs/app-apis.md §6): owner only, for an app with Postgres.
///   6. Logs preview + last backup + Remove.
///
/// Pure view: takes a `vm` (ServiceDetailViewModel) and a list of pods.
public struct ServiceDetailScreen: View {
    @Environment(\.colorScheme) private var scheme
    @Bindable var vm: ServiceDetailViewModel
    let username: String?
    let pods: [PodInfo]
    /// V2 — drives the Replace App sheet.
    @State private var showReplaceSheet = false
    @State private var showAdapterReport = false
    @State private var replaceDraft = ""
    var onRemove: () -> Void = {}
    /// P8 — when the daemon reports open browser-tabs for this app the
    /// detail screen shows a section that calls this to push the tabs
    /// list onto the nav stack.
    var onOpenBrowserTabs: () -> Void = {}
    /// #92 — push the per-service access-gating ("Access control")
    /// surface onto the nav stack.
    var onOpenAccess: () -> Void = {}
    /// Push the owner's Database section (shown only when the VM says so).
    var onOpenDatabase: () -> Void = {}
    /// "Edit this service", shown when the box says it can be edited here.
    var onEdit: () -> Void = {}
    /// Allow / Stop access on the internet card. False on a restricted
    /// (companion) profile: the box refuses its signature anyway.
    var canApproveEgress: Bool = true
    @State private var confirmStopEgress = false

    public init(
        vm: ServiceDetailViewModel,
        username: String?,
        pods: [PodInfo],
        onRemove: @escaping () -> Void = {},
        onOpenBrowserTabs: @escaping () -> Void = {},
        onOpenAccess: @escaping () -> Void = {},
        onOpenDatabase: @escaping () -> Void = {},
        onEdit: @escaping () -> Void = {},
        canApproveEgress: Bool = true
    ) {
        self.vm = vm
        self.username = username
        self.pods = pods
        self.onRemove = onRemove
        self.onOpenBrowserTabs = onOpenBrowserTabs
        self.onOpenAccess = onOpenAccess
        self.onOpenDatabase = onOpenDatabase
        self.onEdit = onEdit
        self.canApproveEgress = canApproveEgress
    }

    public var body: some View {
        let c = FSColors.scheme(scheme)
        ScrollView {
            VStack(alignment: .leading, spacing: FS.space.s6) {
                switch vm.detail {
                case .idle, .loading:
                    ServerCardSkeleton()
                case .failed(let msg):
                    ErrorCard(message: msg)
                case .loaded(let d):
                    header(d: d.app, c: c)
                    if let access = vm.access {
                        InternetAccessSection(controller: access)
                    } else if vm.showsLegacyEgress {
                        egressCard(c: c)
                    }
                    if d.editable == true { editRow(c: c) }
                    if let from = d.adaptedFrom { adapterReportRow(repo: from.repo, c: c) }
                    if let runsOn = vm.runsOn { RunsOnSection(controller: runsOn) }
                    webDomains(d: d, c: c)
                    browserTabsRow(d: d, c: c)
                    accessRow(c: c)
                    if vm.showsApiKeys, let keys = vm.apiKeys {
                        ApiKeysSection(controller: keys)
                    }
                    if vm.showsDatabase, let db = vm.database { databaseRow(db, c: c) }
                    if let perms = vm.permissions { ServicePermissionsSection(controller: perms) }
                    storageSection(d.storage, c: c)
                    logsAndBackup(d: d, c: c)
                    if vm.canUninstall {
                        removeButton(c: c)
                    } else if !vm.adminOrders {
                        Text(AdminOrderGate.removeApp)
                            .font(FS.font.caption()).foregroundColor(c.textMuted)
                            .fixedSize(horizontal: false, vertical: true)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.top, FS.space.s4)
                            .accessibilityIdentifier("service-detail-remove-admin-only")
                    }
                }
                Spacer().frame(height: FS.space.s12)
            }
            .padding(.horizontal, FS.space.s6)
            .padding(.top, FS.space.s4)
            .fsReadingColumn()
        }
        .background(c.bg.ignoresSafeArea())
        .navigationTitle(vm.detail.value?.app.slug.capitalized ?? String(localized: "Service"))
        .navigationBarTitleDisplayMode(.inline)
    }

    private func header(d: FlagshipAPI.AppSummary, c: FSColors) -> some View {
        FSCard {
            VStack(alignment: .leading, spacing: FS.space.s2) {
                HStack(spacing: FS.space.s2) {
                    Text(d.slug.capitalized).font(FS.font.h2()).foregroundColor(c.text)
                    Spacer()
                    if let pill = AppServerState(d).pill { FSPill(pill.label, kind: pill.fsKind) }
                }
                Text("by \(d.creator)").foregroundColor(c.textMuted)
                if let v = d.version {
                    Text("Version \(v)")
                        .font(FS.font.caption())
                        .foregroundColor(c.textMuted)
                        .accessibilityIdentifier("app-detail-version")
                }
                if let summary = d.summary {
                    Text(summary).font(FS.font.bodySm()).foregroundColor(c.text)
                        .lineLimit(2).truncationMode(.tail)
                }
            }
        }
    }

    /// The app's disk use against its limits (docs/app-runtimes.md 5.3), and why
    /// new data is refused when it is full. Hidden on a box that sends none.
    @ViewBuilder
    private func storageSection(_ storage: AppDiskUsage?, c: FSColors) -> some View {
        let lines = AppStorageText.appLines(storage)
        if !lines.isEmpty {
            VStack(alignment: .leading, spacing: FS.space.s2) {
                FSSectionLabel(String(localized: "Storage"))
                FSCard {
                    VStack(alignment: .leading, spacing: FS.space.s2) {
                        ForEach(lines, id: \.label) { l in
                            HStack {
                                Text(l.label).font(FS.font.bodySm()).foregroundColor(c.textMuted)
                                Spacer()
                                Text(l.text).font(FS.font.bodySm())
                                    .foregroundColor(l.full ? c.danger : c.text)
                                    .accessibilityIdentifier("service-detail-storage-\(l.label.lowercased())")
                            }
                            if !l.note.isEmpty {
                                Text(l.note).font(FS.font.caption()).foregroundColor(c.danger)
                                    .fixedSize(horizontal: false, vertical: true)
                                    .accessibilityIdentifier("service-detail-storage-full")
                            }
                        }
                    }
                }
            }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("service-detail-storage")
        }
    }

    private func webDomains(d: AppDetailResponse, c: FSColors) -> some View {
        // V2 — single shared space (replaces the per-tab layout).
        // Three labelled groups: short redirect (top, bold), canonical
        // (shared by all instances), and individual instances. A
        // Replace button floats top-right of the section header.
        VStack(alignment: .leading, spacing: FS.space.s3) {
            HStack(alignment: .firstTextBaseline) {
                FSSectionLabel(String(localized: "Web domains"))
                Spacer()
                Button {
                    replaceDraft = currentDisplayLabel ?? ""
                    showReplaceSheet = true
                } label: {
                    HStack(spacing: 4) {
                        Image(systemName: "arrow.triangle.2.circlepath")
                        Text("Replace")
                    }
                    .font(FS.font.scaled(13, weight: .semibold))
                    .foregroundColor(c.danger)
                    .padding(.horizontal, FS.space.s2)
                    .padding(.vertical, 4)
                }
                .accessibilityIdentifier("app-replace-stem-btn")
            }

            FSCard {
                VStack(alignment: .leading, spacing: FS.space.s4) {
                    shortRedirectGroup(c: c)
                    Divider().background(c.border)
                    canonicalGroup(c: c, defaultLabel: d.app.urlLabel)
                    Divider().background(c.border)
                    instancesGroup(c: c, defaultLabel: d.app.urlLabel)
                }
            }
        }
        .sheet(isPresented: $showReplaceSheet) {
            ReplaceServiceStemSheet(
                draft: $replaceDraft,
                currentStem: currentDisplayLabel ?? "the current stem",
                phase: vm.renamePhase,
                onCancel: { showReplaceSheet = false },
                onConfirm: {
                    Task {
                        let ok = await vm.renameApp(to: replaceDraft)
                        if ok {
                            showReplaceSheet = false
                            await vm.loadAppLinks()
                        }
                    }
                }
            )
            .presentationDetents([.medium])
        }
    }

    /// Display label currently surfaced — server-provided when
    /// appLinks has loaded, falling back to the daemon's urlLabel.
    private var currentDisplayLabel: String? {
        if case .loaded(let links) = vm.appLinks { return links.displayLabel }
        return vm.detail.value?.app.urlLabel
    }

    @ViewBuilder
    private func shortRedirectGroup(c: FSColors) -> some View {
        VStack(alignment: .leading, spacing: FS.space.s2) {
            sectionLabel(String(localized: "Short redirect"), c: c)
            // UX-E — name the trust tradeoff vs. the canonical link below.
            Text("A convenient short link that redirects to your service.")
                .font(FS.font.caption())
                .foregroundColor(c.textMuted)
            if let short = vm.appLinks.value?.shortUrl, !short.isEmpty {
                urlRow(url: short, style: .prominent, c: c)
            } else if vm.appLinks.isLoading {
                Text("Generating short link…")
                    .font(FS.font.bodySm())
                    .foregroundColor(c.textMuted)
            } else {
                Text("No short link yet. Tap Replace to mint one.")
                    .font(FS.font.bodySm())
                    .foregroundColor(c.textMuted)
            }
        }
    }

    @ViewBuilder
    private func canonicalGroup(c: FSColors, defaultLabel: String) -> some View {
        VStack(alignment: .leading, spacing: FS.space.s2) {
            sectionLabel(String(localized: "Canonical (shared by all instances)"), c: c)
            // UX-E — the permanent, verifiable address (its certificate is
            // pinned to your box); the short link above is just a redirect.
            Text("The permanent, verifiable address — safe to share.")
                .font(FS.font.caption())
                .foregroundColor(c.textMuted)
            if let canonical = vm.appLinks.value?.canonicalUrl {
                urlRow(url: canonical, style: .normal, c: c)
            } else if let user = username {
                let fallback = "https://\(Endpoints.serverFqdn(server: defaultLabel, user: user))"
                urlRow(url: fallback, style: .normal, c: c)
            }
        }
    }

    @ViewBuilder
    private func instancesGroup(c: FSColors, defaultLabel: String) -> some View {
        // The servers that have the app (RUNS ON). Display label is the
        // renamed stem when available, the daemon default otherwise.
        let onIds = Set((vm.runsOn?.rows ?? []).filter { $0.presence == .installed }.map(\.pod.podId))
        let selected = pods.filter { onIds.contains($0.podId) }
        if !selected.isEmpty {
            let stem = vm.appLinks.value?.displayLabel ?? defaultLabel
            VStack(alignment: .leading, spacing: FS.space.s2) {
                sectionLabel(String(localized: "Individual instances"), c: c)
                ForEach(selected) { pod in
                    let url = "https://\(stem).\(SlugUtil.slugify(pod.name)).\(username ?? "you").\(Endpoints.dataApex)"
                    urlRow(url: url, style: .muted, c: c)
                }
            }
        }
    }

    private enum UrlStyle { case prominent, normal, muted }

    @ViewBuilder
    private func urlRow(url: String, style: UrlStyle, c: FSColors) -> some View {
        // V7 — no leading icon. The section header already names what
        // group the URL belongs to; a per-row globe / link icon was
        // visual noise.
        //
        // Wrap-at-dots: we insert a zero-width space after each `.` so
        // the text layout engine treats them as preferred break
        // opportunities. Without that, an FQDN is one giant unbroken
        // "word" and wraps mid-segment. With it, lines break only
        // between domain segments (e.g. `mynotes.harry.` / `flagship.services`).
        // The clipboard path uses the original `url` (no ZWSP) so a
        // copy still pastes a clean string.
        HStack(alignment: .top, spacing: FS.space.s2) {
            Text(wrapAtDots(stripScheme(url)))
                .font(.system(
                    size: style == .prominent ? 16 : 14,
                    weight: style == .prominent ? .semibold : .regular,
                    design: .monospaced,
                ))
                .foregroundColor(style == .muted ? c.textMuted : c.text)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
            if style != .muted {
                Button {
                    #if canImport(UIKit)
                    UIPasteboard.general.string = url
                    #endif
                } label: {
                    Image(systemName: "doc.on.doc")
                        .foregroundColor(c.textMuted)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Copy \(url)")
            }
        }
    }

    /// V7 — encourage line breaks between FQDN segments. ZWSP after
    /// each dot is a soft break opportunity for Core Text; the
    /// rendered text is otherwise identical.
    private func wrapAtDots(_ s: String) -> String {
        s.replacingOccurrences(of: ".", with: ".\u{200B}")
    }

    private func sectionLabel(_ s: String, c: FSColors) -> some View {
        FSSectionLabel(s)
    }

    private func stripScheme(_ s: String) -> String {
        if s.hasPrefix("https://") { return String(s.dropFirst("https://".count)) }
        if s.hasPrefix("http://") { return String(s.dropFirst("http://".count)) }
        return s
    }

    private func domainRow(
        fqdn: String,
        kindLabel: String,
        kindPillKind: FSPillKind,
        resolvesTo: String,
        action: (() -> Void)?,
        c: FSColors
    ) -> some View {
        FSCard {
            HStack(alignment: .top, spacing: FS.space.s3) {
                Image(systemName: "globe").foregroundColor(c.textMuted)
                VStack(alignment: .leading, spacing: 4) {
                    Text(fqdn).font(FS.font.mono()).foregroundColor(c.text).lineLimit(1).truncationMode(.middle)
                    HStack(spacing: FS.space.s2) {
                        FSPill(kindLabel, kind: kindPillKind)
                        Text("→ \(resolvesTo)").font(FS.font.caption()).foregroundColor(c.textMuted)
                    }
                }
                Spacer()
                if let action {
                    Button(action: action) {
                        Image(systemName: "xmark.circle.fill").foregroundColor(c.textMuted)
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }

    @ViewBuilder
    private func browserTabsRow(d: AppDetailResponse, c: FSColors) -> some View {
        if !d.browserTabs.isEmpty {
            section(String(localized: "Browser"), c: c) {
                Button(action: onOpenBrowserTabs) {
                    FSCard {
                        HStack(spacing: FS.space.s3) {
                            Image(systemName: "rectangle.on.rectangle").foregroundColor(c.accent)
                            VStack(alignment: .leading, spacing: 2) {
                                Text("Open browser viewer").foregroundColor(c.text)
                                Text(d.browserTabs.count == 1 ? String(localized: "\(d.browserTabs.count) tab running server-side") : String(localized: "\(d.browserTabs.count) tabs running server-side"))
                                    .font(FS.font.caption())
                                    .foregroundColor(c.textMuted)
                            }
                            Spacer()
                            Image(systemName: "chevron.right").foregroundColor(c.textMuted)
                        }
                    }
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("service-detail-open-browser-viewer")
            }
        }
    }

    private func databaseRow(_ db: AppDatabaseController, c: FSColors) -> some View {
        section(AppDbCopy.sectionTitle, c: c) {
            Button(action: onOpenDatabase) {
                FSCard {
                    HStack(spacing: FS.space.s3) {
                        Image(systemName: "cylinder.split.1x2").foregroundColor(c.accent)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(AppDbCopy.rowTitle).foregroundColor(c.text)
                            Text(db.state.value == nil ? AppDbCopy.rowSubtitle : AppDbCopy.tableCount(db.tableCount))
                                .font(FS.font.caption())
                                .foregroundColor(c.textMuted)
                        }
                        Spacer()
                        Image(systemName: "chevron.right").foregroundColor(c.textMuted)
                    }
                }
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("service-detail-open-database")
        }
    }

    private func adapterReportRow(repo: String, c: FSColors) -> some View {
        Button(action: { showAdapterReport = true }) {
            FSCard {
                HStack(spacing: FS.space.s3) {
                    Image(systemName: "exclamationmark.bubble").foregroundColor(c.accent)
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Report a problem with this adaptation").foregroundColor(c.text)
                        Text("It was set up from a shared adaptation of \(repo)")
                            .font(FS.font.caption())
                            .foregroundColor(c.textMuted)
                            .lineLimit(2)
                    }
                    Spacer()
                    Image(systemName: "chevron.right").foregroundColor(c.textMuted)
                }
            }
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("service-detail-report-adapter")
        .sheet(isPresented: $showAdapterReport) {
            AdapterReportSheet(serviceId: vm.serviceId)
        }
    }

    /// The app's internet access: declared hosts waiting for approval, and
    /// the ones it may reach now. Nothing when the box doesn't report it.
    @ViewBuilder
    private func egressCard(c: FSColors) -> some View {
        if let card = ServiceDetailViewModel.egressCard(vm.egress, canChange: canApproveEgress) {
            VStack(alignment: .leading, spacing: FS.space.s4) {
                if !card.pending.isEmpty {
                    FSCard {
                        VStack(alignment: .leading, spacing: FS.space.s2) {
                            HStack(spacing: FS.space.s2) {
                                Image(systemName: "network").foregroundColor(c.warning)
                                Text(ServiceDetailViewModel.egressTitle).font(FS.font.h4()).foregroundColor(c.text)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                            Text(ServiceDetailViewModel.egressNote)
                                .font(FS.font.bodySm()).foregroundColor(c.textMuted)
                                .fixedSize(horizontal: false, vertical: true)
                            ForEach(card.pending, id: \.self) { host in
                                HStack(spacing: FS.space.s2) {
                                    Text(host).font(FS.font.mono()).foregroundColor(c.text)
                                        .lineLimit(1).truncationMode(.middle)
                                        .textSelection(.enabled)
                                    Spacer(minLength: FS.space.s2)
                                    if card.canChange {
                                        FSPrimaryButton(String(localized: "Allow"), enabled: !vm.isChangingEgress) {
                                            Task { await vm.allowEgress(host: host) }
                                        }
                                        .accessibilityIdentifier("service-detail-egress-allow")
                                    }
                                }
                            }
                        }
                    }
                    .accessibilityElement(children: .contain)
                    .accessibilityIdentifier("service-detail-egress-pending")
                }
                if !card.approved.isEmpty {
                    section(String(localized: "Internet access"), c: c) {
                        FSCard {
                            VStack(alignment: .leading, spacing: FS.space.s2) {
                                Text("This app may reach:").font(FS.font.bodySm()).foregroundColor(c.textMuted)
                                hostList(card.approved, c: c)
                                if card.canChange {
                                    FSSecondaryButton(vm.isChangingEgress ? String(localized: "Stopping…") : String(localized: "Stop access"), block: true) {
                                        confirmStopEgress = true
                                    }
                                    .disabled(vm.isChangingEgress)
                                    .accessibilityIdentifier("service-detail-egress-stop")
                                }
                            }
                        }
                    }
                }
                if case .failed(let msg) = vm.egressPhase {
                    Text(msg).font(FS.font.bodySm()).foregroundColor(c.danger)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("service-detail-egress-error")
                }
            }
            .confirmationDialog("Stop this app's internet access?", isPresented: $confirmStopEgress,
                                titleVisibility: .visible) {
                Button("Stop access", role: .destructive) { Task { await vm.stopEgress() } }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("The app won't be able to reach any of these hosts until you allow them again.")
            }
        }
    }

    private func hostList(_ hosts: [String], c: FSColors) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            ForEach(hosts, id: \.self) { h in
                Text(h).font(FS.font.mono()).foregroundColor(c.text)
                    .lineLimit(1).truncationMode(.middle)
                    .textSelection(.enabled)
            }
        }
    }

    private func editRow(c: FSColors) -> some View {
        Button(action: onEdit) {
            FSCard {
                HStack(spacing: FS.space.s3) {
                    Image(systemName: "pencil.and.outline").foregroundColor(c.accent)
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Edit this service").foregroundColor(c.text)
                        Text("Change it with AI, or in your own editor")
                            .font(FS.font.caption())
                            .foregroundColor(c.textMuted)
                    }
                    Spacer()
                    Image(systemName: "chevron.right").foregroundColor(c.textMuted)
                }
            }
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("service-detail-edit")
    }

    private func accessRow(c: FSColors) -> some View {
        section(String(localized: "Access control"), c: c) {
            Button(action: onOpenAccess) {
                FSCard {
                    HStack(spacing: FS.space.s3) {
                        Image(systemName: "person.2.fill").foregroundColor(c.accent)
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Access control").foregroundColor(c.text)
                            Text("Open to all or members only, and each member's rank")
                                .font(FS.font.caption())
                                .foregroundColor(c.textMuted)
                        }
                        Spacer()
                        Image(systemName: "chevron.right").foregroundColor(c.textMuted)
                    }
                }
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("service-detail-open-access")
        }
    }

    private func logsAndBackup(d: AppDetailResponse, c: FSColors) -> some View {
        VStack(alignment: .leading, spacing: FS.space.s4) {
            if !d.recentLogs.isEmpty {
                section(String(localized: "Recent logs"), c: c) {
                    FSCard {
                        VStack(alignment: .leading, spacing: 4) {
                            ForEach(d.recentLogs, id: \.self) { line in
                                Text(line).font(FS.font.mono()).foregroundColor(c.text)
                            }
                        }
                    }
                }
            }
            if let backup = vm.backup {
                section(String(localized: "Backup"), c: c) {
                    FSCard { backupCard(backup, last: d.lastBackup, c: c) }
                }
            }
        }
    }

    @ViewBuilder
    private func backupCard(_ backup: AppBackupController, last: AppDetailResponse.BackupSummary?, c: FSColors) -> some View {
        @Bindable var backup = backup
        VStack(alignment: .leading, spacing: FS.space.s3) {
            if let last {
                Text("Last backup: \(last.bytes / 1024 / 1024) MB · \(relative(ms: last.createdAt))")
                    .font(FS.font.caption())
                    .foregroundColor(c.textMuted)
            }
            Text("The app's code, and its data if you include it. It comes straight from your server to this phone.")
                .font(FS.font.bodySm())
                .foregroundColor(c.textMuted)
                .fixedSize(horizontal: false, vertical: true)
            Toggle("Include the app's data", isOn: $backup.includeData)
                .font(FS.font.bodySm())
                .disabled(backup.isBusy)
                .accessibilityIdentifier("service-detail-backup-data")
            SecureField("Password to encrypt it (optional)", text: $backup.password)
                .textContentType(.newPassword)
                .font(FS.font.bodySm())
                .disabled(backup.isBusy)
                .fsInputBox()
            switch backup.phase {
            case .ready(let file, let bytes, let encrypted):
                Text("Ready: \(ByteCountFormatter.string(fromByteCount: Int64(bytes), countStyle: .file))\(encrypted ? ", encrypted" : "")")
                    .font(FS.font.caption())
                    .foregroundColor(c.success)
                ShareLink(item: file) {
                    Label("Save backup", systemImage: "square.and.arrow.down")
                }
                .accessibilityIdentifier("service-detail-backup-save")
            case .failed(let message):
                Text(message).font(FS.font.caption()).foregroundColor(c.danger)
            default:
                EmptyView()
            }
            FSSecondaryButton(
                backup.phase == .creating ? String(localized: "Packing…") : backup.phase == .downloading ? String(localized: "Downloading…") : String(localized: "Back up now"),
                block: true
            ) {
                Task { await backup.backUp() }
            }
            .disabled(backup.isBusy)
            .accessibilityIdentifier("service-detail-backup-now")
        }
    }

    private func removeButton(c: FSColors) -> some View {
        VStack(spacing: FS.space.s3) {
            FSDangerButton(
                vm.isRemoving ? String(localized: "Removing…") : String(localized: "Remove app"),
                block: true,
                action: onRemove
            )
            .disabled(vm.isRemoving)
            .accessibilityIdentifier("service-detail-remove-btn")
        }
        .padding(.top, FS.space.s4)
    }

    @ViewBuilder
    private func section<C: View>(_ label: String, c: FSColors, @ViewBuilder content: () -> C) -> some View {
        VStack(alignment: .leading, spacing: FS.space.s3) {
            FSSectionLabel(label)
            content()
        }
    }

    private func relative(ms: Int64) -> String {
        Date.flagshipFormatted(epochMs: ms)
    }
}

/// The owner's note about a shared adaptation that doesn't work. It goes to
/// Flagship's public store with only the adaptation's id; three reports
/// retire an adaptation so the next server's AI makes a better one.
struct AdapterReportSheet: View {
    let serviceId: String
    @Environment(\.screensClient) private var client
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var scheme
    @State private var detail = ""
    @State private var sending = false
    @State private var sent = false
    @State private var error: String?

    var body: some View {
        let c = FSColors.scheme(scheme)
        NavigationStack {
            FSScreen {
                ScrollView {
                    VStack(alignment: .leading, spacing: FS.space.s4) {
                        if sent {
                            Label("Sent. Thank you.", systemImage: "checkmark.circle.fill")
                                .font(FS.font.h4()).foregroundColor(c.success)
                            Text("To fix it on your server now, use Edit this service to change it with AI.")
                                .font(FS.font.body()).foregroundColor(c.textMuted)
                                .fixedSize(horizontal: false, vertical: true)
                        } else {
                            Text("What goes wrong? It helps fix the shared adaptation for everyone.")
                                .font(FS.font.body()).foregroundColor(c.text)
                                .fixedSize(horizontal: false, vertical: true)
                            Label("Please don't include anything that identifies you, your server or your data: no names, addresses, emails or passwords.",
                                  systemImage: "exclamationmark.shield")
                                .font(FS.font.bodySm()).foregroundColor(c.warning)
                                .fixedSize(horizontal: false, vertical: true)
                            TextEditor(text: $detail)
                                .font(FS.font.body())
                                .padding(10)
                                .frame(height: 160)
                                .background(c.surfaceSunken)
                                .overlay(RoundedRectangle(cornerRadius: FS.radius.sm, style: .continuous).stroke(c.border, lineWidth: 1))
                                .accessibilityIdentifier("adapter-report-text")
                            Text("\(detail.count) / 2000").font(FS.font.caption()).foregroundColor(c.textMuted)
                            if let error { ErrorCard(message: error) }
                            FSPrimaryButton(sending ? String(localized: "Sending…") : String(localized: "Send report"),
                                            enabled: !sending && !detail.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && detail.count <= 2000,
                                            block: true) {
                                Task { await send() }
                            }
                            .accessibilityIdentifier("adapter-report-send")
                        }
                    }
                    .padding(FS.space.s6)
                }
            }
            .navigationTitle("Report a problem")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(sent ? String(localized: "Done") : "Cancel") { dismiss() } }
            }
        }
    }

    private func send() async {
        sending = true
        defer { sending = false }
        error = nil
        do {
            try await client.adapterReport(serviceId: serviceId, detail: detail.trimmingCharacters(in: .whitespacesAndNewlines))
            sent = true
        } catch {
            self.error = ScreensClientError.boxReason(error) ?? ScreensClientError.userFacing(error)
        }
    }
}
