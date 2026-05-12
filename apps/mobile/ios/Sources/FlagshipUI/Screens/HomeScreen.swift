import SwiftUI
import FlagshipAPI
import FlagshipCore

/// Home / landing screen. Account-wide overview: greeting, quick
/// actions, list of all servers (with Add server), and the recent
/// activity timeline. Per-server detail lives behind ServerDetail.
public struct HomeScreen: View {
    @Environment(\.colorScheme) private var scheme
    let state: LoadingState<ServerDetailResponse>
    let username: String
    let pods: [PodInfo]
    let leaderPodId: String?
    var onOpenPod: (PodInfo) -> Void = { _ in }
    var onAddServer: () -> Void = {}
    var onSetLeader: (PodInfo) -> Void = { _ in }
    var onVibeCode: () -> Void = {}
    var onBrowseMarketplace: () -> Void = {}
    var onRefresh: () async -> Void = {}

    public init(
        state: LoadingState<ServerDetailResponse>,
        username: String,
        pods: [PodInfo],
        leaderPodId: String?,
        onOpenPod: @escaping (PodInfo) -> Void = { _ in },
        onAddServer: @escaping () -> Void = {},
        onSetLeader: @escaping (PodInfo) -> Void = { _ in },
        onVibeCode: @escaping () -> Void = {},
        onBrowseMarketplace: @escaping () -> Void = {},
        onRefresh: @escaping () async -> Void = {}
    ) {
        self.state = state
        self.username = username
        self.pods = pods
        self.leaderPodId = leaderPodId
        self.onOpenPod = onOpenPod
        self.onAddServer = onAddServer
        self.onSetLeader = onSetLeader
        self.onVibeCode = onVibeCode
        self.onBrowseMarketplace = onBrowseMarketplace
        self.onRefresh = onRefresh
    }

    public var body: some View {
        let c = FSColors.scheme(scheme)
        ScrollView {
            VStack(alignment: .leading, spacing: FS.space.s6) {
                header(c: c)
                quickActions(c: c)
                serversSection(c: c)
                switch state {
                case .loaded(let d):
                    recentActivity(events: d.recentInstallEvents, c: c)
                case .failed(let msg):
                    ErrorCard(message: msg)
                default:
                    EmptyView()
                }
                Spacer().frame(height: FS.space.s12)
            }
            .padding(.horizontal, FS.space.s6)
        }
        .background(c.bg.ignoresSafeArea())
        .refreshable { await onRefresh() }
    }

    private func header(c: FSColors) -> some View {
        VStack(alignment: .leading, spacing: FS.space.s2) {
            Text("Welcome back,")
                .font(.system(size: 17))
                .foregroundColor(c.textMuted)
            Text(username + ".")
                .font(.system(size: 34, weight: .medium))
                .foregroundColor(c.text)
        }
        .padding(.top, FS.space.s10)
    }

    private func quickActions(c: FSColors) -> some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 280), spacing: FS.space.s3)], spacing: FS.space.s3) {
            actionRow(
                title: "Build a new app",
                subtitle: "Describe it in plain English. Your server builds and runs it.",
                systemImage: "sparkles",
                accent: c.primary,
                action: onVibeCode,
                c: c
            )
            actionRow(
                title: "Browse the marketplace",
                subtitle: "Deploy apps your neighbours have published.",
                systemImage: "square.grid.2x2",
                accent: c.success,
                action: onBrowseMarketplace,
                c: c
            )
        }
    }

    private func actionRow(title: String, subtitle: String, systemImage: String, accent: Color, action: @escaping () -> Void, c: FSColors) -> some View {
        Button(action: action) {
            FSCard {
                HStack(alignment: .top, spacing: FS.space.s3) {
                    ZStack {
                        RoundedRectangle(cornerRadius: FS.radius.sm)
                            .fill(accent.opacity(0.12))
                        Image(systemName: systemImage)
                            .foregroundColor(accent)
                            .font(.system(size: 17, weight: .semibold))
                    }
                    .frame(width: 36, height: 36)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(title).font(.system(size: 16, weight: .semibold)).foregroundColor(c.text)
                        Text(subtitle).font(FS.font.bodySm()).foregroundColor(c.textMuted)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    Spacer()
                    Image(systemName: "chevron.right").foregroundColor(c.textMuted)
                }
            }
        }
        .buttonStyle(.plain)
    }

    private func serversSection(c: FSColors) -> some View {
        VStack(alignment: .leading, spacing: FS.space.s3) {
            HStack {
                Text("YOUR SERVERS")
                    .font(.system(size: 12, weight: .semibold)).tracking(1).foregroundColor(c.textMuted)
                Spacer()
                Text("\(pods.count)")
                    .font(.system(size: 12, weight: .semibold)).foregroundColor(c.textMuted)
            }
            if pods.isEmpty {
                FSCard {
                    VStack(alignment: .leading, spacing: FS.space.s2) {
                        Text("No servers yet.").font(FS.font.body()).foregroundColor(c.text)
                        Text("Add your first one to start running apps.").font(FS.font.bodySm()).foregroundColor(c.textMuted)
                    }
                }
            } else {
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 280), spacing: FS.space.s3)], spacing: FS.space.s3) {
                    ForEach(pods) { pod in
                        Button(action: { onOpenPod(pod) }) {
                            PodCard(pod: pod, isLeader: pod.podId == leaderPodId)
                        }
                        .buttonStyle(.plain)
                        .contextMenu {
                            if pod.podId != leaderPodId {
                                Button {
                                    onSetLeader(pod)
                                } label: {
                                    Label("Make leader", systemImage: "crown.fill")
                                }
                            }
                            Button {
                                onOpenPod(pod)
                            } label: {
                                Label("Open", systemImage: "arrow.up.right.square")
                            }
                        }
                    }
                }
            }
            Button(action: onAddServer) {
                HStack(spacing: 8) {
                    Image(systemName: "plus.circle.fill").foregroundColor(c.primary)
                    Text("Add server").font(.system(size: 15, weight: .semibold)).foregroundColor(c.primary)
                    Spacer()
                }
                .padding(.horizontal, FS.space.s4)
                .padding(.vertical, FS.space.s3)
                .background(c.primary.opacity(0.08))
                .overlay(
                    RoundedRectangle(cornerRadius: FS.radius.md)
                        .stroke(c.primary.opacity(0.25), style: StrokeStyle(lineWidth: 1, dash: [4, 4]))
                )
                .clipShape(RoundedRectangle(cornerRadius: FS.radius.md))
            }
        }
    }

    private func recentActivity(events: [RecentInstallEvent], c: FSColors) -> some View {
        VStack(alignment: .leading, spacing: FS.space.s3) {
            Text("RECENT ACTIVITY")
                .font(.system(size: 12, weight: .semibold))
                .tracking(1)
                .foregroundColor(c.textMuted)
            if events.isEmpty {
                FSCard { Text("No recent activity.").foregroundColor(c.textMuted) }
            } else {
                FSCard {
                    VStack(spacing: FS.space.s3) {
                        ForEach(events.indices, id: \.self) { idx in
                            let e = events[idx]
                            HStack(alignment: .top) {
                                Image(systemName: icon(for: e.kind))
                                    .foregroundColor(color(for: e.kind, c: c))
                                    .frame(width: 22)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text("\(verb(for: e.kind)) \(e.appId)")
                                        .font(FS.font.body())
                                        .foregroundColor(c.text)
                                    if let detail = e.detail {
                                        Text(detail).font(FS.font.bodySm()).foregroundColor(c.textMuted)
                                    }
                                }
                                Spacer()
                                Text(relative(ms: e.at)).font(FS.font.caption()).foregroundColor(c.textMuted)
                            }
                            if idx < events.count - 1 {
                                Divider().background(c.border)
                            }
                        }
                    }
                }
            }
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
    private func verb(for kind: String) -> String {
        switch kind {
        case "installed":     return "Deployed"
        case "uninstalled":   return "Removed"
        case "deploy":        return "Redeployed"
        case "update-pulled": return "Updated"
        default:              return "Event:"
        }
    }
    private func relative(ms: Int64) -> String {
        let date = Date(timeIntervalSince1970: TimeInterval(ms) / 1000)
        let fmt = RelativeDateTimeFormatter()
        fmt.unitsStyle = .abbreviated
        return fmt.localizedString(for: date, relativeTo: Date())
    }
}

/// Reusable compact server card — used in Home grid + Settings list.
/// Renders the user-facing name + (optional) one-line description and
/// status; the FQDN is technical and only surfaced in ServerDetail.
/// A "Leader" badge appears when `isLeader` is true.
public struct PodCard: View {
    @Environment(\.colorScheme) private var scheme
    public let pod: PodInfo
    public let isLeader: Bool

    public init(pod: PodInfo, isLeader: Bool = false) {
        self.pod = pod
        self.isLeader = isLeader
    }

    public var body: some View {
        let c = FSColors.scheme(scheme)
        FSCard {
            HStack(alignment: .top, spacing: FS.space.s3) {
                ZStack {
                    RoundedRectangle(cornerRadius: FS.radius.sm)
                        .fill(c.primary.opacity(0.12))
                    Image(systemName: "server.rack")
                        .foregroundColor(c.primary)
                }
                .frame(width: 40, height: 40)
                VStack(alignment: .leading, spacing: 6) {
                    HStack(spacing: FS.space.s2) {
                        Text(pod.name)
                            .font(.system(size: 17, weight: .semibold))
                            .foregroundColor(c.text)
                            .lineLimit(1)
                            .truncationMode(.tail)
                        Spacer(minLength: 0)
                        Image(systemName: "chevron.right").foregroundColor(c.textMuted)
                    }
                    HStack(spacing: FS.space.s2) {
                        FSPill(statusLabel, kind: statusKind)
                        if isLeader { LeaderBadge() }
                        Spacer(minLength: 0)
                    }
                    if let desc = pod.description, !desc.isEmpty {
                        Text(desc)
                            .font(FS.font.bodySm())
                            .foregroundColor(c.textMuted)
                            .lineLimit(2)
                            .truncationMode(.tail)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
        }
    }
    private var statusLabel: String {
        switch pod.status {
        case .online:  return "Online"
        case .offline: return "Offline"
        case .unknown: return "Checking"
        }
    }
    private var statusKind: FSPillKind {
        switch pod.status {
        case .online:  return .online
        case .offline: return .offline
        case .unknown: return .idle
        }
    }
}

/// Small badge marking the leader pod. Leader = default holder of the
/// short canonical domain for apps (e.g. `<app>.<user>.flagship.services`
/// resolves to the leader unless an app overrides it).
public struct LeaderBadge: View {
    @Environment(\.colorScheme) private var scheme
    public init() {}
    public var body: some View {
        let c = FSColors.scheme(scheme)
        HStack(spacing: 4) {
            Image(systemName: "crown.fill").font(.system(size: 9))
            Text("Leader").font(.system(size: 11, weight: .semibold))
        }
        .foregroundColor(c.primary)
        .padding(.horizontal, 8)
        .padding(.vertical, 2)
        .background(c.primary.opacity(0.12))
        .clipShape(Capsule())
    }
}
