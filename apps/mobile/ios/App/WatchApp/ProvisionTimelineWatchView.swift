import SwiftUI
import FlagshipCore

/// watchOS install-progress surface — W1. Mirrors the iPhone's
/// `ProvisionTimelineView` ladder (booting → downloading → partitioning
/// → installing → registering → sealing → pairing → live) at a glance.
///
/// Compact rail-with-nodes layout sized for the smallest watch face:
/// each row is one of `.done` (filled check), `.current` (small
/// spinner), `.upcoming` (hollow circle), `.error` (warning triangle).
/// On a terminal `.live`, every row collapses to `.done`. On `.error`,
/// the failure detail surfaces on the row where the install broke.
struct ProvisionTimelineWatchView: View {
    let context: WatchProtocol.ProvisionTimelineContext

    var body: some View {
        let rows = WatchProtocol.ProvisionTimelineLadder.rows(for: context)
        ScrollView {
            VStack(alignment: .leading, spacing: 4) {
                Text(context.podName)
                    .font(.headline)
                    .lineLimit(1)
                if let fqdn = context.serverDomain, !fqdn.isEmpty {
                    Text(fqdn)
                        .font(.caption2.monospaced())
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                Divider().padding(.vertical, 2)
                ForEach(Array(rows.enumerated()), id: \.element.phase) { idx, row in
                    timelineRow(
                        row: row,
                        isFirst: idx == 0,
                        isLast: idx == rows.count - 1
                    )
                }
                if !context.active {
                    Text(context.phase == "live"
                         ? "Install complete"
                         : (context.phase == "error" ? "Install failed" : "Done"))
                        .font(.caption2)
                        .foregroundStyle(context.phase == "error" ? .red : .secondary)
                        .padding(.top, 4)
                }
            }
            .padding(.horizontal, 4)
        }
        .navigationTitle("Provisioning")
        .navigationBarTitleDisplayMode(.inline)
    }

    @ViewBuilder
    private func timelineRow(
        row: WatchProtocol.TimelineRow,
        isFirst: Bool,
        isLast: Bool
    ) -> some View {
        HStack(alignment: .top, spacing: 6) {
            VStack(spacing: 0) {
                Rectangle()
                    .fill(isFirst ? Color.clear : railColor(above: row))
                    .frame(width: 2, height: 6)
                node(row.state)
                Rectangle()
                    .fill(isLast ? Color.clear : railColor(below: row))
                    .frame(width: 2)
                    .frame(maxHeight: .infinity)
            }
            .frame(width: 14)

            VStack(alignment: .leading, spacing: 1) {
                Text(row.title)
                    .font(row.state == .current ? .caption.bold() : .caption)
                    .foregroundStyle(labelColor(row.state))
                    .lineLimit(2)
                if let detail = row.detail {
                    Text(row.state == .error ? "Failed — \(detail)" : detail)
                        .font(.caption2)
                        .foregroundStyle(row.state == .error ? .red : .secondary)
                        .lineLimit(2)
                }
            }
            .padding(.bottom, isLast ? 0 : 4)
            Spacer(minLength: 0)
        }
        .accessibilityIdentifier("watch-provision-step-\(row.phase)")
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder
    private func node(_ state: WatchProtocol.TimelineRowState) -> some View {
        switch state {
        case .done:
            Image(systemName: "checkmark.circle.fill")
                .font(.system(size: 14))
                .foregroundStyle(.green)
        case .current:
            ProgressView()
                .scaleEffect(0.5)
                .frame(width: 14, height: 14)
        case .error:
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 14))
                .foregroundStyle(.red)
        case .upcoming:
            Image(systemName: "circle")
                .font(.system(size: 14))
                .foregroundStyle(.secondary)
        }
    }

    private func labelColor(_ state: WatchProtocol.TimelineRowState) -> Color {
        switch state {
        case .done, .current: return .primary
        case .error:          return .red
        case .upcoming:       return .secondary
        }
    }

    private func railColor(above row: WatchProtocol.TimelineRow) -> Color {
        (row.state == .done || row.state == .current || row.state == .error)
            ? Color.green.opacity(0.45) : Color.gray.opacity(0.35)
    }

    private func railColor(below row: WatchProtocol.TimelineRow) -> Color {
        row.state == .done ? Color.green.opacity(0.45) : Color.gray.opacity(0.35)
    }
}
