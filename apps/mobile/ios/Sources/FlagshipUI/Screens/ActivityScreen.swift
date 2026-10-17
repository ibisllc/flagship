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
    var onOpenApprovals: () -> Void = {}
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

    public init(
        state: LoadingState<ActivityFeed>,
        pods: [PodInfo] = [],
        currentPodId: String? = nil,
        leaderPodId: String? = nil,
        onPickPod: @escaping (PodInfo) -> Void = { _ in },
        onPickAll: @escaping () -> Void = {},
        onOpenApprovals: @escaping () -> Void = {},
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
        self.onOpenApprovals = onOpenApprovals
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
                allLabel: "All servers",
                onPickAll: onPickAll
            )
        }
    }

    public var body: some View {
        let c = FSColors.scheme(scheme)
        ScrollView {
            VStack(alignment: .leading, spacing: FS.space.s6) {
                // ALWAYS reachable, OUTSIDE the state switch: a box waiting for
                // an unlock/entitlement approval is exactly the case where the
                // daemon BFF (and thus this feed) can't load, so gating the
                // approvals entry behind `.loaded` hid it precisely when needed.
                accordion(.approvals, title: "Server approvals", hint: "Servers waiting for you to start them", c: c) {
                    approvalsEntryCard(c: c)
                }
                switch state {
                case .idle, .loading:
                    skeletons
                case .failed(let msg):
                    ErrorCard(message: msg)
                case .loaded(let feed):
                    if let snap = feed.postRecovery,
                       snap.lastReissue != nil || snap.state.lastSeen != nil {
                        accordion(.recovery, title: "Post-recovery", hint: postRecoveryHeadline(snap), c: c) {
                            postRecoveryCard(snap, c: c)
                        }
                    }
                    accordion(.account, title: "Your account", hint: "Devices, recovery and servers, across all your servers", count: feed.auditEvents.count, c: c) {
                        eventList(
                            empty: "Nothing has happened on your account yet.",
                            rows: feed.auditEvents.indices.map { i in AnyView(auditRow(event: feed.auditEvents[i], c: c)) },
                            more: feed.moreAudit, onMore: onLoadMoreAudit, c: c)
                    }
                    let rows = feed.boxEvents.filter { BoxEventLabels.title($0) != nil }
                    accordion(.server, title: serverTitle, hint: "Updates, backups, apps and shares on this server", count: rows.count, c: c) {
                        eventList(
                            empty: "Nothing has happened on this server yet.",
                            rows: rows.indices.map { i in AnyView(boxRow(entry: rows[i], c: c)) },
                            more: feed.moreBoxEvents, onMore: onLoadMoreBox, c: c)
                    }
                }
                Spacer().frame(height: FS.space.s12)
            }
            .padding(.horizontal, FS.space.s6)
            .padding(.top, FS.space.s2)
            .fsReadingColumn()
        }
        .background(c.bg.ignoresSafeArea())
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
        .refreshable { await onRefresh() }
    }

    /// Entry into the relay approval list. A box set to "authorize each
    /// boot" posts a sealed-key request and pushes the phone; this is the
    /// always-available in-app way to reach the same screen.
    private func approvalsEntryCard(c: FSColors) -> some View {
        FSCard {
            VStack(alignment: .leading, spacing: FS.space.s2) {
                Text("Approve a server's boot").foregroundColor(c.text)
                Text("Servers set to ask on every boot wait here for you to release their disk key.")
                    .font(FS.font.caption()).foregroundColor(c.textMuted)
                FSPrimaryButton("Open approvals", block: true, action: onOpenApprovals)
            }
        }
    }

    private func postRecoveryCard(_ snap: PostRecoverySnapshot, c: FSColors) -> some View {
        FSCard {
            VStack(alignment: .leading, spacing: FS.space.s2) {
                HStack(spacing: FS.space.s2) {
                    if snap.lastReissue != nil {
                        Image(systemName: "checkmark.seal.fill").foregroundColor(c.success)
                    } else if snap.state.lastSeen != nil {
                        Image(systemName: "clock.fill").foregroundColor(c.primary)
                    } else {
                        Image(systemName: "info.circle.fill").foregroundColor(c.textMuted)
                    }
                    Text(postRecoveryHeadline(snap)).foregroundColor(c.text)
                    Spacer()
                }
                if let r = snap.lastReissue {
                    Text("\(r.totalRewritten) row\(r.totalRewritten == 1 ? "" : "s") rewritten · \(r.reattachedCount) app\(r.reattachedCount == 1 ? "" : "s")")
                        .font(FS.font.bodySm())
                        .foregroundColor(c.textMuted)
                }
                FSPrimaryButton("View report", block: true, action: onOpenPostRecovery)
            }
        }
    }

    private func postRecoveryHeadline(_ snap: PostRecoverySnapshot) -> String {
        snap.lastReissue != nil ? "Re-attach finished." : "Re-attach in progress."
    }

    /// Account-level audit event row. Mirrors webapp activity.js'
    /// audit section + Android's pending C11 mirror.
    private func auditRow(event: AuditEvent, c: FSColors) -> some View {
        HStack(alignment: .top) {
            Image(systemName: AuditLogViewModel.icon(for: event.eventKind))
                .foregroundColor(auditColor(for: event.eventKind, c: c))
                .frame(width: 22)
            VStack(alignment: .leading, spacing: 2) {
                Text(AuditLogViewModel.label(for: event.eventKind)).foregroundColor(c.text)
                if let detail = AuditLogViewModel.displayDetail(for: event) {
                    Text(detail).font(FS.font.bodySm()).foregroundColor(c.textMuted)
                }
            }
            Spacer()
            Text(relative(ms: event.postedAt)).font(FS.font.caption()).foregroundColor(c.textMuted)
        }
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
        HStack(alignment: .top) {
            Image(systemName: BoxEventLabels.symbol(entry))
                .foregroundColor(entry.ok ? c.primary : c.warning)
                .frame(width: 22)
            VStack(alignment: .leading, spacing: 2) {
                Text(BoxEventLabels.title(entry) ?? "").foregroundColor(entry.ok ? c.text : c.warning)
                if let detail = entry.detail, !detail.isEmpty {
                    Text(detail).font(FS.font.bodySm()).foregroundColor(c.textMuted)
                }
            }
            Spacer()
            Text(relative(ms: entry.ts)).font(FS.font.caption()).foregroundColor(c.textMuted)
        }
    }

    /// "Server · home2": the server this log belongs to (the one picked in the
    /// switcher, else the one in use).
    private var serverTitle: String {
        let pod = pods.first { $0.podId == currentPodId } ?? (pods.count == 1 ? pods.first : nil)
        guard let name = pod?.name, !name.isEmpty else { return "This server" }
        return "Server · \(name)"
    }

    private func accordion<C: View>(_ which: Open, title: String, hint: String, count: Int? = nil, c: FSColors, @ViewBuilder content: () -> C) -> some View {
        let isOpen = open == which
        return VStack(alignment: .leading, spacing: 0) {
            Button {
                withAnimation(.easeInOut(duration: 0.2)) { open = isOpen ? nil : which }
            } label: {
                HStack(spacing: FS.space.s3) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(title).font(.system(size: 16, weight: .semibold)).foregroundColor(c.text)
                        Text(hint).font(FS.font.caption()).foregroundColor(c.textMuted).multilineTextAlignment(.leading)
                    }
                    Spacer()
                    if let count, count > 0 {
                        Text("\(count)").font(FS.font.caption()).foregroundColor(c.textMuted)
                    }
                    Image(systemName: "chevron.down").foregroundColor(c.textMuted)
                        .rotationEffect(.degrees(isOpen ? 180 : 0))
                }
                .padding(FS.space.s4)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("activity-section-\(String(describing: which))")
            .accessibilityAddTraits(.isHeader)
            .accessibilityValue(isOpen ? "expanded" : "collapsed")
            if isOpen {
                Divider().background(c.border)
                content()
                    .padding(FS.space.s4)
            }
        }
        .background(c.surface)
        .clipShape(RoundedRectangle(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).stroke(c.border, lineWidth: 1))
    }

    /// The rolled-down list: scrolls inside a bounded height, so a long log
    /// never pushes the other titles off screen.
    private func eventList(empty: String, rows: [AnyView], more: Bool, onMore: @escaping () async -> Void, c: FSColors) -> some View {
        Group {
            if rows.isEmpty {
                Text(empty).foregroundColor(c.textMuted)
            } else {
                ScrollView {
                    VStack(spacing: FS.space.s3) {
                        ForEach(rows.indices, id: \.self) { i in
                            rows[i]
                            Divider().background(c.border)
                        }
                        if more {
                            FSSecondaryButton(loadingMore ? "Loading…" : "Load more", block: true) {
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
                }
                .frame(maxHeight: 360)
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
        f.setLocalizedDateFormatFromTemplate(sameYear ? "MMMdjmm" : "MMMdyjmm")
        return f.string(from: d)
    }
}
