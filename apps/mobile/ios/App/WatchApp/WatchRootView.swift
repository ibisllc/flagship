import SwiftUI
import FlagshipCore

/// watchOS landing surface. Lists pending unlock approvals; tapping a
/// row opens the per-row sheet with an "Approve" CTA that fires a
/// WCSession message to the phone.
struct WatchRootView: View {
    @EnvironmentObject private var session: WatchConnectivityClient

    var body: some View {
        NavigationStack {
            Group {
                if let timeline = session.provisionTimeline, timeline.active {
                    // Active install dominates the watch face: the
                    // ladder is the most time-sensitive thing the user
                    // wants to see right now. Approvals show as a
                    // secondary entry if any are pending.
                    ProvisionTimelineWatchView(context: timeline)
                } else if !session.pending.approvals.isEmpty {
                    List(session.pending.approvals) { approval in
                        NavigationLink(value: approval.requestId) {
                            ApprovalRow(approval: approval)
                        }
                    }
                } else if let timeline = session.provisionTimeline {
                    // Inactive (terminal-state) timeline still shows as
                    // a glanceable acknowledgement until the phone
                    // explicitly clears it.
                    ProvisionTimelineWatchView(context: timeline)
                } else {
                    emptyState
                }
            }
            .navigationTitle("Flagship")
            .navigationDestination(for: String.self) { requestId in
                if let approval = session.pending.approvals.first(where: { $0.requestId == requestId }) {
                    ApprovalDetail(approval: approval)
                        .environmentObject(session)
                }
            }
        }
    }

    @ViewBuilder
    private var emptyState: some View {
        VStack(spacing: 8) {
            Image(systemName: "lock.shield")
                .imageScale(.large)
                .foregroundStyle(.secondary)
            Text("No pending approvals").font(.headline)
            Text("Approvals from your servers will show up here.")
                .font(.caption)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .padding()
    }
}

private struct ApprovalRow: View {
    let approval: WatchProtocol.PendingApproval

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(approval.serverFqdn)
                .font(.caption.monospaced())
                .lineLimit(1)
            Text(relativeTime(approval.requestedAt))
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
    }

    private func relativeTime(_ ms: Int64) -> String {
        let date = Date(timeIntervalSince1970: TimeInterval(ms) / 1000)
        let fmt = RelativeDateTimeFormatter()
        fmt.unitsStyle = .abbreviated
        return fmt.localizedString(for: date, relativeTo: Date())
    }
}

private struct ApprovalDetail: View {
    let approval: WatchProtocol.PendingApproval
    @EnvironmentObject private var session: WatchConnectivityClient
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 10) {
                Text(approval.serverFqdn)
                    .font(.headline.monospaced())
                if let ip = approval.ip {
                    Text("from \(ip)")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Button {
                    Task { await approve() }
                } label: {
                    if session.inFlightRequestId == approval.requestId {
                        ProgressView()
                    } else if session.lastApprovedId == approval.requestId {
                        Label("Approved", systemImage: "checkmark")
                    } else {
                        Label("Approve", systemImage: "lock.open.fill")
                    }
                }
                .buttonStyle(.borderedProminent)
                .disabled(session.inFlightRequestId != nil || session.lastApprovedId == approval.requestId)

                if let err = session.lastError {
                    Label(err, systemImage: "exclamationmark.triangle.fill")
                        .font(.caption)
                        .foregroundStyle(.red)
                }
            }
            .padding()
        }
        .navigationTitle("Approve")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func approve() async {
        await session.approve(approval)
        if session.lastApprovedId == approval.requestId {
            try? await Task.sleep(nanoseconds: 1_200_000_000)
            dismiss()
        }
    }
}
