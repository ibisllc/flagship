import SwiftUI
import FlagshipAPI
import FlagshipCore

/// Activity-tab landing: accordion sections (approvals, post-recovery,
/// account events, this server's log), one open at a time.
public struct ActivityScreen: View {
    @Environment(\.colorScheme) private var scheme
    @Environment(\.horizontalSizeClass) private var sizeClass
    let state: LoadingState<ActivityFeed>
    let pods: [PodInfo]
    let currentPodId: String?
    let leaderPodId: String?
    var onPickPod: (PodInfo) -> Void = { _ in }
    /// "All servers" filter selection — clears the per-server scoping.
    var onPickAll: () -> Void = {}
    /// The pending approvals, listed and answered inside their section.
    var approvals: SecretRequestsModel?
    /// Bumped to expand the approvals section (a boot-approval push or link).
    var openApprovals: Int = 0
    var onOpenPostRecovery: () -> Void = {}
    /// P5 — push the dedicated full-page audit-log viewer.
    var onOpenAuditLog: () -> Void = {}
    var onRefresh: () async -> Void = {}
    var onLoadMoreAudit: () async -> Void = {}
    var onLoadMoreBox: () async -> Void = {}

    private enum Open: Hashable { case approvals, recovery, account, server }
    /// One section open at a time, so every title stays on screen.
    @State private var open: Open? = nil
    @State private var loadingMore = false
    @Environment(\.dynamicTypeSize) private var typeSize
    @ScaledMetric(relativeTo: .body) private var listMaxHeight: CGFloat = 360
    @ScaledMetric(relativeTo: .body) private var tile: CGFloat = 32

    public init(
        state: LoadingState<ActivityFeed>,
        pods: [PodInfo] = [],
        currentPodId: String? = nil,
        leaderPodId: String? = nil,
        onPickPod: @escaping (PodInfo) -> Void = { _ in },
        onPickAll: @escaping () -> Void = {},
        approvals: SecretRequestsModel? = nil,
        openApprovals: Int = 0,
        onOpenPostRecovery: @escaping () -> Void = {},
        onOpenAuditLog: @escaping () -> Void = {},
        onRefresh: @escaping () async -> Void = {},
        onLoadMoreAudit: @escaping () async -> Void = {},
        onLoadMoreBox: @escaping () async -> Void = {}
    ) {
        self.state = state
        self.pods = pods
        self.currentPodId = currentPodId
        self.leaderPodId = leaderPodId
        self.onPickPod = onPickPod
        self.onPickAll = onPickAll
        self.approvals = approvals
        self.openApprovals = openApprovals
        self.onOpenPostRecovery = onOpenPostRecovery
        self.onOpenAuditLog = onOpenAuditLog
        self.onRefresh = onRefresh
        self.onLoadMoreAudit = onLoadMoreAudit
        self.onLoadMoreBox = onLoadMoreBox
    }

    @ViewBuilder private var podSwitcherIfMulti: some View {
        if pods.count > 1 {
            PodSwitcher(
                pods: pods,
                currentPodId: currentPodId,
                leaderPodId: leaderPodId,
                onPick: onPickPod,
                allLabel: String(localized: "All servers"),
                onPickAll: onPickAll
            )
        }
    }

    private struct SectionInfo: Identifiable {
        let id: Open
        let icon: String
        let title: String
        let hint: String
        var count: Int? = nil
    }

    /// The sections that exist right now, in order. Approvals is ALWAYS
    /// reachable, outside the load state: a box waiting for an unlock or
    /// entitlement approval is exactly the case where the daemon BFF (and
    /// thus this feed) can't load, so gating the approvals entry behind
    /// `.loaded` hid it precisely when needed.
    private var sectionInfos: [SectionInfo] {
        var out = [SectionInfo(id: .approvals, icon: "lock.open", title: String(localized: "Server approvals"),
                               hint: String(localized: "Servers waiting for you to start them"), count: approvals?.pendingCount)]
        guard case .loaded(let feed) = state else { return out }
        if let snap = feed.postRecovery, snap.lastReissue != nil || snap.state.lastSeen != nil {
            out.append(SectionInfo(id: .recovery, icon: "arrow.triangle.2.circlepath", title: String(localized: "Post-recovery"), hint: postRecoveryHeadline(snap)))
        }
        out.append(SectionInfo(id: .account, icon: "person.crop.circle", title: String(localized: "Your account"),
                               hint: String(localized: "Devices, recovery and servers, across all your servers"), count: feed.auditEvents.count))
        let n = feed.boxEvents.filter { BoxEventLabels.title($0) != nil }.count
        out.append(SectionInfo(id: .server, icon: "server.rack", title: serverTitle,
                               hint: showsAllServers ? String(localized: "Updates, backups, apps and shares across all servers") : String(localized: "Updates, backups, apps and shares on this server"), count: n))
        return out
    }

    @ViewBuilder
    private func sectionContent(_ which: Open, bounded: Bool, c: FSColors) -> some View {
        switch which {
        case .approvals:
            if let approvals { SecretRequestsPanel(model: approvals, bounded: bounded) }
        case .recovery:
            if case .loaded(let feed) = state, let snap = feed.postRecovery { postRecoveryCard(snap, c: c) }
        case .account:
            if case .loaded(let feed) = state {
                eventList(
                    empty: String(localized: "Nothing has happened on your account yet."),
                    rows: feed.auditEvents.indices.map { i in AnyView(auditRow(event: feed.auditEvents[i], c: c)) },
                    more: feed.moreAudit, onMore: onLoadMoreAudit, bounded: bounded, c: c)
            }
        case .server:
            if case .loaded(let feed) = state {
                let rows = feed.boxEvents.filter { BoxEventLabels.title($0) != nil }
                eventList(
                    empty: showsAllServers ? String(localized: "Nothing has happened on your servers yet.") : String(localized: "Nothing has happened on this server yet."),
                    rows: rows.indices.map { i in AnyView(boxRow(entry: rows[i], c: c)) },
                    more: feed.moreBoxEvents, onMore: onLoadMoreBox, bounded: bounded, c: c)
            }
        }
    }

    /// Regular width: the sections on the left, the selected one's log on the right.
    private var selectedSection: Open {
        if let open { return open }
        if case .loaded = state { return .account }
        return .approvals
    }

    public var body: some View {
        let c = FSColors.scheme(scheme)
        Group {
            if sizeClass == .regular { splitBody(c: c) } else { compactBody(c: c) }
        }
        .background(c.bg.ignoresSafeArea())
        // A boot-approval push or link: the section opens with the request in it.
        .onChange(of: openApprovals, initial: true) { _, n in
            if n > 0 { open = .approvals }
        }
        .navigationTitle("Activity")
        .navigationBarTitleDisplayMode(sizeClass == .regular ? .inline : .large)
        // Top-right, above the large title. The PodSwitcher now presents its
        // panel as a popover, so it is no longer clipped by the nav bar here.
        .toolbar {
            if pods.count > 1 {
                ToolbarItem(placement: .topBarTrailing) {
                    podSwitcherIfMulti
                }
            }
        }
    }

    private func compactBody(c: FSColors) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: FS.space.s3) {
                ForEach(sectionInfos.prefix(1)) { info in
                    accordion(info, c: c) { sectionContent(info.id, bounded: true, c: c) }
                }
                switch state {
                case .idle, .loading:
                    skeletons
                case .failed(let msg):
                    ErrorCard(message: msg, retry: onRefresh)
                case .loaded:
                    ForEach(sectionInfos.dropFirst()) { info in
                        accordion(info, c: c) { sectionContent(info.id, bounded: true, c: c) }
                    }
                }
                Spacer().frame(height: FS.space.s12)
            }
            .padding(.horizontal, FS.space.s6)
            .padding(.top, FS.space.s2)
            .fsReadingColumn()
        }
        .refreshable { await onRefresh() }
    }

    private func splitBody(c: FSColors) -> some View {
        HStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: FS.space.s2) {
                    ForEach(sectionInfos) { info in sectionRow(info, c: c) }
                    if case .failed(let msg) = state { ErrorCard(message: msg, retry: onRefresh) }
                    if case .idle = state { skeletons } else if case .loading = state { skeletons }
                }
                .padding(FS.space.s4)
            }
            .frame(width: 340)
            .background(c.sidebar.opacity(0.5))
            Divider()
            ScrollView {
                VStack(alignment: .leading, spacing: FS.space.s4) {
                    if let info = sectionInfos.first(where: { $0.id == selectedSection }) {
                        Text(info.title).font(FS.font.h3()).foregroundColor(c.text)
                            .accessibilityAddTraits(.isHeader)
                        Text(info.hint).font(FS.font.bodySm()).foregroundColor(c.textMuted)
                    }
                    sectionContent(selectedSection, bounded: false, c: c)
                }
                .padding(FS.space.s6)
                .frame(maxWidth: 720, alignment: .leading)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .refreshable { await onRefresh() }
        }
    }

    private func sectionRow(_ info: SectionInfo, c: FSColors) -> some View {
        let selected = selectedSection == info.id
        return Button {
            withAnimation(.snappy) { open = info.id }
        } label: {
            HStack(spacing: FS.space.s3) {
                if !typeSize.isAccessibilitySize {
                    Image(systemName: info.icon)
                        .font(FS.font.scaled(15, weight: .semibold))
                        .foregroundColor(c.accent)
                        .fsTile(tile, base: 32)
                        .background(c.softTint(), in: RoundedRectangle(cornerRadius: FS.radius.sm, style: .continuous))
                        .accessibilityHidden(true)
                }
                VStack(alignment: .leading, spacing: 2) {
                    Text(info.title).font(FS.font.scaled(17, weight: .semibold)).foregroundColor(c.text)
                        .multilineTextAlignment(.leading)
                    Text(info.hint).font(FS.font.scaled(13)).foregroundColor(c.textMuted).multilineTextAlignment(.leading)
                }
                Spacer(minLength: FS.space.s2)
                if let count = info.count, count > 0 {
                    Text("\(count)").font(FS.font.scaled(13, weight: .medium)).foregroundColor(c.textMuted)
                        .padding(.horizontal, 8).padding(.vertical, 2)
                        .background(c.surfaceSunken, in: Capsule())
                }
            }
            .padding(FS.space.s3)
            .frame(maxWidth: .infinity, minHeight: 56, alignment: .leading)
            .background(selected ? c.surface : Color.clear, in: RoundedRectangle(cornerRadius: FS.radius.md, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: FS.radius.md, style: .continuous).stroke(selected ? c.border : Color.clear, lineWidth: 1))
            .contentShape(Rectangle())
        }
        .buttonStyle(FSRowPressStyle())
        .sensoryFeedback(.selection, trigger: selected) { _, now in now }
        .accessibilityIdentifier("activity-section-\(String(describing: info.id))")
        .accessibilityAddTraits(selected ? [.isHeader, .isSelected] : .isHeader)
    }

    private func postRecoveryCard(_ snap: PostRecoverySnapshot, c: FSColors) -> some View {
        FSCard {
            VStack(alignment: .leading, spacing: FS.space.s2) {
                HStack(spacing: FS.space.s2) {
                    if snap.lastReissue != nil {
                        Image(systemName: "checkmark.seal.fill").foregroundColor(c.success)
                    } else if snap.state.lastSeen != nil {
                        Image(systemName: "clock.fill").foregroundColor(c.accent)
                    } else {
                        Image(systemName: "info.circle.fill").foregroundColor(c.textMuted)
                    }
                    Text(postRecoveryHeadline(snap)).foregroundColor(c.text)
                    Spacer()
                }
                if let r = snap.lastReissue {
                    Text([r.totalRewritten == 1 ? String(localized: "\(r.totalRewritten) row rewritten") : String(localized: "\(r.totalRewritten) rows rewritten"), r.reattachedCount == 1 ? String(localized: "\(r.reattachedCount) app") : String(localized: "\(r.reattachedCount) apps")].joined(separator: " · "))
                        .font(FS.font.bodySm())
                        .foregroundColor(c.textMuted)
                }
                FSPrimaryButton(String(localized: "View report"), block: true, action: onOpenPostRecovery)
            }
        }
    }

    private func postRecoveryHeadline(_ snap: PostRecoverySnapshot) -> String {
        snap.lastReissue != nil ? String(localized: "Re-attach finished.") : String(localized: "Re-attach in progress.")
    }

    /// Account-level audit event row. Mirrors webapp activity.js'
    /// audit section + Android's pending C11 mirror.
    private func auditRow(event: AuditEvent, c: FSColors) -> some View {
        eventRow(
            symbol: AuditLogViewModel.icon(for: event.eventKind),
            tint: auditColor(for: event.eventKind, c: c),
            title: AuditLogViewModel.label(for: event.eventKind),
            titleColor: c.text,
            detail: AuditLogViewModel.displayDetail(for: event),
            when: relative(ms: event.postedAt), c: c)
    }

    /// One log line: a tinted symbol tile, what happened, and when under it.
    /// The time sits under the text (not beside it) so long details keep
    /// their width at every text size.
    private func eventRow(symbol: String, tint: Color, title: String, titleColor: Color,
                          detail: String?, when: String, c: FSColors) -> some View {
        HStack(alignment: .top, spacing: FS.space.s3) {
            Image(systemName: symbol)
                .font(FS.font.scaled(14, weight: .semibold))
                .foregroundColor(tint)
                .fsTile(tile * 0.9, base: 29)
                .background(tint.opacity(0.12), in: RoundedRectangle(cornerRadius: FS.radius.sm, style: .continuous))
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(FS.font.scaled(16)).foregroundColor(titleColor)
                if let detail, !detail.isEmpty {
                    Text(detail).font(FS.font.scaled(14)).foregroundColor(c.textMuted)
                }
                Text(when).font(FS.font.scaled(12)).foregroundColor(c.textMuted)
            }
            Spacer(minLength: 0)
        }
        .accessibilityElement(children: .combine)
    }

    private func auditColor(for kind: String, c: FSColors) -> Color {
        switch kind {
        case "wipe-restart":        return c.danger
        case "device-disconnected": return c.danger
        case "device-replaced":     return c.primary
        case "app-renamed":         return c.primary
        case "server-online":       return c.success
        case "server-created":      return c.primary
        case "server-revoked":      return c.danger
        case "server-unrevoked":    return c.success
        default:                    return c.textMuted
        }
    }

    private func boxRow(entry: BoxActivityEntry, c: FSColors) -> some View {
        eventRow(
            symbol: BoxEventLabels.symbol(entry),
            tint: entry.ok ? c.primary : c.warning,
            title: BoxEventLabels.title(entry) ?? "",
            titleColor: entry.ok ? c.text : c.warning,
            detail: entry.detail,
            when: relative(ms: entry.ts), c: c)
    }

    /// "Server · home2": the server this log belongs to (the one picked in the
    /// switcher, else the one in use). With several servers and none picked the
    /// log is every server's, so it says "All servers".
    private var showsAllServers: Bool {
        pods.count > 1 && !pods.contains { $0.podId == currentPodId }
    }

    private var serverTitle: String {
        if showsAllServers { return String(localized: "All servers") }
        let pod = pods.first { $0.podId == currentPodId } ?? (pods.count == 1 ? pods.first : nil)
        guard let name = pod?.name, !name.isEmpty else { return String(localized: "This server") }
        return String(localized: "Server · \(name)")
    }

    private func accordion<C: View>(_ info: SectionInfo, c: FSColors, @ViewBuilder content: () -> C) -> some View {
        let which = info.id, icon = info.icon, title = info.title, hint = info.hint, count = info.count
        let isOpen = open == which
        return VStack(alignment: .leading, spacing: 0) {
            Button {
                withAnimation(.spring(response: 0.38, dampingFraction: 0.86)) { open = isOpen ? nil : which }
            } label: {
                HStack(spacing: FS.space.s3) {
                    if !typeSize.isAccessibilitySize {
                        Image(systemName: icon)
                            .font(FS.font.scaled(15, weight: .semibold))
                            .foregroundColor(c.accent)
                            .fsTile(tile, base: 32)
                            .background(c.softTint(), in: RoundedRectangle(cornerRadius: FS.radius.sm, style: .continuous))
                            .accessibilityHidden(true)
                    }
                    VStack(alignment: .leading, spacing: 2) {
                        Text(title).font(FS.font.scaled(17, weight: .semibold)).foregroundColor(c.text)
                            .multilineTextAlignment(.leading)
                        Text(hint).font(FS.font.scaled(13)).foregroundColor(c.textMuted).multilineTextAlignment(.leading)
                    }
                    Spacer(minLength: FS.space.s2)
                    if let count, count > 0 {
                        Text("\(count)").font(FS.font.scaled(13, weight: .medium)).foregroundColor(c.textMuted)
                            .padding(.horizontal, 8).padding(.vertical, 2)
                            .background(c.surfaceSunken, in: Capsule())
                    }
                    Image(systemName: "chevron.down")
                        .font(FS.font.scaled(13, weight: .semibold))
                        .foregroundColor(c.textMuted)
                        .rotationEffect(.degrees(isOpen ? 180 : 0))
                }
                .padding(.horizontal, FS.space.s4)
                .padding(.vertical, FS.space.s3)
                .frame(minHeight: 56)
                .contentShape(Rectangle())
            }
            .buttonStyle(FSRowPressStyle())
            .sensoryFeedback(.selection, trigger: isOpen)
            .accessibilityIdentifier("activity-section-\(String(describing: which))")
            .accessibilityAddTraits(.isHeader)
            .accessibilityValue(isOpen ? "expanded" : "collapsed")
            if isOpen {
                Divider().background(c.border)
                content()
                    .padding(FS.space.s4)
                    .transition(.opacity)
            }
        }
        .background(c.surface)
        .clipShape(RoundedRectangle(cornerRadius: FS.radius.md, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: FS.radius.md, style: .continuous).stroke(c.border, lineWidth: 1))
    }

    /// The rolled-down list: scrolls inside a bounded height, so a long log
    /// never pushes the other titles off screen.
    private func eventList(empty: String, rows: [AnyView], more: Bool, onMore: @escaping () async -> Void, bounded: Bool = true, c: FSColors) -> some View {
        Group {
            if rows.isEmpty {
                Text(empty).font(FS.font.scaled(15)).foregroundColor(c.textMuted)
            } else {
                let list = VStack(spacing: FS.space.s3) {
                    ForEach(rows.indices, id: \.self) { i in
                        rows[i]
                        if i < rows.count - 1 { Divider().background(c.border) }
                    }
                    if more {
                        FSSecondaryButton(loadingMore ? String(localized: "Loading…") : String(localized: "Load more"), block: true) {
                            guard !loadingMore else { return }
                            loadingMore = true
                            Task { await onMore(); loadingMore = false }
                        }
                        .disabled(loadingMore)
                        .accessibilityIdentifier("activity-load-more")
                    } else {
                        Text("That's everything.").font(FS.font.caption()).foregroundColor(c.textMuted)
                    }
                }
                if bounded {
                    ScrollView { list }.frame(maxHeight: listMaxHeight)
                } else {
                    list
                }
            }
        }
    }

    private var skeletons: some View {
        VStack(spacing: FS.space.s3) {
            ForEach(0..<3) { _ in ServerCardSkeleton() }
        }
    }

    /// Date and time to the minute ("Oct 17, 2:45 PM"; the year when it isn't this one).
    private func relative(ms: Int64) -> String {
        let d = Date(timeIntervalSince1970: TimeInterval(ms) / 1000)
        let sameYear = Calendar.current.component(.year, from: d) == Calendar.current.component(.year, from: Date())
        let f = DateFormatter()
        f.setLocalizedDateFormatFromTemplate(sameYear ? String(localized: "MMMdjmm") : String(localized: "MMMdyjmm"))
        return f.string(from: d)
    }
}
