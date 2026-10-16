import SwiftUI
import WidgetKit
import FlagshipCore

/// watchOS complication / Smart-Stack widget that surfaces the install
/// phase of an in-flight server provision at a glance, without the user
/// opening the Flagship watch app.
///
/// Data source: a JSON-encoded `WatchProtocol.ProvisionTimelineContext`
/// the Flagship watch app writes to App-Group-shared UserDefaults
/// (`group.com.flagshipserver.app`) on every WCSession applicationContext
/// update. The watch app calls `WidgetCenter.shared.reloadAllTimelines`
/// after the write so the widget timeline refreshes within a heartbeat
/// of a phase transition.
///
/// Supported families:
///   - `.accessoryInline` — one-line "Flagship: sealing" / "Flagship: live"
///     entry on the watch face inline slot.
///   - `.accessoryCircular` — circular icon + 2-char abbreviation for
///     corner / circular slots.
///   - `.accessoryRectangular` — two-line title + phase title for
///     larger faces (Modular Ultra, etc.).
struct ProvisionPhaseComplication: Widget {
    let kind = "ProvisionPhaseComplication"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: ProvisionPhaseProvider()) { entry in
            ProvisionPhaseComplicationView(entry: entry)
                .containerBackground(.fill.tertiary, for: .widget)
        }
        .configurationDisplayName("Flagship servers")
        .description("Shows a server's install while one is under way, else how your servers are doing.")
        .supportedFamilies([.accessoryInline, .accessoryCircular, .accessoryRectangular])
    }
}

/// A single timeline entry — what the widget renders at a given date.
struct ProvisionPhaseEntry: TimelineEntry {
    let date: Date
    /// nil when no install is active — the complication falls back to a
    /// "Flagship" placeholder so the user knows the slot belongs to us
    /// without claiming a phase that isn't running.
    let context: WatchProtocol.ProvisionTimelineContext?
    /// The account's servers, shown when no install is under way.
    var servers: WatchProtocol.ServersContext? = nil

    /// The install the face shows: an active one always, a finished one
    /// only while there's no server list to show instead.
    var shownInstall: WatchProtocol.ProvisionTimelineContext? {
        guard let context else { return nil }
        return context.active || summary == nil ? context : nil
    }

    /// The server summary, when there are servers and no install to show.
    var summary: WatchProtocol.ServersProjection.Summary? {
        let s = WatchProtocol.ServersProjection.summary(servers)
        return s.total > 0 ? s : nil
    }
}

struct ProvisionPhaseProvider: TimelineProvider {
    static let defaultsSuiteName = "group.com.flagshipserver.app"
    static let timelineDefaultsKey = "flagship.watch.provision-timeline-v1"
    static let serversDefaultsKey = "flagship.watch.servers-v1"

    func placeholder(in context: Context) -> ProvisionPhaseEntry {
        ProvisionPhaseEntry(date: Date(), context: nil)
    }

    func getSnapshot(in context: Context, completion: @escaping (ProvisionPhaseEntry) -> Void) {
        completion(ProvisionPhaseEntry(date: Date(), context: loadCurrent(), servers: loadServers()))
    }

    /// One-shot timeline. The widget reloads via
    /// `WidgetCenter.shared.reloadAllTimelines()` whenever the watch app
    /// writes a new context, so we don't need to schedule periodic
    /// refreshes here — the watch app drives the cadence.
    func getTimeline(in context: Context, completion: @escaping (Timeline<ProvisionPhaseEntry>) -> Void) {
        let entry = ProvisionPhaseEntry(date: Date(), context: loadCurrent(), servers: loadServers())
        completion(Timeline(entries: [entry], policy: .never))
    }

    private func loadCurrent() -> WatchProtocol.ProvisionTimelineContext? {
        guard let defaults = UserDefaults(suiteName: Self.defaultsSuiteName),
              let data = defaults.data(forKey: Self.timelineDefaultsKey) else {
            return nil
        }
        return try? JSONDecoder().decode(WatchProtocol.ProvisionTimelineContext.self, from: data)
    }

    private func loadServers() -> WatchProtocol.ServersContext? {
        guard let defaults = UserDefaults(suiteName: Self.defaultsSuiteName),
              let data = defaults.data(forKey: Self.serversDefaultsKey) else {
            return nil
        }
        return try? JSONDecoder().decode(WatchProtocol.ServersContext.self, from: data)
    }
}

struct ProvisionPhaseComplicationView: View {
    @Environment(\.widgetFamily) private var family
    let entry: ProvisionPhaseEntry

    var body: some View {
        switch family {
        case .accessoryInline:
            Text(inlineString)
        case .accessoryCircular:
            ZStack {
                Circle()
                    .stroke(circleColor, lineWidth: 2)
                VStack(spacing: 0) {
                    Image(systemName: iconName)
                        .font(.system(size: 12))
                        .foregroundStyle(circleColor)
                    Text(circularAbbrev)
                        .font(.system(size: 9, weight: .medium))
                        .lineLimit(1)
                        .minimumScaleFactor(0.6)
                }
            }
            .widgetAccentable()
        case .accessoryRectangular:
            VStack(alignment: .leading, spacing: 1) {
                Text("Flagship")
                    .font(.caption.bold())
                Text(rectangularTitle)
                    .font(.caption2)
                    .lineLimit(1)
                if let detail = rectangularDetail {
                    Text(detail)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
        default:
            // The configuration only declares the three families above,
            // so this branch is unreachable in production. Render a
            // neutral fallback so a future family addition doesn't crash.
            Text(inlineString)
        }
    }

    // MARK: - Display strings

    private var inlineString: String {
        if entry.shownInstall == nil, let s = entry.summary {
            return "Flagship: \(WatchProtocol.ServersProjection.line(s).lowercased())"
        }
        guard let ctx = entry.shownInstall else { return "Flagship" }
        let title = WatchProtocol.ProvisionTimelineLadder.phases
            .first(where: { $0.phase == ctx.phase })?.title
            ?? ctx.phase
        return "Flagship: \(title.lowercased())"
    }

    private var rectangularTitle: String {
        if entry.shownInstall == nil, let s = entry.summary { return WatchProtocol.ServersProjection.line(s) }
        guard let ctx = entry.shownInstall else { return "No install in flight" }
        if ctx.phase == "error" { return "Install failed" }
        if ctx.phase == "live"  { return "Server is live" }
        let title = WatchProtocol.ProvisionTimelineLadder.phases
            .first(where: { $0.phase == ctx.phase })?.title
            ?? ctx.phase.capitalized
        return title
    }

    private var rectangularDetail: String? {
        if entry.shownInstall == nil, let s = entry.summary {
            return s.total == 1 ? "1 server" : "\(s.total) servers"
        }
        guard let ctx = entry.shownInstall else { return nil }
        if let d = ctx.detail, !d.isEmpty { return d }
        if let fqdn = ctx.serverDomain, !fqdn.isEmpty { return fqdn }
        return nil
    }

    private var circularAbbrev: String {
        if entry.shownInstall == nil, let s = entry.summary {
            return s.waiting > 0 ? "\(s.waiting)!" : "\(s.online)/\(s.total)"
        }
        guard let ctx = entry.shownInstall else { return "FS" }
        // 3-letter abbreviation from the phase rawValue, uppercased.
        let raw = ctx.phase
        return String(raw.prefix(3)).uppercased()
    }

    private var iconName: String {
        if entry.shownInstall == nil, let s = entry.summary {
            return s.waiting > 0 ? "lock.fill" : "server.rack"
        }
        guard let ctx = entry.shownInstall else { return "circle" }
        switch ctx.phase {
        case "live":  return "checkmark.circle.fill"
        case "error": return "exclamationmark.triangle.fill"
        default:      return "arrow.triangle.2.circlepath"
        }
    }

    private var circleColor: Color {
        if entry.shownInstall == nil, let s = entry.summary {
            if s.waiting > 0 { return .orange }
            return s.online == s.total ? .green : .red
        }
        guard let ctx = entry.shownInstall else { return .secondary }
        switch ctx.phase {
        case "live":  return .green
        case "error": return .red
        default:      return .blue
        }
    }
}
