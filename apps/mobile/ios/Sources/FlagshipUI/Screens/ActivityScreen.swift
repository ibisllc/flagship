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
                switch state {
                case .idle, .loading:
                    skeletons
                case .failed(let msg):
                    ErrorCard(message: msg)
                case .loaded(let feed):
                    section("BOX APPROVALS", c: c) {
                        approvalsEntryCard(c: c)
                    }
                    if let snap = feed.postRecovery {
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
                    section("RECENT DEPLOYS", c: c) {
                        if feed.recentInstalls.isEmpty {
                            FSCard {
                                Text("Nothing yet.").foregroundColor(c.textMuted)
                            }
                        } else {
                            FSCard {
                                VStack(spacing: FS.space.s3) {
                                    ForEach(feed.recentInstalls.indices, id: \.self) { i in
                                        let e = feed.recentInstalls[i]
                                        installRow(event: e, c: c)
                                        if i < feed.recentInstalls.count - 1 {
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
        if snap.lastReissue != nil { return "Re-attach finished." }
        if snap.state.lastSeen != nil { return "Re-attach in progress." }
        return "Snapshot ready."
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
            Image(systemName: auditIcon(for: event.eventKind))
                .foregroundColor(auditColor(for: event.eventKind, c: c))
                .frame(width: 22)
            VStack(alignment: .leading, spacing: 2) {
                Text(auditLabel(for: event.eventKind)).foregroundColor(c.text)
                if !event.detail.isEmpty {
                    Text(event.detail).font(FS.font.bodySm()).foregroundColor(c.textMuted)
                }
            }
            Spacer()
            Text(relative(ms: event.postedAt)).font(FS.font.caption()).foregroundColor(c.textMuted)
        }
    }

    private func auditIcon(for kind: String) -> String {
        switch kind {
        case "device-disconnected": return "lock.open.trianglebadge.exclamationmark"
        case "device-replaced":     return "arrow.triangle.2.circlepath.circle"
        case "device-added":        return "plus.circle"
        case "wipe-restart":        return "trash.fill"
        case "recovery-set-up":     return "key.horizontal.fill"
        case "recovery-rotated":    return "arrow.triangle.2.circlepath"
        case "app-renamed":         return "link.circle"
        case "server-created":      return "server.rack"
        case "server-online":       return "checkmark.seal.fill"
        default:                    return "circle.fill"
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
        default:                    return c.textMuted
        }
    }

    private func auditLabel(for kind: String) -> String {
        switch kind {
        case "device-disconnected": return "Disconnected device"
        case "device-replaced":     return "Replaced device"
        case "device-added":        return "Added device"
        case "wipe-restart":        return "Wiped & restarted account"
        case "recovery-set-up":     return "Set up recovery"
        case "recovery-rotated":    return "Rotated recovery passkey"
        case "app-renamed":         return "Renamed app URL"
        case "server-created":      return "Created server"
        case "server-online":       return "Server came online"
        default:                    return kind
        }
    }

    private func installRow(event: RecentInstallEvent, c: FSColors) -> some View {
        HStack(alignment: .top) {
            Image(systemName: icon(for: event.kind))
                .foregroundColor(color(for: event.kind, c: c))
                .frame(width: 22)
            VStack(alignment: .leading, spacing: 2) {
                Text("\(verb(event.kind)) \(event.serviceId)").foregroundColor(c.text)
                if let detail = event.detail {
                    Text(detail).font(FS.font.bodySm()).foregroundColor(c.textMuted)
                }
            }
            Spacer()
            Text(relative(ms: event.at)).font(FS.font.caption()).foregroundColor(c.textMuted)
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

    private func icon(for kind: String) -> String {
        switch kind {
        case "installed":     return "arrow.down.app.fill"
        case "uninstalled":   return "trash"
        case "deploy":        return "arrow.triangle.2.circlepath"
        case "update-pulled": return "arrow.triangle.pull"
        default:              return "circle.fill"
        }
    }
    private func color(for kind: String, c: FSColors) -> Color {
        switch kind {
        case "installed":   return c.success
        case "uninstalled": return c.danger
        case "deploy":      return c.primary
        default:            return c.textMuted
        }
    }
    private func verb(_ kind: String) -> String {
        switch kind {
        case "installed":     return "Deployed"
        case "uninstalled":   return "Removed"
        case "deploy":        return "Redeployed"
        case "update-pulled": return "Updated"
        default:              return kind
        }
    }
    private func relative(ms: Int64) -> String {
        let date = Date(timeIntervalSince1970: TimeInterval(ms) / 1000)
        let fmt = RelativeDateTimeFormatter()
        fmt.unitsStyle = .abbreviated
        return fmt.localizedString(for: date, relativeTo: Date())
    }
}
