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
                if let v = d.version {
                    Text("v\(v)").font(FS.font.caption()).foregroundColor(c.textMuted)
                }
                if let summary = d.summary {
                    Text(summary).font(FS.font.bodySm()).foregroundColor(c.text)
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
                }
            }
            Spacer()
            if isOn {
                Button {
                    vm.setLead(pod.podId)
                } label: {
                    HStack(spacing: 4) {
                        Image(systemName: isLead ? "largecircle.fill.circle" : "circle")
                            .foregroundColor(isLead ? c.primary : c.textMuted)
                        Text("Lead").font(FS.font.caption()).foregroundColor(isLead ? c.primary : c.textMuted)
                    }
                }
                .buttonStyle(.plain)
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
        section("WEB DOMAINS", c: c) {
            VStack(spacing: FS.space.s3) {
                if let canonical = vm.canonicalUrlPreview(for: username) {
                    domainRow(
                        fqdn: canonical,
                        kindLabel: "Canonical",
                        kindPillKind: .online,
                        resolvesTo: leadDestinationLabel,
                        action: nil,
                        c: c
                    )
                }
                ForEach(pods.filter { vm.runOnPodIds.contains($0.podId) }) { pod in
                    let url = vm.perPodUrlPreview(for: username, podName: pod.name)
                    domainRow(
                        fqdn: url,
                        kindLabel: "Pod alias",
                        kindPillKind: .idle,
                        resolvesTo: pod.name,
                        action: nil,
                        c: c
                    )
                }
                ForEach(vm.customUrls, id: \.self) { url in
                    customDomainCard(url: url, c: c)
                }
                addCustomDomain(c: c)
            }
        }
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
                    FSField(value: $vm.newCustomUrlDraft, label: "", placeholder: "app.mydomain.com")
                    FSGhostButton("Add") { vm.addCustomUrl() }
                }
                Text("Custom domains need a DNS CNAME to your pod. Setup hints appear after you add.")
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
