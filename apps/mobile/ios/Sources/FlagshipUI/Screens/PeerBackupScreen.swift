import SwiftUI
import FlagshipAPI
import FlagshipCore

/// P9 — peer-backup management. Mirrors the canonical webapp
/// `views/peer-backup.js`: participation toggle + the two peer lists
/// (peers backing you up / peers you back up) + shard health stats +
/// repair status.
public struct PeerBackupScreen: View {
    @Environment(\.colorScheme) private var scheme
    @State private var vm: PeerBackupViewModel

    public init(vm: PeerBackupViewModel) {
        _vm = State(initialValue: vm)
    }

    public var body: some View {
        let c = FSColors.scheme(scheme)
        ScrollView {
            VStack(alignment: .leading, spacing: FS.space.s6) {
                switch vm.state {
                case .idle, .loading:
                    ForEach(0..<2, id: \.self) { _ in ServerCardSkeleton() }
                case .failed(let msg):
                    ErrorCard(message: msg)
                case .loaded(let s):
                    participationCard(s, c: c)
                    statsSection(s.stats, c: c)
                    peersBackingYouUpSection(s.peersBackingYouUp, c: c)
                    peersYouBackUpSection(s.peersYouBackUp, c: c)
                    if !s.shards.isEmpty { shardsSection(s.shards, c: c) }
                    repairSection(s.repair, c: c)
                }
                Spacer().frame(height: FS.space.s12)
            }
            .padding(.horizontal, FS.space.s6)
            .padding(.top, FS.space.s4)
        }
        .background(c.bg.ignoresSafeArea())
        .navigationTitle("Peer-backup")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await vm.load() }
        .task {
            if case .idle = vm.state { await vm.load() }
        }
    }

    // MARK: - Sections

    private func participationCard(_ s: PeerBackupStatusResponse, c: FSColors) -> some View {
        FSCard {
            VStack(alignment: .leading, spacing: FS.space.s2) {
                HStack(alignment: .top) {
                    VStack(alignment: .leading, spacing: 2) {
                        HStack(spacing: 8) {
                            Text("Peer-backup pool")
                                .font(.system(size: 15, weight: .semibold))
                                .foregroundColor(c.text)
                            FSPill(
                                s.participating ? "participating" : "unenrolled",
                                kind: s.participating ? .online : .idle
                            )
                            .accessibilityIdentifier("peer-backup-participation-pill")
                        }
                        Text(s.participating
                             ? "You host shards for peers and they host yours. Opt out to leave the pool."
                             : "You're not in the peer-backup pool — enable to get started.")
                            .font(FS.font.caption())
                            .foregroundColor(c.textMuted)
                    }
                    Spacer()
                }
                Toggle(isOn: Binding(
                    get: { s.participating },
                    set: { _ in Task { await vm.toggle() } }
                )) {
                    Text(s.participating ? "Participating" : "Off")
                        .font(FS.font.bodySm())
                        .foregroundColor(c.text)
                }
                .tint(c.primary)
                .disabled(vm.togglePending)
                .accessibilityIdentifier("peer-backup-toggle")
            }
        }
    }

    @ViewBuilder
    private func statsSection(_ stats: PeerBackupStats, c: FSColors) -> some View {
        sectionHeader("Shard health", c: c)
        FSCard {
            VStack(spacing: FS.space.s2) {
                row("total shards", "\(stats.total)", c: c)
                row("durable", "\(stats.durable)", c: c)
                row("at risk", "\(stats.atRisk)", c: c)
                row("your bytes stored", fmtBytes(stats.yourBytesStored), c: c)
                row("peer bytes hosted", fmtBytes(stats.peerBytesHosted), c: c)
            }
        }
    }

    @ViewBuilder
    private func peersBackingYouUpSection(_ peers: [PeerBackupPeerHostingYou], c: FSColors) -> some View {
        sectionHeader("Peers backing you up", c: c)
        if peers.isEmpty {
            placeholderCard("No peers backing you up yet — repair daemon will recruit some next tick.", c: c)
        } else {
            VStack(spacing: FS.space.s3) {
                ForEach(peers) { p in
                    FSCard {
                        HStack(alignment: .top) {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(p.peerFqdn)
                                    .font(.system(size: 15, weight: .semibold))
                                    .foregroundColor(c.text)
                                HStack(spacing: 6) {
                                    Text("\(p.shardsHosted) shard\(p.shardsHosted == 1 ? "" : "s")")
                                    Text("·").foregroundColor(c.textMuted)
                                    Text("last seen \(fmtDate(p.lastSeenMs))")
                                }
                                .font(FS.font.caption())
                                .foregroundColor(c.textMuted)
                            }
                            Spacer()
                            FSPill(p.online ? "online" : "offline",
                                   kind: p.online ? .online : .offline)
                        }
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func peersYouBackUpSection(_ peers: [PeerBackupPeerYouHost], c: FSColors) -> some View {
        sectionHeader("Peers you back up", c: c)
        if peers.isEmpty {
            placeholderCard("Not hosting any peer shards yet — matchmaker hasn't paired you with anyone yet.", c: c)
        } else {
            VStack(spacing: FS.space.s3) {
                ForEach(peers) { p in
                    FSCard {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(p.peerFqdn)
                                .font(.system(size: 15, weight: .semibold))
                                .foregroundColor(c.text)
                            HStack(spacing: 6) {
                                Text("hosting \(p.shardsHosted) shard\(p.shardsHosted == 1 ? "" : "s")")
                                Text("·").foregroundColor(c.textMuted)
                                Text(fmtBytes(p.bytesHosted))
                                Text("·").foregroundColor(c.textMuted)
                                Text("last fetched \(fmtDate(p.lastFetchedMs))")
                            }
                            .font(FS.font.caption())
                            .foregroundColor(c.textMuted)
                        }
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func shardsSection(_ shards: [PeerBackupShardSummary], c: FSColors) -> some View {
        sectionHeader("Your shards", c: c)
        VStack(spacing: FS.space.s3) {
            ForEach(shards.prefix(20)) { s in
                FSCard {
                    HStack(alignment: .top) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(s.shardId)
                                .font(FS.font.mono())
                                .foregroundColor(c.text)
                                .lineLimit(1)
                                .truncationMode(.middle)
                            HStack(spacing: 6) {
                                Text("\(s.replicas)/\(s.minReplicas) replicas")
                                Text("·").foregroundColor(c.textMuted)
                                Text(fmtBytes(s.bytes))
                            }
                            .font(FS.font.caption())
                            .foregroundColor(c.textMuted)
                        }
                        Spacer()
                        FSPill(shardPillLabel(s), kind: shardPillKind(s))
                    }
                }
            }
            if shards.count > 20 {
                placeholderCard("+ \(shards.count - 20) more shards (not rendered)", c: c)
            }
        }
    }

    @ViewBuilder
    private func repairSection(_ repair: PeerBackupRepairStatus, c: FSColors) -> some View {
        sectionHeader("Repair status", c: c)
        FSCard {
            VStack(spacing: FS.space.s2) {
                row("state", repair.state, c: c)
                row("last tick", repair.lastTickMs.map(fmtDate) ?? "—", c: c)
                row("repairs queued", "\(repair.queued)", c: c)
                row("repairs done (24h)", "\(repair.completed24h)", c: c)
                if let err = repair.lastError, !err.isEmpty {
                    HStack {
                        Text("last error").foregroundColor(c.textMuted)
                        Spacer()
                        Text(err).foregroundColor(c.danger)
                    }
                }
            }
        }
    }

    // MARK: - Bits

    private func sectionHeader(_ title: String, c: FSColors) -> some View {
        Text(title).font(FS.font.h3()).foregroundColor(c.text)
    }

    private func placeholderCard(_ text: String, c: FSColors) -> some View {
        FSCard { Text(text).font(FS.font.bodySm()).foregroundColor(c.textMuted) }
    }

    private func row(_ label: String, _ value: String, c: FSColors) -> some View {
        HStack {
            Text(label).foregroundColor(c.textMuted)
            Spacer()
            Text(value).foregroundColor(c.text)
        }
    }

    private func shardPillLabel(_ s: PeerBackupShardSummary) -> String {
        if s.replicas >= s.minReplicas * 2 { return "redundant" }
        if s.replicas >= s.minReplicas { return "durable" }
        if s.replicas > 0 { return "at risk" }
        return "lost"
    }

    private func shardPillKind(_ s: PeerBackupShardSummary) -> FSPillKind {
        if s.replicas >= s.minReplicas { return .online }
        if s.replicas > 0 { return .renewing }
        return .offline
    }

    private func fmtDate(_ ms: Int64) -> String {
        if ms <= 0 { return "—" }
        let date = Date(timeIntervalSince1970: TimeInterval(ms) / 1000)
        let fmt = DateFormatter()
        fmt.dateStyle = .short
        fmt.timeStyle = .short
        return fmt.string(from: date)
    }

    private func fmtBytes(_ n: Int64) -> String {
        if n <= 0 { return "0 B" }
        let d = Double(n)
        if d < 1024 { return "\(n) B" }
        if d < 1024 * 1024 { return String(format: "%.1f KiB", d / 1024) }
        if d < 1024 * 1024 * 1024 { return String(format: "%.1f MiB", d / 1024 / 1024) }
        return String(format: "%.2f GiB", d / 1024 / 1024 / 1024)
    }
}
