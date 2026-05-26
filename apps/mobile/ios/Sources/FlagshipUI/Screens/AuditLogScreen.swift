import SwiftUI
import FlagshipAPI
import FlagshipCore

/// P5 — dedicated, full-page audit-log viewer. Mirrors the canonical
/// webapp `views/audit-log.js`: a paginated list of every account-level
/// audit event from flagshipserver.com, newest-first, with the kind →
/// label → icon mapping from docs/revocation-ui.md.
public struct AuditLogScreen: View {
    @Environment(\.colorScheme) private var scheme
    @State private var vm: AuditLogViewModel

    public init(vm: AuditLogViewModel) {
        _vm = State(initialValue: vm)
    }

    public var body: some View {
        let c = FSColors.scheme(scheme)
        ScrollView {
            VStack(alignment: .leading, spacing: FS.space.s4) {
                switch vm.status {
                case .idle, .loading:
                    ForEach(0..<4, id: \.self) { _ in ServerCardSkeleton() }
                case .failed(let msg):
                    ErrorCard(message: msg)
                case .loaded:
                    if vm.events.isEmpty {
                        emptyState(c: c)
                    } else {
                        FSCard {
                            VStack(spacing: FS.space.s3) {
                                ForEach(vm.events.indices, id: \.self) { i in
                                    eventRow(vm.events[i], c: c)
                                    if i < vm.events.count - 1 {
                                        Divider().background(c.border)
                                    }
                                }
                            }
                        }
                        if vm.canLoadMore {
                            FSSecondaryButton(
                                vm.loadingMore ? "Loading…" : "Load more",
                                block: true
                            ) {
                                Task { await vm.loadMore() }
                            }
                            .disabled(vm.loadingMore)
                            .accessibilityIdentifier("audit-log-load-more")
                        }
                    }
                }
                Spacer().frame(height: FS.space.s12)
            }
            .padding(.horizontal, FS.space.s6)
            .padding(.top, FS.space.s4)
        }
        .background(c.bg.ignoresSafeArea())
        .navigationTitle("Audit log")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await vm.load() }
        .task {
            if case .idle = vm.status { await vm.load() }
        }
    }

    private func emptyState(c: FSColors) -> some View {
        FSCard {
            VStack(alignment: .leading, spacing: FS.space.s2) {
                Text("No account events yet.")
                    .font(FS.font.body()).foregroundColor(c.text)
                Text("Signed actions — disconnecting a device, rotating recovery, renaming an app URL — land here so you have one place to review your account history.")
                    .font(FS.font.bodySm()).foregroundColor(c.textMuted)
            }
        }
    }

    private func eventRow(_ e: AuditEvent, c: FSColors) -> some View {
        HStack(alignment: .top, spacing: FS.space.s3) {
            Image(systemName: AuditLogViewModel.icon(for: e.eventKind))
                .foregroundColor(color(for: e.eventKind, c: c))
                .frame(width: 22)
            VStack(alignment: .leading, spacing: 2) {
                Text(AuditLogViewModel.label(for: e.eventKind))
                    .foregroundColor(c.text)
                if !e.detail.isEmpty {
                    Text(e.detail).font(FS.font.bodySm()).foregroundColor(c.textMuted)
                }
            }
            Spacer()
            Text(relative(ms: e.postedAt))
                .font(FS.font.caption()).foregroundColor(c.textMuted)
        }
    }

    private func color(for kind: String, c: FSColors) -> Color {
        switch kind {
        case "wipe-restart", "device-disconnected": return c.danger
        case "device-replaced", "app-renamed":      return c.primary
        default:                                     return c.textMuted
        }
    }

    private func relative(ms: Int64) -> String {
        let date = Date(timeIntervalSince1970: TimeInterval(ms) / 1000)
        let fmt = RelativeDateTimeFormatter()
        fmt.unitsStyle = .abbreviated
        return fmt.localizedString(for: date, relativeTo: Date())
    }
}
