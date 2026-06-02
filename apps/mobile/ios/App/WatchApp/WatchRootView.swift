import SwiftUI
import FlagshipCore

/// watchOS landing surface. While an install is in flight the provision
/// ladder dominates the face; otherwise the security surface
/// (`WatchSecurityAlertsView`) is primary — it lists pending boot
/// approvals + recent account security events. Tapping an approval row
/// opens the per-row sheet whose "Approve" CTA fires a WCSession message
/// to the phone (which holds the keys).
struct WatchRootView: View {
    @EnvironmentObject private var session: WatchConnectivityClient

    /// True when something on the security surface needs the user's
    /// attention or is worth a glance (a pending approval or a recent
    /// event). Drives whether the security surface pre-empts an inactive
    /// timeline acknowledgement.
    private var hasSecuritySurface: Bool {
        !WatchProtocol.SecurityAlertsProjection.isEmpty(session.securityAlerts)
    }

    var body: some View {
        NavigationStack {
            Group {
                if let timeline = session.provisionTimeline, timeline.active {
                    // Active install dominates the watch face: the
                    // ladder is the most time-sensitive thing the user
                    // wants to see right now.
                    ProvisionTimelineWatchView(context: timeline)
                } else if hasSecuritySurface {
                    // Pending boot approvals + recent security events.
                    // Pre-empts an inactive (terminal) timeline because a
                    // box waiting on approval is more actionable than a
                    // finished install's acknowledgement.
                    WatchSecurityAlertsView()
                        .environmentObject(session)
                } else if let timeline = session.provisionTimeline {
                    // Inactive (terminal-state) timeline still shows as
                    // a glanceable acknowledgement until the phone
                    // explicitly clears it.
                    ProvisionTimelineWatchView(context: timeline)
                } else {
                    // Nothing in flight, nothing pending — show the
                    // security surface's "all quiet" state so the app
                    // still reads as the security companion it is.
                    WatchSecurityAlertsView()
                        .environmentObject(session)
                }
            }
            .navigationTitle("Flagship")
        }
    }
}

struct ApprovalRow: View {
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

struct ApprovalDetail: View {
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
