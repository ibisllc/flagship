import SwiftUI
import FlagshipAPI
import FlagshipCore

/// Live provisioning-status timeline for a pending server. Renders the
/// ordered install phases (Booting → … → Server is live) as a connected
/// vertical timeline, each row in one of four states:
///
///   - done     — a phase the box has already passed (checkmark, muted).
///   - current  — the phase in flight (spinner + accent, carries detail).
///   - upcoming — a phase not yet reached (hollow dot, muted text).
///   - error    — the install failed at this step (warning + detail).
///
/// The row-state projection lives in `ProvisionTimelineLadder` so the
/// watchOS counterpart (`ProvisionTimelineWatchView`) can run the same
/// algorithm on the wire-type it receives over WatchConnectivity.
public struct ProvisionTimelineView: View {
    @Environment(\.colorScheme) private var scheme

    /// The latest status, or nil before the first checkpoint.
    let status: ProvisionStatus?

    public init(status: ProvisionStatus?) {
        self.status = status
    }

    public var body: some View {
        let c = FSColors.scheme(scheme)
        let rows = ProvisionTimelineLadder.rows(for: status)
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(rows.enumerated()), id: \.element.phase) { idx, row in
                timelineRow(
                    row: row,
                    isFirst: idx == 0,
                    isLast: idx == rows.count - 1,
                    c: c
                )
            }
        }
        .accessibilityIdentifier("provision-timeline")
    }

    // MARK: - Row view

    @ViewBuilder
    private func timelineRow(
        row: ProvisionTimelineLadder.Row,
        isFirst: Bool,
        isLast: Bool,
        c: FSColors
    ) -> some View {
        HStack(alignment: .top, spacing: FS.space.s3) {
            // Connector rail + node.
            VStack(spacing: 0) {
                Rectangle()
                    .fill(isFirst ? Color.clear : railColor(above: row, c))
                    .frame(width: 2, height: 10)
                node(row.state, c)
                Rectangle()
                    .fill(isLast ? Color.clear : railColor(below: row, c))
                    .frame(width: 2)
                    .frame(maxHeight: .infinity)
            }
            .frame(width: 20)

            // Label + detail.
            VStack(alignment: .leading, spacing: 2) {
                Text(row.phase.title)
                    .font(row.state == .current ? FS.font.h4() : FS.font.body())
                    .foregroundColor(labelColor(row.state, c))
                if let detail = row.detail {
                    Text(row.state == .error ? "Failed — \(detail)" : detail)
                        .font(FS.font.bodySm())
                        .foregroundColor(row.state == .error ? c.danger : c.textMuted)
                }
            }
            .padding(.bottom, isLast ? 0 : FS.space.s3)
            Spacer(minLength: 0)
        }
        .accessibilityIdentifier("provision-step-\(row.phase.rawValue)")
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder
    private func node(_ state: ProvisionTimelineLadder.RowState, _ c: FSColors) -> some View {
        switch state {
        case .done:
            Image(systemName: "checkmark.circle.fill")
                .font(.system(size: 18))
                .foregroundColor(c.success)
        case .current:
            ProgressView()
                .scaleEffect(0.7)
                .tint(c.primary)
                .frame(width: 18, height: 18)
        case .error:
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 18))
                .foregroundColor(c.danger)
        case .upcoming:
            Image(systemName: "circle")
                .font(.system(size: 18))
                .foregroundColor(c.border)
        }
    }

    private func labelColor(_ state: ProvisionTimelineLadder.RowState, _ c: FSColors) -> Color {
        switch state {
        case .done:     return c.text
        case .current:  return c.text
        case .error:    return c.danger
        case .upcoming: return c.textMuted
        }
    }

    /// The rail segment above a row is "passed" (accent/success) if the
    /// row itself is done or current; the segment below uses the same
    /// rule. Keeps the rail filled up to the active node.
    private func railColor(above row: ProvisionTimelineLadder.Row, _ c: FSColors) -> Color {
        (row.state == .done || row.state == .current || row.state == .error)
            ? c.success.opacity(0.4) : c.border
    }
    private func railColor(below row: ProvisionTimelineLadder.Row, _ c: FSColors) -> Color {
        row.state == .done ? c.success.opacity(0.4) : c.border
    }
}
