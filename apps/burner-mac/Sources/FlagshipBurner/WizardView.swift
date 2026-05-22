import SwiftUI
import AppKit
import UniformTypeIdentifiers
import FlagshipBurnerCore

/// Where the help links point. The website hosts the explainer pages.
enum FlagshipLinks {
    static let base = "https://flagshipserver.com"
    static let certificate = URL(string: "\(base)/")!
    static let recommendedDistros = URL(string: "\(base)/recommended-linux")!
    static let bootingProcess = URL(string: "\(base)/booting-process")!
}

/// Single-screen Assembler wizard.
///
/// Three full-width option cards (Certificate → Linux ISO → USB Boot
/// Drive) stacked vertically, a big Assemble button below, and a
/// collapsed log drawer at the bottom. Each card carries a one-line
/// description and a help link to the website.
struct WizardView: View {
    @StateObject private var model = WizardModel()
    @State private var showLog = false

    var body: some View {
        VStack(spacing: 0) {
            content
                .padding(.horizontal, FB.Spacing.s5)
                .padding(.top, FB.Spacing.s5)
            Spacer(minLength: FB.Spacing.s3)
            logDrawer
        }
        .frame(width: 560)
        .frame(minHeight: 600)
        .background(FB.Colors.bg)
        .task { await model.refreshDisks() }
    }

    // MARK: - Body

    private var content: some View {
        VStack(alignment: .leading, spacing: FB.Spacing.s4) {
            header
            recipeRow
            isoRow
            diskRow
            Spacer(minLength: FB.Spacing.s2)
            bakeRow
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var header: some View {
        HStack(spacing: FB.Spacing.s2) {
            FlagshipLogo(size: 22)
            Text("Flagship Assembler")
                .font(FB.Font.title())
                .foregroundStyle(FB.Colors.ink)
            Spacer()
        }
        .padding(.bottom, FB.Spacing.s1)
    }

    // MARK: - Rows

    private var recipeRow: some View {
        DropRow(
            icon: "doc.text.fill",
            title: "Certificate",
            description: "The json certificate file generated online",
            linkLabel: "where to get one?",
            linkURL: FlagshipLinks.certificate,
            state: recipeRowState(),
            isReady: model.verified != nil,
            onDrop: { url in model.acceptRecipeFile(url: url) },
            onChoose: {
                if let url = pickFile(types: [.json, .data]) {
                    model.acceptRecipeFile(url: url)
                }
            }
        )
    }

    private func recipeRowState() -> DropRowState {
        if let err = model.recipeError {
            return .error(err)
        }
        if let v = model.verified {
            // Live-tick the expiry countdown via the TimelineView the
            // DropRow wraps the success state in. The label is computed
            // from `now` each refresh, so a 5h 47m → 5h 46m transition
            // is visible without the user reloading anything.
            return .successDynamic(primary: v.serverDomain,
                                   secondary: { now in v.expiryLabel(now: now) })
        }
        if let r = model.recipe {
            return .pending(r.lastPathComponent)
        }
        return .empty
    }

    private var isoRow: some View {
        DropRow(
            icon: "opticaldisc.fill",
            title: "Linux ISO",
            description: "Please use one of the approved distributions for best results",
            linkLabel: "List of recommended distros",
            linkURL: FlagshipLinks.recommendedDistros,
            state: isoRowState(),
            isReady: model.iso != nil,
            onDrop: { url in model.acceptISOFile(url: url) },
            onChoose: {
                if let url = pickFile(types: [.diskImage, .data]) {
                    model.acceptISOFile(url: url)
                }
            }
        )
    }

    private func isoRowState() -> DropRowState {
        if let iso = model.iso {
            return .success(primary: iso.lastPathComponent, secondary: nil)
        }
        return .empty
    }

    private var diskRow: some View {
        DiskPickerRow(model: model)
    }

    // MARK: - Bake

    private var bakeRow: some View {
        VStack(spacing: FB.Spacing.s2) {
            if model.isRunning {
                Button(action: { model.cancel() }) {
                    HStack(spacing: FB.Spacing.s2) {
                        ProgressView().controlSize(.small)
                        Text("Working — click to cancel")
                            .font(FB.Font.rowTitle())
                    }
                    .frame(minWidth: 200, minHeight: 28)
                }
                .controlSize(.large)
                .buttonStyle(.bordered)
                .keyboardShortcut(.cancelAction)
            } else if model.isFinished {
                doneCard
            } else {
                Button(action: { Task { await model.runWrite() } }) {
                    Text("Assemble")
                        .font(FB.Font.rowTitle())
                        .frame(minWidth: 200, minHeight: 28)
                }
                .controlSize(.large)
                .buttonStyle(.borderedProminent)
                .keyboardShortcut(.defaultAction)
                .disabled(!model.canFlash)
            }
            if !model.isFinished {
                if model.canFlash {
                    Text("Writes to \(model.selectedDisk?.deviceNode ?? "—") · erases what's there")
                        .font(FB.Font.caption())
                        .foregroundStyle(FB.Colors.textMuted)
                    Button("Or save an ISO file to flash later…") {
                        Task { await model.runPrepare() }
                    }
                    .buttonStyle(.link)
                    .font(FB.Font.caption())
                } else {
                    Text(model.readinessSummary)
                        .font(FB.Font.caption())
                        .foregroundStyle(FB.Colors.textMuted)
                }
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, FB.Spacing.s2)
    }

    private var doneCard: some View {
        VStack(alignment: .leading, spacing: FB.Spacing.s2) {
            HStack(spacing: FB.Spacing.s2) {
                Image(systemName: "checkmark.circle.fill")
                    .foregroundStyle(FB.Colors.success)
                Text("Ready to boot")
                    .font(FB.Font.rowTitle())
            }
            if let v = model.verified {
                Text(v.serverDomain)
                    .font(FB.Font.mono())
                    .textSelection(.enabled)
            }
            if let out = model.outIsoPath {
                Text(out.path)
                    .font(FB.Font.mono())
                    .foregroundStyle(FB.Colors.textMuted)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .textSelection(.enabled)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(FB.Spacing.s3)
        .background(
            RoundedRectangle(cornerRadius: FB.Radius.md)
                .fill(FB.Colors.success.opacity(0.08))
        )
        .overlay(
            RoundedRectangle(cornerRadius: FB.Radius.md)
                .strokeBorder(FB.Colors.success.opacity(0.4), lineWidth: 1)
        )
    }

    // MARK: - Log drawer

    private var logDrawer: some View {
        VStack(spacing: 0) {
            Divider()
            DisclosureGroup(isExpanded: $showLog) {
                LogPane(model: model)
                    .frame(height: 320)
                    .padding(.top, FB.Spacing.s2)
            } label: {
                HStack {
                    Text("Log")
                        .font(FB.Font.caption())
                        .foregroundStyle(FB.Colors.textMuted)
                    if !model.logLines.isEmpty {
                        Text("\(model.logLines.count)")
                            .font(FB.Font.caption().monospacedDigit())
                            .foregroundStyle(FB.Colors.textMuted)
                    }
                    Spacer()
                    if !model.logLines.isEmpty && !model.isRunning {
                        Button("Clear") { model.clearLog() }
                            .buttonStyle(.link)
                            .font(FB.Font.caption())
                    }
                }
                .contentShape(Rectangle())
            }
            .padding(.horizontal, FB.Spacing.s5)
            .padding(.vertical, FB.Spacing.s2)
        }
    }
}

// MARK: - DropRow

enum DropRowState {
    case empty
    case pending(String)
    case success(primary: String, secondary: String?)
    /// Same as `.success` but the secondary string is computed live
    /// each minute via `TimelineView` — used by the recipe row's
    /// "expires in 5h 47m" countdown.
    case successDynamic(primary: String, secondary: (Date) -> String?)
    case error(String)
}

private struct DropRow: View {
    let icon: String
    let title: String
    let description: String
    let linkLabel: String
    let linkURL: URL
    let state: DropRowState
    let isReady: Bool
    let onDrop: (URL) -> Void
    let onChoose: () -> Void

    @State private var isTargeted = false

    var body: some View {
        HStack(alignment: .top, spacing: FB.Spacing.s3) {
            iconCircle
            VStack(alignment: .leading, spacing: 2) {
                HStack(alignment: .firstTextBaseline, spacing: FB.Spacing.s2) {
                    Text(title).font(FB.Font.rowTitle())
                    Spacer()
                    statusIcon
                }
                stateBody
                HelpLink(label: linkLabel, url: linkURL)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(FB.Spacing.s3)
        .background(
            RoundedRectangle(cornerRadius: FB.Radius.md)
                .fill(isTargeted
                      ? FB.Colors.primary.opacity(0.06)
                      : FB.Colors.surface)
        )
        .overlay(
            RoundedRectangle(cornerRadius: FB.Radius.md)
                .strokeBorder(
                    isTargeted ? FB.Colors.primary
                        : (isReady ? FB.Colors.success.opacity(0.4)
                           : FB.Colors.border),
                    lineWidth: isTargeted ? 1.5 : 1
                )
        )
        .contentShape(RoundedRectangle(cornerRadius: FB.Radius.md))
        .onTapGesture(perform: onChoose)
        .onDrop(of: [.fileURL], isTargeted: $isTargeted) { providers in
            guard let p = providers.first else { return false }
            _ = p.loadObject(ofClass: URL.self) { item, _ in
                if let url = item {
                    DispatchQueue.main.async { onDrop(url) }
                }
            }
            return true
        }
    }

    private var iconCircle: some View {
        ZStack {
            Circle()
                .fill(isReady ? FB.Colors.success.opacity(0.15)
                              : FB.Colors.surfaceElev)
                .frame(width: 36, height: 36)
            Image(systemName: icon)
                .foregroundStyle(isReady ? FB.Colors.success : FB.Colors.textMuted)
                .imageScale(.medium)
        }
    }

    private var statusIcon: some View {
        Group {
            switch state {
            case .success, .successDynamic:
                Image(systemName: "checkmark.circle.fill")
                    .foregroundStyle(FB.Colors.success)
            case .pending:
                ProgressView().controlSize(.small)
            case .error:
                Image(systemName: "exclamationmark.triangle.fill")
                    .foregroundStyle(FB.Colors.danger)
            case .empty:
                EmptyView()
            }
        }
        .font(FB.Font.caption())
    }

    private var stateBody: some View {
        Group {
            switch state {
            case .empty:
                Text(description)
                    .font(FB.Font.rowHint())
                    .foregroundStyle(FB.Colors.textMuted)
                    .fixedSize(horizontal: false, vertical: true)
            case .pending(let name):
                Text(name)
                    .font(FB.Font.rowHint())
                    .foregroundStyle(FB.Colors.textMuted)
            case .success(let primary, let secondary):
                VStack(alignment: .leading, spacing: 1) {
                    Text(primary)
                        .font(FB.Font.rowHint())
                        .lineLimit(1)
                        .truncationMode(.middle)
                    if let s = secondary {
                        Text(s).font(FB.Font.caption())
                            .foregroundStyle(FB.Colors.textMuted)
                    }
                }
            case .successDynamic(let primary, let secondary):
                // 1-minute heartbeat for the countdown. TimelineView
                // re-evaluates the closure each tick, no manual @State
                // bookkeeping needed.
                TimelineView(.periodic(from: Date(), by: 60)) { context in
                    VStack(alignment: .leading, spacing: 1) {
                        Text(primary)
                            .font(FB.Font.rowHint())
                            .lineLimit(1)
                            .truncationMode(.middle)
                        if let s = secondary(context.date) {
                            Text(s).font(FB.Font.caption())
                                .foregroundStyle(FB.Colors.textMuted)
                        }
                    }
                }
            case .error(let msg):
                Text(msg)
                    .font(FB.Font.rowHint())
                    .foregroundStyle(FB.Colors.danger)
            }
        }
    }
}

// MARK: - DiskPickerRow

private struct DiskPickerRow: View {
    @ObservedObject var model: WizardModel

    var body: some View {
        HStack(alignment: .top, spacing: FB.Spacing.s3) {
            ZStack {
                Circle()
                    .fill(model.selectedDisk != nil
                          ? FB.Colors.warning.opacity(0.15)
                          : FB.Colors.surfaceElev)
                    .frame(width: 36, height: 36)
                Image(systemName: "externaldrive.fill")
                    .foregroundStyle(model.selectedDisk != nil
                                     ? FB.Colors.warning : FB.Colors.textMuted)
                    .imageScale(.medium)
            }
            VStack(alignment: .leading, spacing: 2) {
                HStack(alignment: .firstTextBaseline, spacing: FB.Spacing.s2) {
                    Text("USB Boot Drive").font(FB.Font.rowTitle())
                    Spacer()
                    if model.selectedDisk != nil {
                        Image(systemName: "checkmark.circle.fill")
                            .foregroundStyle(FB.Colors.success)
                            .font(FB.Font.caption())
                    }
                }
                if model.selectedDisk == nil {
                    Text("This drive will be formatted to create a one-time boot disk for your server")
                        .font(FB.Font.rowHint())
                        .foregroundStyle(FB.Colors.textMuted)
                        .fixedSize(horizontal: false, vertical: true)
                }
                pickerMenu
                HelpLink(label: "how does it work", url: FlagshipLinks.bootingProcess)
            }
        }
        .padding(FB.Spacing.s3)
        .background(
            RoundedRectangle(cornerRadius: FB.Radius.md)
                .fill(FB.Colors.surface)
        )
        .overlay(
            RoundedRectangle(cornerRadius: FB.Radius.md)
                .strokeBorder(
                    model.selectedDisk != nil
                        ? FB.Colors.success.opacity(0.4)
                        : FB.Colors.border,
                    lineWidth: 1
                )
        )
    }

    private var pickerMenu: some View {
        HStack(spacing: FB.Spacing.s2) {
            Menu {
                if model.disks.isEmpty {
                    Text("No removable drives detected")
                }
                ForEach(model.disks) { disk in
                    Button {
                        model.selectedDisk = disk
                    } label: {
                        Text("\(disk.displayName) — \(disk.deviceNode)")
                    }
                }
                Divider()
                Button("Refresh") {
                    Task { await model.refreshDisks() }
                }
            } label: {
                if let sel = model.selectedDisk {
                    Text(sel.displayName)
                        .lineLimit(1)
                        .truncationMode(.middle)
                } else {
                    Text("Choose drive…")
                        .foregroundStyle(FB.Colors.textMuted)
                }
            }
            .menuStyle(.borderlessButton)
            .font(FB.Font.rowHint())
            .frame(maxWidth: .infinity, alignment: .leading)
            if model.isRefreshingDisks {
                ProgressView().controlSize(.small)
            }
        }
    }
}

// MARK: - Log pane

private struct LogPane: View {
    @ObservedObject var model: WizardModel

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 1) {
                    ForEach(Array(model.logLines.enumerated()), id: \.offset) { idx, line in
                        Text(line.text)
                            .font(FB.Font.mono())
                            .foregroundStyle(line.stream == .stderr
                                             ? FB.Colors.danger
                                             : Color.primary)
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .id(idx)
                    }
                }
                .padding(FB.Spacing.s3)
            }
            .background(FB.Colors.surfaceElev)
            .overlay(
                RoundedRectangle(cornerRadius: FB.Radius.sm)
                    .strokeBorder(FB.Colors.border, lineWidth: 1)
            )
            .clipShape(RoundedRectangle(cornerRadius: FB.Radius.sm))
            .onChange(of: model.logLines.count) { _, n in
                if n > 0 { withAnimation { proxy.scrollTo(n - 1, anchor: .bottom) } }
            }
        }
        .padding(.horizontal, FB.Spacing.s5)
        .padding(.bottom, FB.Spacing.s4)
    }
}

// MARK: - Help link

/// A small inline link that opens an explainer page on the website.
private struct HelpLink: View {
    let label: String
    let url: URL
    var body: some View {
        Button(label) { NSWorkspace.shared.open(url) }
            .buttonStyle(.link)
            .font(FB.Font.caption())
            .padding(.top, 1)
    }
}

// MARK: - File picker

private func pickFile(types: [UTType]) -> URL? {
    let panel = NSOpenPanel()
    panel.allowsMultipleSelection = false
    panel.canChooseDirectories = false
    panel.canChooseFiles = true
    panel.allowedContentTypes = types
    return panel.runModal() == .OK ? panel.url : nil
}
