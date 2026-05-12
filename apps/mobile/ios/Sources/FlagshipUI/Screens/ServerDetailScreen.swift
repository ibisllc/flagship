import SwiftUI
import FlagshipAPI

/// Drill-down view of a single server: TLS cert, uptime, version, SANs,
/// live monitoring (CPU / memory / disk / I/O), paired sessions count,
/// recent install timeline.
public struct ServerDetailScreen: View {
    @Environment(\.colorScheme) private var scheme
    let state: LoadingState<ServerDetailResponse>
    let metrics: LoadingState<ServerMetricsResponse>
    var onOpenSessions: () -> Void = {}
    var onOpenTier: () -> Void = {}
    var onRefresh: () async -> Void = {}

    public init(
        state: LoadingState<ServerDetailResponse>,
        metrics: LoadingState<ServerMetricsResponse>,
        onOpenSessions: @escaping () -> Void = {},
        onOpenTier: @escaping () -> Void = {},
        onRefresh: @escaping () async -> Void = {}
    ) {
        self.state = state
        self.metrics = metrics
        self.onOpenSessions = onOpenSessions
        self.onOpenTier = onOpenTier
        self.onRefresh = onRefresh
    }

    public var body: some View {
        let c = FSColors.scheme(scheme)
        ScrollView {
            VStack(alignment: .leading, spacing: FS.space.s6) {
                switch state {
                case .idle, .loading:
                    ServerCardSkeleton()
                case .failed(let msg):
                    ErrorCard(message: msg)
                case .loaded(let d):
                    overview(d: d, c: c)
                    MetricsSection(state: metrics)
                    cert(d: d, c: c)
                    deviceRow(d: d, c: c)
                    timeline(d: d, c: c)
                }
                Spacer().frame(height: FS.space.s12)
            }
            .padding(.horizontal, FS.space.s6)
            .padding(.top, FS.space.s4)
        }
        .background(c.bg.ignoresSafeArea())
        .navigationTitle("Server")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await onRefresh() }
    }

    private func overview(d: ServerDetailResponse, c: FSColors) -> some View {
        FSCard {
            VStack(alignment: .leading, spacing: FS.space.s2) {
                FSPill("Online", kind: .online)
                Text(d.serverFqdn)
                    .font(FS.font.mono())
                    .foregroundColor(c.text)
                HStack(spacing: FS.space.s4) {
                    stat("Apps", "\(d.appCount)", c: c)
                    stat("Sessions", "\(d.pairedSessionCount)", c: c)
                    stat("Daemon", d.daemonVersion, c: c)
                }
                Text("Up for \(uptime(ms: d.uptimeMs))")
                    .font(FS.font.bodySm())
                    .foregroundColor(c.textMuted)
            }
        }
    }

    private func cert(d: ServerDetailResponse, c: FSColors) -> some View {
        sectionWrap("TLS CERTIFICATE", c: c) {
            FSCard {
                if let after = d.certNotAfter, let before = d.certNotBefore {
                    VStack(alignment: .leading, spacing: FS.space.s2) {
                        labeled("Renews", relative(ms: after), c: c)
                        labeled("Issued", relative(ms: before), c: c)
                        if let sans = d.certSans, !sans.isEmpty {
                            Text("SANS").font(FS.font.caption()).foregroundColor(c.textMuted).padding(.top, FS.space.s2)
                            VStack(alignment: .leading, spacing: FS.space.s1) {
                                ForEach(sans, id: \.self) { san in
                                    Text(san).font(FS.font.mono()).foregroundColor(c.text)
                                }
                            }
                        }
                    }
                } else {
                    Text("No cert yet — provisioning…")
                        .foregroundColor(c.textMuted)
                }
            }
        }
    }

    private func deviceRow(d: ServerDetailResponse, c: FSColors) -> some View {
        sectionWrap("ACCESS", c: c) {
            VStack(spacing: FS.space.s3) {
                Button(action: onOpenSessions) {
                    FSCard {
                        HStack {
                            Image(systemName: "iphone.gen3").foregroundColor(c.primary)
                            Text("Paired devices")
                            Spacer()
                            Text("\(d.pairedSessionCount)").foregroundColor(c.textMuted)
                            Image(systemName: "chevron.right").foregroundColor(c.textMuted)
                        }
                    }
                }.buttonStyle(.plain)
                Button(action: onOpenTier) {
                    FSCard {
                        HStack {
                            Image(systemName: "creditcard").foregroundColor(c.primary)
                            Text("Tier & usage")
                            Spacer()
                            Image(systemName: "chevron.right").foregroundColor(c.textMuted)
                        }
                    }
                }.buttonStyle(.plain)
            }
        }
    }

    private func timeline(d: ServerDetailResponse, c: FSColors) -> some View {
        sectionWrap("TIMELINE", c: c) {
            if d.recentInstallEvents.isEmpty {
                FSCard { Text("Nothing yet.").foregroundColor(c.textMuted) }
            } else {
                FSCard {
                    VStack(spacing: FS.space.s3) {
                        ForEach(d.recentInstallEvents.indices, id: \.self) { i in
                            let e = d.recentInstallEvents[i]
                            HStack(alignment: .top) {
                                Circle().fill(c.primary).frame(width: 6, height: 6).padding(.top, 6)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text("\(verb(e.kind)) \(e.appId)").foregroundColor(c.text)
                                    if let detail = e.detail {
                                        Text(detail).font(FS.font.bodySm()).foregroundColor(c.textMuted)
                                    }
                                }
                                Spacer()
                                Text(relative(ms: e.at)).font(FS.font.caption()).foregroundColor(c.textMuted)
                            }
                            if i < d.recentInstallEvents.count - 1 {
                                Divider().background(c.border)
                            }
                        }
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func sectionWrap<C: View>(_ label: String, c: FSColors, @ViewBuilder content: () -> C) -> some View {
        VStack(alignment: .leading, spacing: FS.space.s3) {
            Text(label)
                .font(.system(size: 12, weight: .semibold))
                .tracking(1)
                .foregroundColor(c.textMuted)
            content()
        }
    }

    private func stat(_ label: String, _ value: String, c: FSColors) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(value).font(.system(size: 17, weight: .semibold)).foregroundColor(c.text)
            Text(label).font(.system(size: 11)).foregroundColor(c.textMuted)
        }
    }

    private func labeled(_ label: String, _ value: String, c: FSColors) -> some View {
        HStack {
            Text(label).font(FS.font.caption()).foregroundColor(c.textMuted)
            Spacer()
            Text(value).font(FS.font.body()).foregroundColor(c.text)
        }
    }

    private func uptime(ms: Int64) -> String {
        let seconds = Int(ms / 1000)
        let days = seconds / 86400
        let hours = (seconds % 86400) / 3600
        if days > 0 { return "\(days) days" }
        if hours > 0 { return "\(hours) hours" }
        return "\((seconds % 3600) / 60) minutes"
    }

    private func relative(ms: Int64) -> String {
        let date = Date(timeIntervalSince1970: TimeInterval(ms) / 1000)
        let fmt = RelativeDateTimeFormatter()
        fmt.unitsStyle = .full
        return fmt.localizedString(for: date, relativeTo: Date())
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
}
