import SwiftUI
import FlagshipAPI
import FlagshipCore

/// Activity-tab landing. Three sections: pending unlock requests
/// (push-driven, top priority), recent install events, paired sessions.
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
        onRefresh: @escaping () async -> Void = {}
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
                section("BOX APPROVALS", c: c) {
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
                        section("POST-RECOVERY", c: c) {
                            postRecoveryCard(snap, c: c)
                        }
                    }
                    section("ACCOUNT EVENTS", c: c) {
                        VStack(alignment: .leading, spacing: FS.space.s3) {
                            if !feed.auditEvents.isEmpty {
                                FSCard {
                                    VStack(spacing: FS.space.s3) {
                                        ForEach(feed.auditEvents.indices, id: \.self) { i in
                                            let e = feed.auditEvents[i]
                                            auditRow(event: e, c: c)
                                            if i < feed.auditEvents.count - 1 {
                                                Divider().background(c.border)
                                            }
                                        }
                                    }
                                }
                            }
                            viewFullAuditLogRow(c: c)
                        }
                    }
                    section("ON THIS SERVER", c: c) {
                        let rows = feed.boxEvents.filter { BoxEventLabels.title($0) != nil }
                        if rows.isEmpty {
                            FSCard {
                                Text("Nothing has happened yet.").foregroundColor(c.textMuted)
                            }
                        } else {
                            FSCard {
                                VStack(spacing: FS.space.s3) {
                                    ForEach(rows.indices, id: \.self) { i in
                                        boxRow(entry: rows[i], c: c)
                                        if i < rows.count - 1 {
                                            Divider().background(c.border)
                                        }
                                    }
                                }
                            }
                        }
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
                Text("Approve a box's boot").foregroundColor(c.text)
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

    /// P5 — entry into the dedicated full-page audit-log viewer. Mirrors
    /// the webapp's "see all activity" link.
    private func viewFullAuditLogRow(c: FSColors) -> some View {
        Button(action: onOpenAuditLog) {
            FSCard {
                HStack {
                    Image(systemName: "list.bullet.rectangle").foregroundColor(c.primary)
                    Text("View full audit log").foregroundColor(c.text)
                    Spacer()
                    Image(systemName: "chevron.right").foregroundColor(c.textMuted)
                }
            }
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("activity-open-audit-log")
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

    @ViewBuilder
    private func section<C: View>(_ label: String, c: FSColors, @ViewBuilder content: () -> C) -> some View {
        VStack(alignment: .leading, spacing: FS.space.s3) {
            Text(label).font(.system(size: 12, weight: .semibold)).tracking(1).foregroundColor(c.textMuted)
            content()
        }
    }

    private var skeletons: some View {
        VStack(spacing: FS.space.s3) {
            ForEach(0..<3) { _ in ServerCardSkeleton() }
        }
    }

    private func relative(ms: Int64) -> String {
        Date.flagshipFormatted(epochMs: ms)
    }
}
