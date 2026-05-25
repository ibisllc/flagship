import SwiftUI
import FlagshipAPI

/// Live provisioning-status timeline for a pending server. Renders the
/// ordered install phases (Booting → … → Server is live) as a connected
/// vertical timeline, each row in one of four states:
///
///   - done     — a phase the box has already passed (checkmark, muted).
///   - current  — the phase in flight (spinner + accent, carries detail).
///   - upcoming — a phase not yet reached (hollow dot, muted text).
///   - error    — the install failed at this step (warning + detail).
///
/// Driven by `ProvisionStatus.phase` + its append-only `history`. Before
/// the first checkpoint arrives (`status == nil`) the first row is shown
/// as current with a "waiting for the box to phone home" hint, so a
/// freshly-ordered pod still renders the ladder instead of a bare card.
public struct ProvisionTimelineView: View {
    @Environment(\.colorScheme) private var scheme

    /// The latest status, or nil before the first checkpoint.
    let status: ProvisionStatus?

    public init(status: ProvisionStatus?) {
        self.status = status
    }

    enum RowState: Equatable { case done, current, upcoming, error }

    public var body: some View {
        let c = FSColors.scheme(scheme)
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

    // MARK: - Row model

    private struct Row: Equatable {
        let phase: ProvisionStatusPhase
        let state: RowState
        let detail: String?
    }

    /// The ordered ladder projected into per-row states. On a terminal
    /// `error`, the row owning the phase the box failed at (the last
    /// non-error phase in history, else the first row) renders as
    /// `.error` and carries the failure detail.
    private var rows: [Row] {
        let ladder = ProvisionStatusPhase.ordered
        let currentPhase = status?.phase

        // Failure: find where it broke from history (last non-error phase),
        // and surface the error detail on that row.
        if currentPhase == .error {
            let brokeAt = lastNonErrorPhase ?? ladder.first
            let brokeIdx = brokeAt.flatMap { ladder.firstIndex(of: $0) } ?? 0
            return ladder.enumerated().map { i, phase in
                if i < brokeIdx {
                    return Row(phase: phase, state: .done, detail: nil)
                }
                if i == brokeIdx {
                    return Row(phase: phase, state: .error, detail: errorDetail)
                }
                return Row(phase: phase, state: .upcoming, detail: nil)
            }
        }

        // No checkpoint yet → first row current with a waiting hint.
        guard let currentPhase, let curIdx = ladder.firstIndex(of: currentPhase) else {
            return ladder.enumerated().map { i, phase in
                Row(
                    phase: phase,
                    state: i == 0 ? .current : .upcoming,
                    detail: i == 0 ? "Waiting for the box to phone home…" : nil
                )
            }
        }

        return ladder.enumerated().map { i, phase in
            if i < curIdx { return Row(phase: phase, state: .done, detail: nil) }
            if i == curIdx {
                let isLive = phase == .live
                return Row(phase: phase, state: isLive ? .done : .current, detail: detailFor(phase))
            }
            return Row(phase: phase, state: .upcoming, detail: nil)
        }
    }

    private var lastNonErrorPhase: ProvisionStatusPhase? {
        status?.history.last(where: { $0.phase != .error })?.phase
    }

    private var errorDetail: String? {
        let d = status?.detail ?? status?.history.last(where: { $0.phase == .error })?.detail
        return (d?.isEmpty ?? true) ? nil : d
    }

    /// The current-phase detail: prefer the live `detail`, fall back to
    /// the matching history entry's detail.
    private func detailFor(_ phase: ProvisionStatusPhase) -> String? {
        if let d = status?.detail, !d.isEmpty { return d }
        let d = status?.history.last(where: { $0.phase == phase })?.detail
        return (d?.isEmpty ?? true) ? nil : d
    }

    // MARK: - Row view

    @ViewBuilder
    private func timelineRow(row: Row, isFirst: Bool, isLast: Bool, c: FSColors) -> some View {
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
    private func node(_ state: RowState, _ c: FSColors) -> some View {
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

    private func labelColor(_ state: RowState, _ c: FSColors) -> Color {
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
    private func railColor(above row: Row, _ c: FSColors) -> Color {
        (row.state == .done || row.state == .current || row.state == .error)
            ? c.success.opacity(0.4) : c.border
    }
    private func railColor(below row: Row, _ c: FSColors) -> Color {
        row.state == .done ? c.success.opacity(0.4) : c.border
    }
}
