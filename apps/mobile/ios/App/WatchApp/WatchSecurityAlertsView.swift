import SwiftUI
import FlagshipCore

/// watchOS security surface — parity with the phone's boot-approval +
/// audit-log glance. Two sections:
///
///   1. **Pending approvals** — boxes waiting for the phone to release a
///      boot secret. Tapping a row opens the approve sheet whose CTA
///      fires a WCSession message to the phone (which holds the keys);
///      the watch only renders + initiates.
///   2. **Recent activity** — read-only account security events
///      (device replaced/disconnected, wipe-restart, recovery changes)
///      so a wrist glance answers "did something change on my account."
///
/// Pure projection (sort/trim/label/icon) lives in
/// `WatchProtocol.SecurityAlertsProjection` (FlagshipCore, unit-tested);
/// this view is a thin renderer over it.
struct WatchSecurityAlertsView: View {
    @EnvironmentObject private var session: WatchConnectivityClient

    private var approvals: [WatchProtocol.PendingApproval] {
        WatchProtocol.SecurityAlertsProjection.approvals(in: session.securityAlerts)
    }

    private var events: [WatchProtocol.SecurityAlert] {
        WatchProtocol.SecurityAlertsProjection.events(in: session.securityAlerts)
    }

    var body: some View {
        List {
            if !approvals.isEmpty {
                Section("Pending approvals") {
                    ForEach(approvals) { approval in
                        NavigationLink(value: approval.requestId) {
                            ApprovalRow(approval: approval)
                        }
                    }
                }
            }
            if !events.isEmpty {
                Section("Recent activity") {
                    ForEach(events) { event in
                        SecurityAlertRow(event: event)
                    }
                }
            }
            if approvals.isEmpty && events.isEmpty {
                Section {
                    quietState
                }
            }
        }
        .navigationTitle("Security")
        .navigationDestination(for: String.self) { requestId in
            if let approval = approvals.first(where: { $0.requestId == requestId }) {
                ApprovalDetail(approval: approval)
                    .environmentObject(session)
            }
        }
    }

    @ViewBuilder
    private var quietState: some View {
        VStack(spacing: 6) {
            Image(systemName: "checkmark.shield")
                .imageScale(.large)
                .foregroundStyle(.green)
            Text("All quiet").font(.headline)
            Text("Boot approvals and account changes show up here.")
                .font(.caption2)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 8)
    }
}

/// One read-only security-event row. Icon + label come from the same
/// mapping the phone uses (`SecurityAlertsProjection`), so the watch
/// reads identically to the iPhone activity feed.
private struct SecurityAlertRow: View {
    let event: WatchProtocol.SecurityAlert

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: WatchProtocol.SecurityAlertsProjection.icon(for: event.kind))
                .font(.system(size: 15))
                .foregroundStyle(.secondary)
                .frame(width: 18)
            VStack(alignment: .leading, spacing: 1) {
                Text(WatchProtocol.SecurityAlertsProjection.label(for: event.kind))
                    .font(.caption)
                    .lineLimit(1)
                if !event.devicePrefix.isEmpty {
                    Text(event.devicePrefix)
                        .font(.caption2.monospaced())
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                Text(relativeTime(event.postedAt))
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
        }
        .accessibilityIdentifier("watch-security-event-\(event.seq)")
        .accessibilityElement(children: .combine)
    }

    private func relativeTime(_ ms: Int64) -> String {
        let date = Date(timeIntervalSince1970: TimeInterval(ms) / 1000)
        let fmt = RelativeDateTimeFormatter()
        fmt.unitsStyle = .abbreviated
        return fmt.localizedString(for: date, relativeTo: Date())
    }
}
