import SwiftUI
import FlagshipAPI
import FlagshipCore

/// Peer backup between accounts (docs/peer-backup.md), v2. Mirrors the
/// webapp's `views/peer-backup.js`: the state and the newest backup's pieces,
/// the servers holding them as "Server 1..n" (never named) with their last
/// proof, and what this server keeps for others. Peer backup is a policy,
/// chosen in the server's Backups section; this page only shows how it goes.
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
                    if vm.isOlderBox {
                        placeholderCard("This server runs an older peer backup. Update the server to see its new status here.", c: c)
                            .accessibilityIdentifier("peer-backup-older")
                    } else {
                        stateCard(s, c: c)
                        holdersSection(c: c)
                        hostingSection(s, c: c)
                    }
                }
                Spacer().frame(height: FS.space.s12)
            }
            .padding(.horizontal, FS.space.s6)
            .padding(.top, FS.space.s4)
        }
        .background(c.bg.ignoresSafeArea())
        .navigationTitle("Peer backup")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await vm.load() }
        .task {
            if case .idle = vm.state { await vm.load() }
        }
    }

    private func pillKind(_ state: String?) -> FSPillKind {
        switch state {
        case "protected": return .online
        case "at-risk": return .offline
        case "waiting-for-peers", "filling", "placing", "leaving": return .renewing
        default: return .idle
        }
    }

    private func stateCard(_ s: PeerBackupStatusResponse, c: FSColors) -> some View {
        FSCard {
            VStack(alignment: .leading, spacing: FS.space.s2) {
                HStack(spacing: 8) {
                    Text(PeerBackupText.stateTitle(s.state))
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundColor(c.text)
                    FSPill(s.state ?? "", kind: pillKind(s.state))
                }
                Text(PeerBackupText.stateNote(s.state)).font(FS.font.caption()).foregroundColor(c.textMuted)
                if let r = s.reason, !r.isEmpty {
                    Text(r).font(FS.font.caption()).foregroundColor(c.textMuted)
                }
                if let total = s.totalBricks, total > 0 {
                    row("pieces safe", "\(s.healthyBricks ?? 0) of \(total)", c: c)
                }
                if let placed = s.lastPlacedAt, placed > 0 {
                    row("last placed", PeerBackupViewModel.formatTime(placed), c: c)
                }
                if !vm.restoreByLine.isEmpty {
                    Text(vm.restoreByLine).font(FS.font.caption()).foregroundColor(c.textMuted)
                }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("peer-backup-state-\(s.state ?? "")")
    }

    @ViewBuilder
    private func holdersSection(c: FSColors) -> some View {
        Text("Servers holding your pieces").font(FS.font.h3()).foregroundColor(c.text)
        if vm.holderRows.isEmpty {
            placeholderCard("None yet. Pieces are placed once your newest backup is ready and enough other servers can hold it.", c: c)
        } else {
            VStack(spacing: FS.space.s3) {
                ForEach(Array(vm.holderRows.enumerated()), id: \.offset) { i, h in
                    FSCard {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(h.label).font(.system(size: 15, weight: .semibold)).foregroundColor(c.text)
                            Text(h.line).font(FS.font.caption()).foregroundColor(c.textMuted)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .accessibilityElement(children: .contain)
                    .accessibilityIdentifier("peer-backup-holder-\(i)")
                }
            }
        }
    }

    @ViewBuilder
    private func hostingSection(_ s: PeerBackupStatusResponse, c: FSColors) -> some View {
        if !vm.hostingLines.isEmpty {
            Text("Kept for other servers").font(FS.font.h3()).foregroundColor(c.text)
            FSCard {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(vm.hostingLines, id: \.self) { Text($0).font(FS.font.bodySm()).foregroundColor(c.textMuted) }
                    if let r = s.hosting?.reliability {
                        Text("Reliability score: \(r == r.rounded() ? String(Int(r)) : String(r)) of 100")
                            .font(FS.font.caption()).foregroundColor(c.textMuted)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("peer-backup-hosting")
        }
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
}
