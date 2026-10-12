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
    /// P6 — push the collaborator-invite manage surface onto the nav
    /// stack. Unconditionally surfaced (independent of detail state).
    var onOpenCollaborators: () -> Void = {}
    /// #92 — push the per-service access-gating ("Who can open this")
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
        onOpenCollaborators: @escaping () -> Void = {},
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
        self.onOpenCollaborators = onOpenCollaborators
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
                    collaboratorsRow(c: c)
                    accessRow(c: c)
                    if vm.showsApiKeys, let keys = vm.apiKeys {
                        ApiKeysSection(controller: keys)
                    }
                    if vm.showsDatabase, let db = vm.database { databaseRow(db, c: c) }
                    logsAndBackup(d: d, c: c)
                    removeButton(c: c)
                }
                Spacer().frame(height: FS.space.s12)
            }
            .padding(.horizontal, FS.space.s6)
            .padding(.top, FS.space.s4)
            .fsReadingColumn()
        }
        .background(c.bg.ignoresSafeArea())
        .navigationTitle(vm.detail.value?.app.slug.capitalized ?? "Service")
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
                // V6 — version + package id sit on one line so the
                // user can tell which app this is even after they've
                // renamed the URL stem (display label hides the
                // package name elsewhere). `urlLabel` is the canonical
                // package handle: `scratchpad` if the user is the
                // creator, `scratchpad--meta` / `scratchpad--harry`
                // otherwise.
                // V9 — `id:` is the IMMUTABLE composite package id
                // (`<creator>--<slug>`, double dash), NOT the URL
                // label. urlLabel rotates whenever the user hits
                // Replace stem; serviceId stays put for the life of
                // the package — it's what the manifest, the membership
                // store, R2 backups, and the update-pack pull state
                // are all keyed on. Showing urlLabel here (V6 bug)
                // was wrong because a rename would silently change
                // the "id" the user sees, when actually the only
                // thing that changed is the user-facing URL stem.
                HStack(spacing: FS.space.s2) {
                    if let v = d.version {
                        Text("ver: \(v)").font(FS.font.caption()).foregroundColor(c.textMuted)
                        Text("·").font(FS.font.caption()).foregroundColor(c.textMuted)
                    }
                    Text("id: \(d.serviceId)")
                        .font(FS.font.caption())
                        .foregroundColor(c.textMuted)
                        .accessibilityIdentifier("app-detail-package-id")
                }
                if let summary = d.summary {
                    Text(summary).font(FS.font.bodySm()).foregroundColor(c.text)
                        .lineLimit(2).truncationMode(.tail)
                }
            }
        }
    }

    private func webDomains(d: AppDetailResponse, c: FSColors) -> some View {
        // V2 — single shared space (replaces the per-tab layout).
        // Three labelled groups: short redirect (top, bold), canonical
        // (shared by all instances), and individual instances. A
        // Replace button floats top-right of the section header.
        VStack(alignment: .leading, spacing: FS.space.s3) {
            HStack(alignment: .firstTextBaseline) {
                Text("WEB DOMAINS")
                    .font(.system(size: 12, weight: .semibold))
                    .tracking(1)
                    .foregroundColor(c.textMuted)
                Spacer()
                Button {
                    replaceDraft = currentDisplayLabel ?? ""
                    showReplaceSheet = true
                } label: {
                    HStack(spacing: 4) {
                        Image(systemName: "arrow.triangle.2.circlepath")
                        Text("Replace")
                    }
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundColor(c.danger)
                    .padding(.horizontal, FS.space.s2)
                    .padding(.vertical, 4)
                }
                .accessibilityIdentifier("app-replace-stem-btn")
            }

            FSCard {
                VStack(alignment: .leading, spacing: FS.space.s4) {
                    // CUSTOM DOMAIN sits at the very top, only when one
                    // is bound. It's the user's own name — show it first.
                    if let cd = vm.customDomain {
                        customDomainGroup(fqdn: cd, c: c)
                        Divider().background(c.border)
                    }
                    shortRedirectGroup(c: c)
                    Divider().background(c.border)
                    canonicalGroup(c: c, defaultLabel: d.app.urlLabel)
                    Divider().background(c.border)
                    instancesGroup(c: c, defaultLabel: d.app.urlLabel)
                }
            }

            setCustomDomainSection(c: c)
        }
        .alert(
            vm.customDomainPrompt?.title ?? "",
            isPresented: Binding(
                get: { vm.customDomainPrompt != nil },
                set: { if !$0 { vm.customDomainPrompt = nil } }
            ),
            presenting: vm.customDomainPrompt
        ) { prompt in
            if let confirmTitle = prompt.confirmTitle, let onConfirm = prompt.onConfirm {
                Button(confirmTitle, role: prompt.destructive ? .destructive : nil) {
                    onConfirm()
                }
                Button("Cancel", role: .cancel) {}
            } else {
                Button("OK", role: .cancel) {}
            }
        } message: { prompt in
            Text(prompt.message)
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
            sectionLabel("SHORT REDIRECT", c: c)
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
            sectionLabel("CANONICAL (SHARED BY ALL INSTANCES)", c: c)
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
                sectionLabel("INDIVIDUAL INSTANCES", c: c)
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
        Text(s)
            .font(.system(size: 11, weight: .semibold))
            .tracking(1)
            .foregroundColor(c.textMuted)
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

    /// Top group in WEB DOMAINS — only when a domain is bound. Same
    /// row treatment (wrap-at-dots + copy) as the other groups.
    private func customDomainGroup(fqdn: String, c: FSColors) -> some View {
        VStack(alignment: .leading, spacing: FS.space.s2) {
            sectionLabel("CUSTOM DOMAIN", c: c)
            urlRow(url: "https://\(fqdn)", style: .prominent, c: c)
        }
    }

    private var customDomainRoot: String { Endpoints.userZoneHost(username ?? "you") }

    private func cooldownLabel(_ remaining: TimeInterval) -> String {
        let s = max(0, Int(remaining.rounded(.up)))
        return String(format: "%d:%02d", s / 60, s % 60)
    }

    private func setCustomDomainSection(c: FSColors) -> some View {
        // Tick every second so the cooldown countdown + disabled state
        // stay live without a manual timer.
        TimelineView(.periodic(from: .now, by: 1)) { ctx in
            let remaining = vm.customDomainCooldownUntil?
                .timeIntervalSince(ctx.date) ?? 0
            let cooling = remaining > 0
            FSCard {
                VStack(alignment: .leading, spacing: FS.space.s3) {
                    HStack {
                        sectionLabel("SET CUSTOM DOMAIN", c: c)
                        Spacer()
                        if cooling {
                            // Same treatment as the section label, but
                            // right-floated on the same line.
                            Text(cooldownLabel(remaining))
                                .font(.system(size: 11, weight: .semibold))
                                .tracking(1)
                                .foregroundColor(c.textMuted)
                                .monospacedDigit()
                        }
                    }
                    // Inline input (not FSField) so there's no empty
                    // label row reserving height — that's what made the
                    // Add button sit a few px above the box. Both are
                    // h=40 and center-aligned, so they line up exactly.
                    HStack(alignment: .center, spacing: FS.space.s2) {
                        TextField("www.mydomain.com", text: $vm.customDomainDraft)
                            .font(FS.font.body())
                            .autocorrectionDisabled()
                            .textInputAutocapitalization(.never)
                            .keyboardType(.URL)
                            .padding(.horizontal, 14)
                            .frame(height: 40)
                            .background(c.surfaceSunken)
                            .overlay(
                                RoundedRectangle(cornerRadius: FS.radius.sm)
                                    .stroke(c.border, lineWidth: 1)
                            )
                            .clipShape(RoundedRectangle(cornerRadius: FS.radius.sm))
                        FSPrimaryButton("Add", enabled: !cooling, block: false) {
                            Task { await vm.submitCustomDomain(rootDomain: customDomainRoot) }
                        }
                    }
                    Text("Prior to claiming a FQDN, you must set a CNAME record targeting \(customDomainRoot).")
                        .font(FS.font.caption()).foregroundColor(c.textMuted)
                }
            }
        }
    }

    @ViewBuilder
    private func browserTabsRow(d: AppDetailResponse, c: FSColors) -> some View {
        if !d.browserTabs.isEmpty {
            section("BROWSER", c: c) {
                Button(action: onOpenBrowserTabs) {
                    FSCard {
                        HStack(spacing: FS.space.s3) {
                            Image(systemName: "rectangle.on.rectangle").foregroundColor(c.primary)
                            VStack(alignment: .leading, spacing: 2) {
                                Text("Open browser viewer").foregroundColor(c.text)
                                Text("\(d.browserTabs.count) tab\(d.browserTabs.count == 1 ? "" : "s") running server-side")
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
                        Image(systemName: "cylinder.split.1x2").foregroundColor(c.primary)
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

    @ViewBuilder
    private func collaboratorsRow(c: FSColors) -> some View {
        section("COLLABORATORS", c: c) {
            Button(action: onOpenCollaborators) {
                FSCard {
                    HStack(spacing: FS.space.s3) {
                        Image(systemName: "person.2.fill").foregroundColor(c.primary)
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Manage collaborators").foregroundColor(c.text)
                            Text("Issue invites + revoke active access")
                                .font(FS.font.caption())
                                .foregroundColor(c.textMuted)
                        }
                        Spacer()
                        Image(systemName: "chevron.right").foregroundColor(c.textMuted)
                    }
                }
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("service-detail-open-collaborators")
        }
    }

    private func adapterReportRow(repo: String, c: FSColors) -> some View {
        Button(action: { showAdapterReport = true }) {
            FSCard {
                HStack(spacing: FS.space.s3) {
                    Image(systemName: "exclamationmark.bubble").foregroundColor(c.primary)
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
                                        FSPrimaryButton("Allow", enabled: !vm.isChangingEgress) {
                                            Task { await vm.allowEgress(host: host) }
                                        }
                                        .accessibilityIdentifier("service-detail-egress-allow")
                                    }
                                }
                            }
                        }
                    }
                    .accessibilityIdentifier("service-detail-egress-pending")
                }
                if !card.approved.isEmpty {
                    section("INTERNET ACCESS", c: c) {
                        FSCard {
                            VStack(alignment: .leading, spacing: FS.space.s2) {
                                Text("This app may reach:").font(FS.font.bodySm()).foregroundColor(c.textMuted)
                                hostList(card.approved, c: c)
                                if card.canChange {
                                    FSSecondaryButton(vm.isChangingEgress ? "Stopping…" : "Stop access", block: true) {
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
                    Image(systemName: "pencil.and.outline").foregroundColor(c.primary)
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
        section("WHO CAN OPEN THIS", c: c) {
            Button(action: onOpenAccess) {
                FSCard {
                    HStack(spacing: FS.space.s3) {
                        Image(systemName: "lock.shield").foregroundColor(c.primary)
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Manage access").foregroundColor(c.text)
                            Text("Open to anyone, or restrict to people you invite")
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
                section("RECENT LOGS", c: c) {
                    FSCard {
                        VStack(alignment: .leading, spacing: 4) {
                            ForEach(d.recentLogs, id: \.self) { line in
                                Text(line).font(FS.font.mono()).foregroundColor(c.text)
                            }
                        }
                    }
                }
            }
            if let backup = d.lastBackup {
                section("BACKUP", c: c) {
                    FSCard {
                        HStack {
                            VStack(alignment: .leading) {
                                Text("Last backup").foregroundColor(c.text)
                                Text("\(backup.bytes / 1024 / 1024) MB · \(relative(ms: backup.createdAt))")
                                    .font(FS.font.caption())
                                    .foregroundColor(c.textMuted)
                            }
                            Spacer()
                            FSGhostButton("Back up now") {}
                        }
                    }
                }
            }
        }
    }

    private func removeButton(c: FSColors) -> some View {
        VStack(spacing: FS.space.s3) {
            FSDangerButton(
                vm.isRemoving ? "Removing…" : "Remove service",
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
            Text(label).font(.system(size: 12, weight: .semibold)).tracking(1).foregroundColor(c.textMuted)
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
                                .overlay(RoundedRectangle(cornerRadius: FS.radius.sm).stroke(c.border, lineWidth: 1))
                                .accessibilityIdentifier("adapter-report-text")
                            Text("\(detail.count) / 2000").font(FS.font.caption()).foregroundColor(c.textMuted)
                            if let error { ErrorCard(message: error) }
                            FSPrimaryButton(sending ? "Sending…" : "Send report",
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
                ToolbarItem(placement: .cancellationAction) { Button(sent ? "Done" : "Cancel") { dismiss() } }
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
