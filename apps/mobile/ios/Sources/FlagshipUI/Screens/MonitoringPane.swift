import SwiftUI
import Charts
import FlagshipAPI
import FlagshipCore

/// The server's certificate as the page knows it: the box's own detail first,
/// the last verified daemon-status report as the fallback.
struct MonitoringCert: Equatable {
    var notAfter: Int64?
    var notBefore: Int64?
    var issuer: String?
    var sans: [String]
}

/// One row of the Monitoring pane: icon + name on the left, the short value on
/// the right. Android and the webapp use the same names and order.
struct MonitoringRow: Equatable, Identifiable {
    enum Key: String, CaseIterable {
        case health, cpu, memory, disk, network, certificate
    }
    enum Tone: Equatable { case normal, warning, danger }

    let key: Key
    let title: String
    let icon: String
    /// nil while the value is still loading.
    let value: String?
    let tone: Tone
    var id: String { key.rawValue }
}

enum MonitoringRows {
    /// Rows in display order. `metrics` nil leaves out the four metric rows
    /// (the box's detail never loaded); `cert` nil leaves out Certificate;
    /// `health` nil leaves out Health (the box doesn't report one yet).
    static func build(
        health: BoxHealth?,
        metrics: LoadingState<ServerMetricsResponse>?,
        cert: MonitoringCert?,
        nowMs: Int64
    ) -> [MonitoringRow] {
        var rows: [MonitoringRow] = []
        if let health {
            let v = health.verdict(nowMs: nowMs)
            let stale = (nowMs - health.receivedAt) / 60_000 >= 5
            rows.append(MonitoringRow(
                key: .health, title: String(localized: "Health"),
                icon: v.ok ? "heart.text.square" : "exclamationmark.triangle.fill",
                value: v.ok ? String(localized: "Healthy") : (stale ? String(localized: "No report") : String(localized: "Needs attention")),
                tone: v.ok ? .normal : .warning
            ))
        }
        if let metrics {
            let m = metrics.value
            let failed: Bool = { if case .failed = metrics { return true }; return false }()
            func value(_ f: (ServerMetricsResponse) -> String) -> String? {
                if let m { return f(m) }
                return failed ? String(localized: "Unavailable") : nil
            }
            rows.append(MonitoringRow(
                key: .cpu, title: "CPU", icon: "cpu",
                value: value { String(format: "%.0f%%", $0.cpuPercent) }, tone: .normal
            ))
            rows.append(MonitoringRow(
                key: .memory, title: String(localized: "Memory"), icon: "memorychip",
                value: value { String(localized: "\(formatBytes($0.memUsedBytes)) of \(formatBytes($0.memTotalBytes))") },
                tone: .normal
            ))
            let diskPct = m.map { percent($0.diskUsedBytes, of: $0.diskTotalBytes) } ?? 0
            rows.append(MonitoringRow(
                key: .disk, title: String(localized: "Disk"), icon: "internaldrive",
                value: value { _ in String(format: "%.0f%% used", diskPct * 100) },
                tone: diskPct > 0.9 ? .danger : (diskPct > 0.75 ? .warning : .normal)
            ))
            rows.append(MonitoringRow(
                key: .network, title: String(localized: "Network"), icon: "arrow.up.arrow.down",
                value: value { "↓ \(formatRate($0.netRxBytesPerSec))  ↑ \(formatRate($0.netTxBytesPerSec))" },
                tone: .normal
            ))
        }
        if let cert {
            let value: String
            var tone = MonitoringRow.Tone.normal
            if let after = cert.notAfter {
                if after <= nowMs {
                    value = String(localized: "Expired")
                    tone = .danger
                } else {
                    value = String(localized: "Valid until \(Date.flagshipFormatted(epochMs: after))")
                }
            } else {
                value = String(localized: "Provisioning")
            }
            rows.append(MonitoringRow(
                key: .certificate, title: String(localized: "Certificate"), icon: "lock.shield", value: value, tone: tone
            ))
        }
        return rows
    }

    static func percent(_ used: Int64, of total: Int64) -> Double {
        guard total > 0 else { return 0 }
        return min(max(Double(used) / Double(total), 0), 1)
    }
}

/// ONE grouped pane for everything the page monitors. Each row is collapsed to
/// its name and value; a tap opens its detail in place, a second tap closes it.
struct MonitoringPane: View {
    @Environment(\.colorScheme) private var scheme
    let health: BoxHealth?
    let metrics: LoadingState<ServerMetricsResponse>?
    let cert: MonitoringCert?

    @State private var expanded: Set<MonitoringRow.Key> = []
    @State private var openedHealthIssue = false

    var body: some View {
        let c = FSColors.scheme(scheme)
        TimelineView(.periodic(from: .now, by: 30)) { context in
            let nowMs = Int64(context.date.timeIntervalSince1970 * 1000)
            let rows = MonitoringRows.build(health: health, metrics: metrics, cert: cert, nowMs: nowMs)
            if !rows.isEmpty {
                VStack(alignment: .leading, spacing: FS.space.s3) {
                    FSSectionLabel(String(localized: "Monitoring"))
                        .accessibilityAddTraits(.isHeader)
                    VStack(spacing: 0) {
                        ForEach(rows) { row in
                            rowView(row, nowMs: nowMs, c: c)
                        }
                    }
                    .padding(.vertical, FS.space.s1)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(c.surface)
                    .overlay(RoundedRectangle(cornerRadius: FS.radius.md, style: .continuous).stroke(c.border, lineWidth: 1))
                    .clipShape(RoundedRectangle(cornerRadius: FS.radius.md, style: .continuous))
                }
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("sd-monitoring")
            }
        }
        .onAppear {
            // A box reporting a problem opens with that problem showing, as the
            // old standalone health card did.
            guard !openedHealthIssue, let health else { return }
            openedHealthIssue = true
            let nowMs = Int64(Date().timeIntervalSince1970 * 1000)
            if !health.verdict(nowMs: nowMs).ok { expanded.insert(.health) }
        }
    }

    @ViewBuilder
    private func rowView(_ row: MonitoringRow, nowMs: Int64, c: FSColors) -> some View {
        let isOpen = expanded.contains(row.key)
        let toneColor: Color = {
            switch row.tone {
            case .normal: return c.textMuted
            case .warning: return c.warning
            case .danger: return c.danger
            }
        }()
        VStack(alignment: .leading, spacing: 0) {
            Button {
                withAnimation(.easeInOut(duration: 0.2)) {
                    if isOpen { expanded.remove(row.key) } else { expanded.insert(row.key) }
                }
            } label: {
                HStack(spacing: FS.space.s3) {
                    Image(systemName: row.icon)
                        .font(FS.font.scaled(17))
                        .foregroundColor(row.tone == .normal ? c.accent : toneColor)
                        .frame(width: 24)
                    Text(row.title)
                        .font(FS.font.body())
                        .foregroundColor(c.text)
                        .layoutPriority(1)
                    Spacer(minLength: FS.space.s2)
                    if let value = row.value {
                        Text(value)
                            .font(FS.font.body())
                            .monospacedDigit()
                            .foregroundColor(toneColor)
                            .lineLimit(1)
                            .minimumScaleFactor(0.75)
                    } else {
                        ProgressView().controlSize(.small)
                    }
                    Image(systemName: "chevron.right")
                        .font(FS.font.scaled(13, weight: .semibold))
                        .foregroundColor(c.textMuted)
                        .rotationEffect(.degrees(isOpen ? 90 : 0))
                }
                .padding(.horizontal, FS.space.s4)
                .padding(.vertical, 12)
                .frame(minHeight: 44)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(row.title)
            .accessibilityValue("\(row.value ?? String(localized: "Loading")), \(isOpen ? "expanded" : "collapsed")")
            .accessibilityHint(isOpen ? String(localized: "Hides the details.") : "Shows the details.")
            .accessibilityAddTraits(.isButton)
            .accessibilityIdentifier("sd-monitor-\(row.key.rawValue)")

            if isOpen {
                detail(row.key, nowMs: nowMs, c: c)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.leading, FS.space.s4 + 24 + FS.space.s3)
                    .padding(.trailing, FS.space.s4)
                    .padding(.bottom, FS.space.s4)
                    .transition(.opacity)
            }
        }
    }

    @ViewBuilder
    private func detail(_ key: MonitoringRow.Key, nowMs: Int64, c: FSColors) -> some View {
        switch key {
        case .health:
            if let health {
                VStack(alignment: .leading, spacing: FS.space.s1) {
                    ForEach(health.verdict(nowMs: nowMs).lines, id: \.self) { line in
                        Text(line)
                            .font(FS.font.bodySm())
                            .foregroundColor(c.text)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
        case .cpu, .memory, .disk, .network:
            switch metrics {
            case .loaded(let m)?:
                metricDetail(key, m: m, c: c)
            case .failed(let msg)?:
                Text(msg)
                    .font(FS.font.bodySm())
                    .foregroundColor(c.textMuted)
                    .fixedSize(horizontal: false, vertical: true)
            default:
                Text("Loading…").font(FS.font.bodySm()).foregroundColor(c.textMuted)
            }
        case .certificate:
            certDetail(c: c)
        }
    }

    @ViewBuilder
    private func metricDetail(_ key: MonitoringRow.Key, m: ServerMetricsResponse, c: FSColors) -> some View {
        switch key {
        case .cpu:
            VStack(alignment: .leading, spacing: FS.space.s2) {
                Chart(m.cpuHistory) { sample in
                    LineMark(x: .value(String(localized: "Time"), date(sample.at)), y: .value("CPU", sample.value))
                        .interpolationMethod(.catmullRom)
                        .foregroundStyle(c.accent)
                    AreaMark(x: .value(String(localized: "Time"), date(sample.at)), y: .value("CPU", sample.value))
                        .interpolationMethod(.catmullRom)
                        .foregroundStyle(LinearGradient(colors: [c.accent.opacity(0.25), c.accent.opacity(0)], startPoint: .top, endPoint: .bottom))
                }
                .chartYScale(domain: 0...100)
                .chartYAxis { AxisMarks(values: [0, 50, 100]) { _ in AxisGridLine().foregroundStyle(c.border) } }
                .chartXAxis(.hidden)
                .frame(height: 96)
                .accessibilityLabel("CPU over the last hour")
                Text(String(format: "Load %.2f · %.2f · %.2f", m.loadAvg1, m.loadAvg5, m.loadAvg15))
                    .font(FS.font.caption()).foregroundColor(c.textMuted)
            }
        case .memory:
            VStack(alignment: .leading, spacing: FS.space.s2) {
                Chart(m.memHistory) { sample in
                    let pct = MonitoringRows.percent(Int64(sample.value), of: m.memTotalBytes) * 100
                    AreaMark(x: .value(String(localized: "Time"), date(sample.at)), y: .value(String(localized: "Mem"), pct))
                        .interpolationMethod(.catmullRom)
                        .foregroundStyle(LinearGradient(colors: [c.success.opacity(0.45), c.success.opacity(0.05)], startPoint: .top, endPoint: .bottom))
                    LineMark(x: .value(String(localized: "Time"), date(sample.at)), y: .value(String(localized: "Mem"), pct))
                        .foregroundStyle(c.success)
                }
                .chartYScale(domain: 0...100)
                .chartYAxis(.hidden)
                .chartXAxis(.hidden)
                .frame(height: 96)
                .accessibilityLabel("Memory over the last hour")
                Text(String(format: "%.0f%% in use", MonitoringRows.percent(m.memUsedBytes, of: m.memTotalBytes) * 100))
                    .font(FS.font.caption()).foregroundColor(c.textMuted)
            }
        case .disk:
            let pct = MonitoringRows.percent(m.diskUsedBytes, of: m.diskTotalBytes)
            VStack(alignment: .leading, spacing: FS.space.s3) {
                HStack(spacing: FS.space.s4) {
                    ZStack {
                        Circle().stroke(c.surfaceSunken, lineWidth: 8)
                        Circle()
                            .trim(from: 0, to: pct)
                            .stroke(diskColor(pct, c: c), style: StrokeStyle(lineWidth: 8, lineCap: .round))
                            .rotationEffect(.degrees(-90))
                        Text(String(format: "%.0f%%", pct * 100))
                            .font(FS.font.scaled(14, weight: .semibold))
                            .foregroundColor(c.text)
                    }
                    .frame(width: 72, height: 72)
                    .accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: 4) {
                        pair(String(localized: "Used"), formatBytes(m.diskUsedBytes), c: c)
                        pair(String(localized: "Free"), formatBytes(m.diskTotalBytes - m.diskUsedBytes), c: c)
                        pair(String(localized: "Total"), formatBytes(m.diskTotalBytes), c: c)
                    }
                }
                HStack(spacing: FS.space.s4) {
                    rate(String(localized: "Read"), m.diskIOReadBytesPerSec, color: c.accent, c: c)
                    rate(String(localized: "Write"), m.diskIOWriteBytesPerSec, color: c.warning, c: c)
                }
            }
        case .network:
            VStack(alignment: .leading, spacing: FS.space.s2) {
                HStack(spacing: FS.space.s4) {
                    rate(String(localized: "In"), m.netRxBytesPerSec, color: c.success, c: c)
                    rate(String(localized: "Out"), m.netTxBytesPerSec, color: c.danger, c: c)
                }
                Chart {
                    ForEach(m.netHistory) { sample in
                        LineMark(x: .value(String(localized: "Time"), date(sample.at)), y: .value(String(localized: "Rate"), sample.read), series: .value(String(localized: "Series"), "in"))
                            .foregroundStyle(c.success)
                        LineMark(x: .value(String(localized: "Time"), date(sample.at)), y: .value(String(localized: "Rate"), sample.write), series: .value(String(localized: "Series"), "out"))
                            .foregroundStyle(c.danger)
                    }
                }
                .chartYAxis(.hidden)
                .chartXAxis(.hidden)
                .frame(height: 72)
                .accessibilityLabel("Network traffic over the last hour")
            }
        case .health, .certificate:
            EmptyView()
        }
    }

    @ViewBuilder
    private func certDetail(c: FSColors) -> some View {
        if let cert, let after = cert.notAfter {
            VStack(alignment: .leading, spacing: FS.space.s2) {
                labeled(String(localized: "Renews"), Date.flagshipFormatted(epochMs: after), c: c)
                if let before = cert.notBefore {
                    labeled(String(localized: "Issued"), Date.flagshipFormatted(epochMs: before), c: c)
                }
                if let issuer = cert.issuer, !issuer.isEmpty {
                    labeled(String(localized: "Issuer"), issuer, c: c)
                }
                if !cert.sans.isEmpty {
                    Text("Names covered")
                        .font(FS.font.caption())
                        .foregroundColor(c.textMuted)
                        .padding(.top, FS.space.s1)
                    ForEach(cert.sans, id: \.self) { san in
                        Text(san)
                            .font(FS.font.mono())
                            .foregroundColor(c.text)
                            .textSelection(.enabled)
                    }
                }
            }
        } else {
            Text("No certificate yet. The server is getting one.")
                .font(FS.font.bodySm())
                .foregroundColor(c.textMuted)
        }
    }

    private func date(_ ms: Int64) -> Date {
        Date(timeIntervalSince1970: TimeInterval(ms) / 1000)
    }

    private func diskColor(_ pct: Double, c: FSColors) -> Color {
        if pct > 0.9 { return c.danger }
        if pct > 0.75 { return c.warning }
        return c.accent
    }

    private func labeled(_ label: String, _ value: String, c: FSColors) -> some View {
        HStack(alignment: .firstTextBaseline) {
            Text(label).font(FS.font.caption()).foregroundColor(c.textMuted)
            Spacer()
            Text(value).font(FS.font.bodySm()).foregroundColor(c.text).multilineTextAlignment(.trailing)
        }
    }

    private func pair(_ label: String, _ value: String, c: FSColors) -> some View {
        HStack(spacing: 8) {
            Text(label).font(FS.font.caption()).foregroundColor(c.textMuted)
            Text(value).font(FS.font.bodySm()).foregroundColor(c.text)
        }
    }

    private func rate(_ label: String, _ bps: Double, color: Color, c: FSColors) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 4) {
                Circle().fill(color).frame(width: 6, height: 6)
                Text(label).font(FS.font.caption()).foregroundColor(c.textMuted)
            }
            Text(formatRate(bps)).font(FS.font.scaled(15, weight: .semibold)).foregroundColor(c.text)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }
}

fileprivate func formatBytes(_ bytes: Int64) -> String {
    let kb = 1024.0
    let mb = kb * 1024
    let gb = mb * 1024
    let b = Double(bytes)
    if b >= gb { return String(format: "%.1f GB", b / gb) }
    if b >= mb { return String(format: "%.0f MB", b / mb) }
    if b >= kb { return String(format: "%.0f KB", b / kb) }
    return "\(bytes) B"
}

fileprivate func formatRate(_ bytesPerSec: Double) -> String {
    let kb = 1024.0
    let mb = kb * 1024
    if bytesPerSec >= mb { return String(format: "%.1f MB/s", bytesPerSec / mb) }
    if bytesPerSec >= kb { return String(format: "%.0f KB/s", bytesPerSec / kb) }
    return String(format: "%.0f B/s", bytesPerSec)
}
