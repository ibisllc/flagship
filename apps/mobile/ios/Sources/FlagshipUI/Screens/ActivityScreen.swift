import SwiftUI
import FlagshipAPI
import FlagshipCore

/// Activity-tab landing. Three sections: pending unlock requests
/// (push-driven, top priority), recent install events, paired sessions.
public struct ActivityScreen: View {
    @Environment(\.colorScheme) private var scheme
    let state: LoadingState<ActivityFeed>
    let pods: [PodInfo]
    let currentPodId: String?
    let leaderPodId: String?
    var onPickPod: (PodInfo) -> Void = { _ in }
    var onApproveUnlock: (String) -> Void = { _ in }
    var onRefresh: () async -> Void = {}

    public init(
        state: LoadingState<ActivityFeed>,
        pods: [PodInfo] = [],
        currentPodId: String? = nil,
        leaderPodId: String? = nil,
        onPickPod: @escaping (PodInfo) -> Void = { _ in },
        onApproveUnlock: @escaping (String) -> Void = { _ in },
        onRefresh: @escaping () async -> Void = {}
    ) {
        self.state = state
        self.pods = pods
        self.currentPodId = currentPodId
        self.leaderPodId = leaderPodId
        self.onPickPod = onPickPod
        self.onApproveUnlock = onApproveUnlock
        self.onRefresh = onRefresh
    }

    @ViewBuilder private var podSwitcherIfMulti: some View {
        if pods.count > 1 {
            PodSwitcher(pods: pods, currentPodId: currentPodId, leaderPodId: leaderPodId, onPick: onPickPod)
        }
    }

    public var body: some View {
        let c = FSColors.scheme(scheme)
        ScrollView {
            VStack(alignment: .leading, spacing: FS.space.s6) {
                HStack {
                    Text("Activity")
                        .font(.system(size: 32, weight: .medium))
                        .foregroundColor(c.text)
                    Spacer()
                    podSwitcherIfMulti
                }
                .padding(.top, FS.space.s4)

                switch state {
                case .idle, .loading:
                    skeletons
                case .failed(let msg):
                    ErrorCard(message: msg)
                case .loaded(let feed):
                    if !feed.pendingUnlocks.isEmpty {
                        section("PENDING APPROVAL", c: c) {
                            VStack(spacing: FS.space.s3) {
                                ForEach(feed.pendingUnlocks, id: \.requestId) { req in
                                    pendingUnlockCard(req, c: c)
                                }
                            }
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
        }
        .background(c.bg.ignoresSafeArea())
        .refreshable { await onRefresh() }
    }

    private func pendingUnlockCard(_ req: PendingUnlockApproval, c: FSColors) -> some View {
        FSCard {
            VStack(alignment: .leading, spacing: FS.space.s2) {
                HStack {
                    FSPill("Awaiting you", kind: .renewing)
                    Spacer()
                    Text(relative(ms: req.requestedAt))
                        .font(FS.font.caption()).foregroundColor(c.textMuted)
                }
                Text(req.serverFqdn).font(FS.font.mono()).foregroundColor(c.text)
                if let ip = req.ip { Text(ip).font(FS.font.bodySm()).foregroundColor(c.textMuted) }
                FSPrimaryButton("Approve unlock", block: true) { onApproveUnlock(req.requestId) }
            }
        }
    }

    private func installRow(event: RecentInstallEvent, c: FSColors) -> some View {
        HStack(alignment: .top) {
            Image(systemName: icon(for: event.kind))
                .foregroundColor(color(for: event.kind, c: c))
                .frame(width: 22)
            VStack(alignment: .leading, spacing: 2) {
                Text("\(verb(event.kind)) \(event.appId)").foregroundColor(c.text)
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
