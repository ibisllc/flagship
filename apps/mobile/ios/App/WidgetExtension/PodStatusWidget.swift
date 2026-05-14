import WidgetKit
import SwiftUI

/// Home-screen widget surfacing each pod's online/offline status.
/// Small variant shows the leader; Medium variant lists up to 4 pods.
/// Tapping a pod row deep-links into the app via flagship://pod/<id>.
///
/// The widget reads from the App Group via PodStatusSnapshot — the
/// main app publishes whenever AppState.pods changes. No network
/// fetch from the widget itself.
struct PodStatusWidget: Widget {
    let kind = "PodStatusWidget"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: PodStatusProvider()) { entry in
            PodStatusWidgetView(entry: entry)
                .containerBackground(.fill.tertiary, for: .widget)
        }
        .configurationDisplayName("Pods")
        .description("Online/offline status for your Flagship servers.")
        .supportedFamilies([.systemSmall, .systemMedium])
    }
}

private struct PodStatusEntry: TimelineEntry {
    let date: Date
    let snapshot: PodStatusSnapshot
}

private struct PodStatusProvider: TimelineProvider {
    func placeholder(in context: Context) -> PodStatusEntry {
        let demo = PodStatusSnapshot(
            username: "harry",
            pods: [
                .init(podId: "home", name: "Home", fqdn: "home.harry.flagship.services", statusRaw: "online", isLeader: true),
                .init(podId: "office", name: "Office", fqdn: "office.harry.flagship.services", statusRaw: "online", isLeader: false),
            ]
        )
        return PodStatusEntry(date: .now, snapshot: demo)
    }

    func getSnapshot(in context: Context, completion: @escaping (PodStatusEntry) -> Void) {
        completion(.init(date: .now, snapshot: PodStatusSnapshot.read()))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<PodStatusEntry>) -> Void) {
        // The widget's content is driven by the app writing to the
        // App Group, NOT by a poll. We re-render every 30 min so
        // the "updated X ago" footer stays honest even if the app
        // hasn't run, and so widgetkit doesn't keep us on screen
        // with stale text indefinitely. App-side calls
        // WidgetCenter.shared.reloadAllTimelines() on snapshot
        // changes to force an immediate refresh.
        let now = Date()
        let entry = PodStatusEntry(date: now, snapshot: PodStatusSnapshot.read())
        let timeline = Timeline(entries: [entry], policy: .after(now.addingTimeInterval(30 * 60)))
        completion(timeline)
    }
}

// MARK: - View

private struct PodStatusWidgetView: View {
    @Environment(\.widgetFamily) private var family
    let entry: PodStatusEntry

    var body: some View {
        switch family {
        case .systemSmall:
            smallView
        default:
            mediumView
        }
    }

    @ViewBuilder
    private var smallView: some View {
        if let leader = entry.snapshot.pods.first(where: \.isLeader) ?? entry.snapshot.pods.first {
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 6) {
                    StatusDot(statusRaw: leader.statusRaw)
                    Text(leader.name).font(.headline)
                }
                Text(leader.fqdn)
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                Spacer()
                Text(statusLabel(leader.statusRaw))
                    .font(.caption2.smallCaps())
                    .foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .widgetURL(URL(string: "flagship://server?podId=\(leader.podId)"))
        } else {
            emptyState
        }
    }

    @ViewBuilder
    private var mediumView: some View {
        if entry.snapshot.pods.isEmpty {
            emptyState
        } else {
            VStack(alignment: .leading, spacing: 6) {
                ForEach(entry.snapshot.pods.prefix(4)) { pod in
                    Link(destination: URL(string: "flagship://server?podId=\(pod.podId)")!) {
                        HStack(spacing: 8) {
                            StatusDot(statusRaw: pod.statusRaw)
                            Text(pod.name).font(.subheadline.weight(.medium))
                            if pod.isLeader {
                                Text("LEADER")
                                    .font(.system(size: 9, weight: .bold))
                                    .padding(.horizontal, 4)
                                    .padding(.vertical, 1)
                                    .background(Color.accentColor.opacity(0.15))
                                    .clipShape(Capsule())
                            }
                            Spacer()
                            Text(statusLabel(pod.statusRaw))
                                .font(.caption2.smallCaps())
                                .foregroundStyle(.secondary)
                        }
                    }
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
    }

    @ViewBuilder
    private var emptyState: some View {
        VStack(alignment: .leading, spacing: 4) {
            Image(systemName: "server.rack").foregroundStyle(.secondary)
            Text("No pods yet").font(.headline)
            Text("Pair a server to see status here.")
                .font(.caption).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private func statusLabel(_ raw: String) -> String {
        switch raw {
        case "online":  return "Online"
        case "offline": return "Offline"
        case "pending": return "Pending"
        default:        return "Unknown"
        }
    }
}

private struct StatusDot: View {
    let statusRaw: String
    var body: some View {
        Circle()
            .fill(color(for: statusRaw))
            .frame(width: 8, height: 8)
    }
    private func color(for raw: String) -> Color {
        switch raw {
        case "online":  return .green
        case "offline": return .red
        case "pending": return .orange
        default:        return .gray
        }
    }
}
