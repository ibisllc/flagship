import SwiftUI
import Charts
import FlagshipAPI

/// Monitoring panel rendered inside ServerDetailScreen.
///
/// Four cards: CPU / Memory / Disk / I/O+Net. Each card defaults to
/// "summary" mode (icon + headline value + ellipsis affordance) on
/// compact (iPhone) widths. Tapping expands the card in-place to
/// reveal the chart. On regular (iPad) widths, cards open expanded
/// so the dashboard reads at a glance.
public struct MetricsSection: View {
    @Environment(\.colorScheme) private var scheme
    @Environment(\.horizontalSizeClass) private var sizeClass
    let state: LoadingState<ServerMetricsResponse>

    public init(state: LoadingState<ServerMetricsResponse>) {
        self.state = state
    }

    public var body: some View {
        let c = FSColors.scheme(scheme)
        VStack(alignment: .leading, spacing: FS.space.s3) {
            Text("MONITORING")
                .font(.system(size: 12, weight: .semibold))
                .tracking(1)
                .foregroundColor(c.textMuted)
            switch state {
            case .idle, .loading:
                MetricsSkeleton()
            case .failed(let msg):
                ErrorCard(message: msg)
            case .loaded(let m):
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 280), spacing: FS.space.s3)], spacing: FS.space.s3) {
                    CPUCard(metrics: m, startsExpanded: sizeClass == .regular)
                    MemoryCard(metrics: m, startsExpanded: sizeClass == .regular)
                    DiskCard(metrics: m, startsExpanded: sizeClass == .regular)
                    IONetCard(metrics: m, startsExpanded: sizeClass == .regular)
                }
            }
        }
    }
}

// MARK: - Generic expandable card

private struct ExpandableMetricCard<Summary: View, Detail: View>: View {
    @Environment(\.colorScheme) private var scheme
    let title: String
    let icon: String
    let startsExpanded: Bool
    @ViewBuilder let summary: () -> Summary
    @ViewBuilder let detail: () -> Detail

    @State private var expanded: Bool

    init(
        title: String,
        icon: String,
        startsExpanded: Bool,
        @ViewBuilder summary: @escaping () -> Summary,
        @ViewBuilder detail: @escaping () -> Detail
    ) {
        self.title = title
        self.icon = icon
        self.startsExpanded = startsExpanded
        self.summary = summary
        self.detail = detail
        self._expanded = State(initialValue: startsExpanded)
    }

    var body: some View {
        let c = FSColors.scheme(scheme)
        Button {
            withAnimation(.easeInOut(duration: 0.22)) { expanded.toggle() }
        } label: {
            FSCard {
                VStack(alignment: .leading, spacing: FS.space.s2) {
                    HStack(spacing: 6) {
                        Image(systemName: icon).foregroundColor(c.textMuted)
                        Text(title)
                            .font(.system(size: 13, weight: .semibold))
                            .foregroundColor(c.textMuted)
                            .textCase(.uppercase)
                            .tracking(0.5)
                        Spacer()
                        Image(systemName: expanded ? "chevron.up" : "ellipsis")
                            .foregroundColor(c.textMuted)
                            .font(.system(size: 13, weight: .semibold))
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .background(c.surfaceSunken)
                            .clipShape(Capsule())
                            .accessibilityLabel(expanded ? "Collapse" : "Expand")
                    }
                    summary()
                    if expanded {
                        detail()
                            .transition(.asymmetric(
                                insertion: .move(edge: .top).combined(with: .opacity),
                                removal: .opacity
                            ))
                    }
                }
            }
        }
        .buttonStyle(.plain)
    }
}

// MARK: - CPU

private struct CPUCard: View {
    @Environment(\.colorScheme) private var scheme
    let metrics: ServerMetricsResponse
    let startsExpanded: Bool

    var body: some View {
        let c = FSColors.scheme(scheme)
        ExpandableMetricCard(title: "CPU", icon: "cpu", startsExpanded: startsExpanded, summary: {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(String(format: "%.0f", metrics.cpuPercent))
                    .font(.system(size: 28, weight: .semibold))
                    .foregroundColor(c.text)
                Text("%").font(FS.font.body()).foregroundColor(c.textMuted)
                Spacer()
                Text(String(format: "load %.2f", metrics.loadAvg1))
                    .font(FS.font.caption()).foregroundColor(c.textMuted)
            }
        }, detail: {
            Chart(metrics.cpuHistory) { sample in
                LineMark(
                    x: .value("Time", Date(timeIntervalSince1970: TimeInterval(sample.at) / 1000)),
                    y: .value("CPU", sample.value)
                )
                .interpolationMethod(.catmullRom)
                .foregroundStyle(c.primary)
                AreaMark(
                    x: .value("Time", Date(timeIntervalSince1970: TimeInterval(sample.at) / 1000)),
                    y: .value("CPU", sample.value)
                )
                .interpolationMethod(.catmullRom)
                .foregroundStyle(LinearGradient(colors: [c.primary.opacity(0.25), c.primary.opacity(0)], startPoint: .top, endPoint: .bottom))
            }
            .chartYScale(domain: 0...100)
            .chartYAxis { AxisMarks(values: [0, 50, 100]) { _ in AxisGridLine().foregroundStyle(c.border) } }
            .chartXAxis(.hidden)
            .frame(height: 96)
            Text(String(format: "load %.2f · %.2f · %.2f", metrics.loadAvg1, metrics.loadAvg5, metrics.loadAvg15))
                .font(FS.font.caption()).foregroundColor(c.textMuted)
        })
    }
}

// MARK: - Memory

private struct MemoryCard: View {
    @Environment(\.colorScheme) private var scheme
    let metrics: ServerMetricsResponse
    let startsExpanded: Bool

    var body: some View {
        let c = FSColors.scheme(scheme)
        let pct = Double(metrics.memUsedBytes) / Double(metrics.memTotalBytes) * 100
        ExpandableMetricCard(title: "Memory", icon: "memorychip", startsExpanded: startsExpanded, summary: {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(formatBytes(metrics.memUsedBytes))
                    .font(.system(size: 22, weight: .semibold))
                    .foregroundColor(c.text)
                Text("/ \(formatBytes(metrics.memTotalBytes))")
                    .font(FS.font.body()).foregroundColor(c.textMuted)
                Spacer()
                Text(String(format: "%.0f%%", pct))
                    .font(FS.font.body()).foregroundColor(c.textMuted)
            }
        }, detail: {
            Chart(metrics.memHistory) { sample in
                AreaMark(
                    x: .value("Time", Date(timeIntervalSince1970: TimeInterval(sample.at) / 1000)),
                    y: .value("Mem", sample.value / Double(metrics.memTotalBytes) * 100)
                )
                .interpolationMethod(.catmullRom)
                .foregroundStyle(LinearGradient(colors: [c.success.opacity(0.45), c.success.opacity(0.05)], startPoint: .top, endPoint: .bottom))
                LineMark(
                    x: .value("Time", Date(timeIntervalSince1970: TimeInterval(sample.at) / 1000)),
                    y: .value("Mem", sample.value / Double(metrics.memTotalBytes) * 100)
                )
                .foregroundStyle(c.success)
            }
            .chartYScale(domain: 0...100)
            .chartYAxis(.hidden)
            .chartXAxis(.hidden)
            .frame(height: 96)
        })
    }
}

// MARK: - Disk

private struct DiskCard: View {
    @Environment(\.colorScheme) private var scheme
    let metrics: ServerMetricsResponse
    let startsExpanded: Bool

    var body: some View {
        let c = FSColors.scheme(scheme)
        let used = Double(metrics.diskUsedBytes)
        let total = Double(metrics.diskTotalBytes)
        let pct = used / total
        ExpandableMetricCard(title: "Disk", icon: "internaldrive", startsExpanded: startsExpanded, summary: {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(String(format: "%.0f%%", pct * 100))
                    .font(.system(size: 22, weight: .semibold))
                    .foregroundColor(c.text)
                Text("used").font(FS.font.body()).foregroundColor(c.textMuted)
                Spacer()
                Text(formatBytes(metrics.diskTotalBytes - metrics.diskUsedBytes))
                    .font(FS.font.caption()).foregroundColor(c.textMuted)
                Text("free").font(FS.font.caption()).foregroundColor(c.textMuted)
            }
        }, detail: {
            HStack(spacing: FS.space.s4) {
                ZStack {
                    Circle()
                        .stroke(c.surfaceSunken, lineWidth: 10)
                        .frame(width: 86, height: 86)
                    Circle()
                        .trim(from: 0, to: pct)
                        .stroke(diskColor(pct, c: c), style: StrokeStyle(lineWidth: 10, lineCap: .round))
                        .rotationEffect(.degrees(-90))
                        .frame(width: 86, height: 86)
                    Text(String(format: "%.0f%%", pct * 100))
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundColor(c.text)
                }
                VStack(alignment: .leading, spacing: 4) {
                    labeled("Used", formatBytes(metrics.diskUsedBytes), c: c)
                    labeled("Free", formatBytes(metrics.diskTotalBytes - metrics.diskUsedBytes), c: c)
                    labeled("Total", formatBytes(metrics.diskTotalBytes), c: c)
                }
                Spacer(minLength: 0)
            }
        })
    }

    private func diskColor(_ pct: Double, c: FSColors) -> Color {
        if pct > 0.9 { return c.danger }
        if pct > 0.75 { return c.warning }
        return c.primary
    }

    private func labeled(_ label: String, _ value: String, c: FSColors) -> some View {
        HStack(spacing: 8) {
            Text(label).font(FS.font.caption()).foregroundColor(c.textMuted)
            Text(value).font(FS.font.body()).foregroundColor(c.text)
        }
    }
}

// MARK: - I/O + Network

private struct IONetCard: View {
    @Environment(\.colorScheme) private var scheme
    let metrics: ServerMetricsResponse
    let startsExpanded: Bool

    var body: some View {
        let c = FSColors.scheme(scheme)
        ExpandableMetricCard(title: "I/O & network", icon: "arrow.up.arrow.down", startsExpanded: startsExpanded, summary: {
            HStack(spacing: FS.space.s3) {
                pair("↓", formatRate(metrics.netRxBytesPerSec), c.success, c: c)
                pair("↑", formatRate(metrics.netTxBytesPerSec), c.danger, c: c)
            }
        }, detail: {
            VStack(alignment: .leading, spacing: FS.space.s2) {
                HStack(spacing: FS.space.s4) {
                    rate("Disk read",  metrics.diskIOReadBytesPerSec,  color: c.primary, c: c)
                    rate("Disk write", metrics.diskIOWriteBytesPerSec, color: c.warning, c: c)
                }
                HStack(spacing: FS.space.s4) {
                    rate("Net in",  metrics.netRxBytesPerSec, color: c.success, c: c)
                    rate("Net out", metrics.netTxBytesPerSec, color: c.danger,  c: c)
                }
                Chart {
                    ForEach(metrics.netHistory) { sample in
                        LineMark(
                            x: .value("Time", Date(timeIntervalSince1970: TimeInterval(sample.at) / 1000)),
                            y: .value("Rate", sample.read),
                            series: .value("Series", "in")
                        )
                        .foregroundStyle(c.success)
                        LineMark(
                            x: .value("Time", Date(timeIntervalSince1970: TimeInterval(sample.at) / 1000)),
                            y: .value("Rate", sample.write),
                            series: .value("Series", "out")
                        )
                        .foregroundStyle(c.danger)
                    }
                }
                .chartYAxis(.hidden)
                .chartXAxis(.hidden)
                .frame(height: 72)
            }
        })
    }

    private func pair(_ arrow: String, _ value: String, _ color: Color, c: FSColors) -> some View {
        HStack(spacing: 3) {
            Text(arrow).font(.system(size: 15, weight: .semibold)).foregroundColor(color)
            Text(value).font(.system(size: 15, weight: .semibold)).foregroundColor(c.text)
        }
    }

    private func rate(_ label: String, _ bps: Double, color: Color, c: FSColors) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 4) {
                Circle().fill(color).frame(width: 6, height: 6)
                Text(label).font(FS.font.caption()).foregroundColor(c.textMuted)
            }
            Text(formatRate(bps)).font(.system(size: 15, weight: .semibold)).foregroundColor(c.text)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

struct MetricsSkeleton: View {
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        let c = FSColors.scheme(scheme)
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 280), spacing: FS.space.s3)], spacing: FS.space.s3) {
            ForEach(0..<4) { _ in
                FSCard {
                    VStack(alignment: .leading) {
                        RoundedRectangle(cornerRadius: 4).fill(c.surfaceSunken).frame(width: 60, height: 12)
                        RoundedRectangle(cornerRadius: 4).fill(c.surfaceSunken).frame(width: 100, height: 30)
                        RoundedRectangle(cornerRadius: 8).fill(c.surfaceSunken).frame(height: 48)
                    }
                }
                .redacted(reason: .placeholder)
            }
        }
    }
}

private func formatBytes(_ bytes: Int64) -> String {
    let kb = 1024.0
    let mb = kb * 1024
    let gb = mb * 1024
    let b = Double(bytes)
    if b >= gb { return String(format: "%.1f GB", b / gb) }
    if b >= mb { return String(format: "%.0f MB", b / mb) }
    if b >= kb { return String(format: "%.0f KB", b / kb) }
    return "\(bytes) B"
}

private func formatRate(_ bytesPerSec: Double) -> String {
    let kb = 1024.0
    let mb = kb * 1024
    if bytesPerSec >= mb { return String(format: "%.1f MB/s", bytesPerSec / mb) }
    if bytesPerSec >= kb { return String(format: "%.0f KB/s", bytesPerSec / kb) }
    return String(format: "%.0f B/s", bytesPerSec)
}
