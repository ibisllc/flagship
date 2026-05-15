import SwiftUI
import FlagshipAPI
import FlagshipCore

/// Per-app management surface. Sections:
///   1. Header — slug, creator, status, version
///   2. WHERE IT RUNS — per-pod toggle; "Lead" radio designates the pod
///      that holds the canonical short domain. Defaults to the global
///      leader pod (set in Home / Settings).
///   3. WEB DOMAINS — canonical FQDN + per-pod aliases + user-defined
///      custom URLs; each shows where it currently resolves. User can
///      claim, release, or add new ones.
///   4. Logs preview + last backup + Remove.
///
/// Pure view: takes a `vm` (AppDetailViewModel) and a list of pods.
public struct AppDetailScreen: View {
    @Environment(\.colorScheme) private var scheme
    @Bindable var vm: AppDetailViewModel
    let username: String?
    let pods: [PodInfo]
    let globalLeaderPodId: String?
    /// V2 — drives the Replace App sheet.
    @State private var showReplaceSheet = false
    @State private var replaceDraft = ""
    var onSave: () -> Void = {}
    var onRemove: () -> Void = {}

    public init(
        vm: AppDetailViewModel,
        username: String?,
        pods: [PodInfo],
        globalLeaderPodId: String?,
        onSave: @escaping () -> Void = {},
        onRemove: @escaping () -> Void = {}
    ) {
        self.vm = vm
        self.username = username
        self.pods = pods
        self.globalLeaderPodId = globalLeaderPodId
        self.onSave = onSave
        self.onRemove = onRemove
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
                    whereItRuns(d: d, c: c)
                    webDomains(d: d, c: c)
                    logsAndBackup(d: d, c: c)
                    saveAndRemove(c: c)
                }
                Spacer().frame(height: FS.space.s12)
            }
            .padding(.horizontal, FS.space.s6)
            .padding(.top, FS.space.s4)
        }
        .background(c.bg.ignoresSafeArea())
        .navigationTitle(vm.detail.value?.app.slug.capitalized ?? "App")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func header(d: FlagshipAPI.AppSummary, c: FSColors) -> some View {
        FSCard {
            VStack(alignment: .leading, spacing: FS.space.s2) {
                HStack(spacing: FS.space.s2) {
                    Text(d.slug.capitalized).font(FS.font.h2()).foregroundColor(c.text)
                    Spacer()
                    FSPill(d.status == "running" ? "Running" : "Stopped", kind: d.status == "running" ? .online : .idle)
                }
                Text("by \(d.creator)").foregroundColor(c.textMuted)
                // V6 — version + package id sit on one line so the
                // user can tell which app this is even after they've
                // renamed the URL stem (display label hides the
                // package name elsewhere). `urlLabel` is the canonical
                // package handle: `scratchpad` if the user is the
                // creator, `scratchpad-meta` / `scratchpad-harry`
                // otherwise.
                // V9 — `id:` is the IMMUTABLE composite package id
                // (`<creator>--<slug>`, double-dash), NOT the URL
                // label. urlLabel rotates whenever the user hits
                // Replace stem; appId stays put for the life of the
                // package — it's what the manifest, the membership
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
                    Text("id: \(d.appId)")
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

    private func whereItRuns(d: AppDetailResponse, c: FSColors) -> some View {
        section("WHERE IT RUNS", c: c) {
            FSCard {
                VStack(spacing: FS.space.s3) {
                    ForEach(pods) { pod in
                        podRow(pod: pod, c: c)
                        if pod != pods.last {
                            Divider().background(c.border)
                        }
                    }
                }
            }
            Text(leadHint(c: c))
                .font(FS.font.caption())
                .foregroundColor(c.textMuted)
                .padding(.horizontal, 4)
        }
    }

    private func podRow(pod: PodInfo, c: FSColors) -> some View {
        let isOn = vm.runOnPodIds.contains(pod.podId)
        let isLead = vm.effectiveLeadPodId == pod.podId
        let isGlobalLeader = globalLeaderPodId == pod.podId
        return HStack(spacing: FS.space.s3) {
            Button {
                vm.togglePod(pod.podId)
            } label: {
                Image(systemName: isOn ? "checkmark.square.fill" : "square")
                    .font(.system(size: 20))
                    .foregroundColor(isOn ? c.primary : c.textMuted)
            }
            .buttonStyle(.plain)

            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: FS.space.s2) {
                    Text(pod.name).font(.system(size: 16, weight: .semibold)).foregroundColor(c.text)
                    if isGlobalLeader { LeaderBadge() }
                }
                if let desc = pod.description, !desc.isEmpty {
                    Text(desc).font(FS.font.caption()).foregroundColor(c.textMuted)
                        .lineLimit(1).truncationMode(.tail)
                }
            }
            Spacer()
            if isOn {
                // Check-circle + house: the circle reads as the
                // selectable radio (filled when chosen); the house
                // says what it selects (this pod leads). The word
                // "Lead" used to sit here but collided with the
                // "Leader" badge a few px to the left.
                Button {
                    vm.setLead(pod.podId)
                } label: {
                    HStack(spacing: 4) {
                        Image(systemName: isLead ? "largecircle.fill.circle" : "circle")
                            .foregroundColor(isLead ? c.primary : c.textMuted)
                        Image(systemName: "house.fill")
                            .font(.system(size: 15))
                            .foregroundColor(isLead ? c.primary : c.textMuted)
                    }
                }
                .buttonStyle(.plain)
                .accessibilityLabel(isLead ? "Lead pod" : "Make lead pod")
            }
        }
    }

    private func leadHint(c: FSColors) -> String {
        if let podId = vm.leadPodId, let pod = pods.first(where: { $0.podId == podId }) {
            return "Canonical short domain points to \(pod.name)."
        }
        if let podId = globalLeaderPodId, let pod = pods.first(where: { $0.podId == podId }) {
            return "Following the account leader (\(pod.name))."
        }
        return "Pick which pod owns the canonical short domain."
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
                    shortRedirectGroup(c: c)
                    Divider().background(c.border)
                    canonicalGroup(c: c, defaultLabel: d.app.urlLabel)
                    Divider().background(c.border)
                    instancesGroup(c: c, defaultLabel: d.app.urlLabel)
                }
            }

            // V7 — Add a custom domain. Lives back under WEB DOMAINS
            // so the affordance stays visible (we don't want users
            // forgetting that custom domains are possible at all).
            // Each custom domain renders its own card with a Verify
            // CTA + the expected TXT record hint.
            if !vm.customUrls.isEmpty {
                VStack(spacing: FS.space.s3) {
                    ForEach(vm.customUrls, id: \.self) { url in
                        customDomainCard(url: url, c: c)
                    }
                }
            }
            addCustomDomain(c: c)
        }
        .sheet(isPresented: $showReplaceSheet) {
            ReplaceAppStemSheet(
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
            if let canonical = vm.appLinks.value?.canonicalUrl {
                urlRow(url: canonical, style: .normal, c: c)
            } else if let user = username {
                let fallback = "https://\(defaultLabel).\(user).flagship.services"
                urlRow(url: fallback, style: .normal, c: c)
            }
        }
    }

    @ViewBuilder
    private func instancesGroup(c: FSColors, defaultLabel: String) -> some View {
        // V6 — reactively reflect the user's current pod selection from
        // WHERE IT RUNS. The server-returned `appLinks.instances` is
        // .com's view of which pods are live; here we want the
        // instances list the user is actively shaping. Display label
        // is the renamed stem when available, the daemon default
        // otherwise.
        let selected = pods.filter { vm.runOnPodIds.contains($0.podId) }
        if !selected.isEmpty {
            let stem = vm.appLinks.value?.displayLabel ?? defaultLabel
            VStack(alignment: .leading, spacing: FS.space.s2) {
                sectionLabel("INDIVIDUAL INSTANCES", c: c)
                ForEach(selected) { pod in
                    let url = "https://\(stem).\(SlugUtil.slugify(pod.name)).\(username ?? "you").flagship.services"
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

    private var leadDestinationLabel: String {
        if let podId = vm.effectiveLeadPodId, let p = pods.first(where: { $0.podId == podId }) {
            return p.name
        }
        return "Leader"
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

    private func customDomainCard(url: String, c: FSColors) -> some View {
        let status = vm.customDomainStatus[url]
        return FSCard {
            VStack(alignment: .leading, spacing: FS.space.s2) {
                HStack(spacing: FS.space.s3) {
                    Image(systemName: "globe").foregroundColor(c.textMuted)
                    Text(url).font(FS.font.mono()).foregroundColor(c.text)
                        .lineLimit(1).truncationMode(.middle)
                    Spacer()
                    Button { vm.removeCustomUrl(url) } label: {
                        Image(systemName: "xmark.circle.fill").foregroundColor(c.textMuted)
                    }.buttonStyle(.plain)
                }
                statusPill(for: status, c: c)
                if let status, let expected = nonEmpty(status.expectedTxtRecord) {
                    VStack(alignment: .leading, spacing: FS.space.s1) {
                        Text("Add this TXT record on _flagship.\(url):").font(FS.font.caption()).foregroundColor(c.textMuted)
                        Text(expected).font(FS.font.mono()).foregroundColor(c.text)
                            .textSelection(.enabled)
                    }
                }
                if let reason = status?.reason {
                    Text(reason).font(FS.font.caption()).foregroundColor(c.textMuted)
                }
                HStack(spacing: FS.space.s2) {
                    FSGhostButton(status?.status == .pending ? "Re-check DNS" : "Verify DNS") {
                        Task { await vm.verifyCustomDomain(url) }
                    }
                    Spacer()
                }
            }
        }
    }

    private func statusPill(for status: VerifyCustomDomainResponse?, c: FSColors) -> some View {
        let label: String
        let kind: FSPillKind
        switch status?.status {
        case .verified: label = "Verified"; kind = .online
        case .pending:  label = "Pending DNS"; kind = .renewing
        case .failed:   label = "Failed"; kind = .offline
        case .none:     label = "Not yet checked"; kind = .idle
        }
        return FSPill(label, kind: kind)
    }

    private func nonEmpty(_ s: String) -> String? { s.isEmpty ? nil : s }

    private func addCustomDomain(c: FSColors) -> some View {
        FSCard {
            VStack(alignment: .leading, spacing: FS.space.s2) {
                Text("Add a custom domain").font(.system(size: 13, weight: .semibold)).foregroundColor(c.text)
                HStack(spacing: FS.space.s2) {
                    FSField(value: $vm.newCustomUrlDraft, label: "", placeholder: "www.mydomain.com")
                    FSGhostButton("Add") { vm.addCustomUrl() }
                }
                Text("Point a subdomain you own at Flagship with a single DNS CNAME — set ")
                    .font(FS.font.caption()).foregroundColor(c.textMuted)
                + Text("www.mydomain.com → \(username ?? "you").flagship.services")
                    .font(FS.font.mono()).foregroundColor(c.text)
                + Text(".  No registrar transfer, no IP to point at. Your apex (mydomain.com) can't take a CNAME — keep it on www and redirect the apex to it (a free Cloudflare/registrar redirect). The short link and app URLs are unaffected, and a Replace never touches an attached domain.")
                    .font(FS.font.caption()).foregroundColor(c.textMuted)
            }
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

    private func saveAndRemove(c: FSColors) -> some View {
        VStack(spacing: FS.space.s3) {
            FSPrimaryButton("Save changes", block: true, large: true, action: onSave)
            FSDangerButton("Remove app", block: true, action: onRemove)
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
        let date = Date(timeIntervalSince1970: TimeInterval(ms) / 1000)
        let fmt = RelativeDateTimeFormatter()
        fmt.unitsStyle = .abbreviated
        return fmt.localizedString(for: date, relativeTo: Date())
    }
}
