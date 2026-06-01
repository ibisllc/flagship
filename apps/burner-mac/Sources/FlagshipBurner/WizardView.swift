import SwiftUI
import AppKit
import UniformTypeIdentifiers
import FlagshipBurnerCore

/// Where the help links point. The explainer lives in the docs page (the
/// standalone how-to was folded into /docs); these open it in the browser.
enum FlagshipLinks {
    static let base = "https://flagshipserver.com"
    static let certificate = URL(string: "\(base)/docs#certificate")!
    static let recommendedDistros = URL(string: "\(base)/docs#recommended-linux")!
    static let bootingProcess = URL(string: "\(base)/docs#booting-process")!
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
    // "" = follow the system appearance until the user picks a side.
    @AppStorage("assembler.theme") private var theme = ""
    @Environment(\.colorScheme) private var effectiveScheme

    private var preferredScheme: ColorScheme? {
        switch theme {
        case "light": return .light
        case "dark": return .dark
        default: return nil
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            header
                .padding(.horizontal, FB.Spacing.s5)
                .padding(.top, FB.Spacing.s5)
                .padding(.bottom, FB.Spacing.s3)
            ZStack(alignment: .bottom) {
                panes
                    .padding(.horizontal, FB.Spacing.s5)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
                if showLog {
                    logOverlay
                        .transition(.move(edge: .bottom))
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .clipped()
            logBar
        }
        .frame(width: 560, height: 640)
        .background(FB.Colors.bg)
        .preferredColorScheme(preferredScheme)
        .task { await model.refreshDisks() }
    }

    // MARK: - Body

    private var panes: some View {
        VStack(alignment: .leading, spacing: FB.Spacing.s4) {
            recipeRow
            // Quick uses the burner's cached Alpine base — no user ISO needed.
            // Advanced brings a stock Ubuntu/Debian ISO to remaster.
            if model.mode.requiresUserISO {
                isoRow
            }
            diskRow
            wifiRow
            Spacer(minLength: FB.Spacing.s2)
            bakeRow
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// Download + personalize run on the burner before the write; show those in
    /// the warning (orange) tint so the bar visibly changes color when the
    /// write phase starts filling in the normal accent.
    private var progressTint: Color {
        switch model.phase {
        case "download", "personalize": return FB.Colors.warning
        default: return FB.Colors.primary
        }
    }

    private var header: some View {
        HStack(spacing: FB.Spacing.s2) {
            FlagshipLogo(size: 22)
            Text("Flagship Assembler")
                .font(FB.Font.title())
                .foregroundStyle(FB.Colors.ink)
            Spacer()
            modeMenu
            themeToggle
        }
        .padding(.bottom, FB.Spacing.s1)
    }

    /// Discreet picker that swaps between the two flows.
    /// Quick (default) = flash a pre-personalized Alpine ISO straight through.
    /// Advanced = bring your own stock Ubuntu/Debian ISO + a JSON recipe and
    /// remaster on-device.
    private var modeMenu: some View {
        Menu {
            ForEach(BurnerMode.allCases, id: \.self) { m in
                Button {
                    model.mode = m
                } label: {
                    if model.mode == m {
                        Label(m.menuLabel, systemImage: "checkmark")
                    } else {
                        Text(m.menuLabel)
                    }
                }
            }
        } label: {
            HStack(spacing: 4) {
                Text(model.mode.menuLabel)
                    .font(FB.Font.caption())
                    .foregroundStyle(FB.Colors.textMuted)
                Image(systemName: "chevron.down")
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(FB.Colors.textMuted)
            }
            .padding(.horizontal, FB.Spacing.s2)
            .frame(height: 28)
            .background(
                RoundedRectangle(cornerRadius: FB.Radius.sm)
                    .fill(FB.Colors.surface)
            )
            .overlay(
                RoundedRectangle(cornerRadius: FB.Radius.sm)
                    .strokeBorder(FB.Colors.border, lineWidth: 1)
            )
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .fixedSize()
        .help("Quick: flash a pre-personalized ISO.\nAdvanced: remaster a stock Ubuntu/Debian ISO with a JSON recipe.")
        .pointerCursor()
    }

    /// Day/night toggle. Shows the side you'd switch *to*: a sun when
    /// you're in the dark, a moon when you're in the light. Until first
    /// tapped the app follows the system appearance.
    private var themeToggle: some View {
        let isDark = effectiveScheme == .dark
        return Button {
            theme = isDark ? "light" : "dark"
        } label: {
            Image(systemName: isDark ? "sun.max.fill" : "moon.fill")
                .imageScale(.medium)
                .foregroundStyle(FB.Colors.textMuted)
                .frame(width: 28, height: 28)
                .background(
                    RoundedRectangle(cornerRadius: FB.Radius.sm)
                        .fill(FB.Colors.surface)
                )
                .overlay(
                    RoundedRectangle(cornerRadius: FB.Radius.sm)
                        .strokeBorder(FB.Colors.border, lineWidth: 1)
                )
        }
        .buttonStyle(.plain)
        .help(isDark ? "Switch to day" : "Switch to night")
        .onHover { hovering in
            if hovering { NSCursor.pointingHand.push() } else { NSCursor.pop() }
        }
    }

    // MARK: - Rows

    /// A clickable card with its help link sitting just *below and
    /// outside* the card, so the link isn't part of the drop/click target.
    private func optionGroup<Card: View>(
        @ViewBuilder card: () -> Card,
        linkLabel: String,
        linkURL: URL
    ) -> some View {
        VStack(alignment: .leading, spacing: FB.Spacing.s2) {
            card()
            HelpLink(label: linkLabel, url: linkURL)
                .padding(.leading, FB.Spacing.s1)
        }
        .padding(.bottom, FB.Spacing.s2)
    }

    private var recipeRow: some View {
        optionGroup(
            card: {
                VStack(alignment: .leading, spacing: FB.Spacing.s2) {
                    DropRow(
                        icon: "doc.text.fill",
                        title: "Certificate",
                        description: "Drop or choose the JSON certificate — or paste it",
                        state: recipeRowState(),
                        isReady: model.verified != nil,
                        onDrop: { url in model.acceptRecipeFile(url: url) },
                        onChoose: {
                            if let url = pickFile(types: [.json, .data]) {
                                model.acceptRecipeFile(url: url)
                            }
                        }
                    )
                    // Copy-paste path (preferred on the same machine — nothing
                    // is written to disk except a 0600 temp the CLI reads). The
                    // website's /ready/ page offers a "Copy recipe" button.
                    Button {
                        let s = NSPasteboard.general.string(forType: .string) ?? ""
                        model.acceptRecipeText(s)
                    } label: {
                        Label("Paste certificate from clipboard", systemImage: "doc.on.clipboard")
                            .font(FB.Font.caption())
                    }
                    .buttonStyle(.link)
                }
            },
            linkLabel: "Where to get one?",
            linkURL: FlagshipLinks.certificate
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
        optionGroup(
            card: {
                DropRow(
                    icon: "opticaldisc.fill",
                    title: "Linux ISO",
                    description: "Please use one of the approved distributions for best results",
                    state: isoRowState(),
                    isReady: model.iso != nil,
                    onDrop: { url in model.acceptISOFile(url: url) },
                    onChoose: {
                        if let url = pickFile(types: [.diskImage, .data]) {
                            model.acceptISOFile(url: url)
                        }
                    }
                )
            },
            linkLabel: "List of recommended distros.",
            linkURL: FlagshipLinks.recommendedDistros
        )
    }

    private func isoRowState() -> DropRowState {
        if let iso = model.iso {
            return .success(primary: iso.lastPathComponent, secondary: nil)
        }
        return .empty
    }

    private var diskRow: some View {
        optionGroup(
            card: { DiskPickerRow(model: model) },
            linkLabel: "How does it work?",
            linkURL: FlagshipLinks.bootingProcess
        )
    }

    private var wifiActive: Bool {
        !model.wifiSSID.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// Optional Wi-Fi credentials for a box with no Ethernet. Kept compact —
    /// it's a fallback, not one of the three primary inputs. Baked into the
    /// USB's cloud-init at burn time; never part of the signed recipe.
    private var wifiRow: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: FB.Spacing.s2) {
                Image(systemName: "wifi")
                    .foregroundStyle(wifiActive ? FB.Colors.success : FB.Colors.textMuted)
                    .imageScale(.small)
                    .frame(width: 16)
                TextField("Wi-Fi network (optional)", text: $model.wifiSSID)
                    .textFieldStyle(.roundedBorder)
                SecureField("Password", text: $model.wifiPassword)
                    .textFieldStyle(.roundedBorder)
                    .frame(width: 150)
                    .disabled(!wifiActive)
                    .opacity(wifiActive ? 1 : 0.5)
            }
            Text("Only needed if this machine has no Ethernet cable. Baked into the single-use USB.")
                .font(FB.Font.caption())
                .foregroundStyle(FB.Colors.textMuted)
                .padding(.leading, 16 + FB.Spacing.s2)
        }
        .padding(.horizontal, FB.Spacing.s1)
    }

    // MARK: - Bake

    private var progressCaption: String {
        let label = model.phaseLabel ?? "Working…"
        if let p = model.progress {
            return "\(label)  \(Int((p * 100).rounded()))%"
        }
        return label
    }

    private var bakeRow: some View {
        VStack(spacing: FB.Spacing.s2) {
            if model.isRunning {
                VStack(spacing: FB.Spacing.s2) {
                    Group {
                        if let p = model.progress {
                            ProgressView(value: p)
                        } else {
                            ProgressView()
                        }
                    }
                    .progressViewStyle(.linear)
                    .tint(progressTint)
                    .frame(width: 260)
                    Text(progressCaption)
                        .font(FB.Font.caption())
                        .foregroundStyle(FB.Colors.textMuted)
                        .monospacedDigit()
                    if model.phase == "download" {
                        Text("This won't happen again — every server after this reuses it.")
                            .font(FB.Font.caption())
                            .foregroundStyle(FB.Colors.warning)
                            .multilineTextAlignment(.center)
                            .frame(width: 280)
                    }
                }
                .frame(minHeight: 28)
            } else if model.isFinished {
                doneCard
            } else {
                Button(action: { Task { await model.runWrite() } }) {
                    Text(model.mode.bakeCtaLabel)
                        .font(FB.Font.rowTitle())
                        .frame(minWidth: 200, minHeight: 28)
                }
                .controlSize(.large)
                .buttonStyle(.borderedProminent)
                .keyboardShortcut(.defaultAction)
                .disabled(!model.canFlash)
            }
            if !model.isFinished && !model.isRunning {
                if model.canFlash {
                    // LUKS-encrypted, phone-gated root is always on — not a user
                    // choice — so there's no toggle here.
                    Text("Encrypted disk · unlocked by your phone")
                        .font(FB.Font.caption())
                        .foregroundStyle(FB.Colors.textMuted)
                    Text("Writes to \(model.selectedDisk?.deviceNode ?? "—") · erases what's there")
                        .font(FB.Font.caption())
                        .foregroundStyle(FB.Colors.textMuted)
                } else {
                    Text(model.readinessSummary)
                        .font(FB.Font.caption())
                        .foregroundStyle(FB.Colors.textMuted)
                }
                // Saving a prepared ISO is the Advanced "burn elsewhere" path —
                // remaster only, no USB. Quick mode has nothing to "prepare":
                // its input ISO is already a flashable image, so the user can
                // just copy the file.
                if model.mode == .advanced && model.recipe != nil && model.iso != nil {
                    Button("Or save an ISO file to flash later…") {
                        Task { await model.runPrepare() }
                    }
                    .buttonStyle(.link)
                    .font(FB.Font.caption())
                    .pointerCursor()
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

    /// The always-visible toggle bar pinned to the bottom of the window.
    /// Clicking anywhere on it slides the log overlay up or down.
    private var logBar: some View {
        VStack(spacing: 0) {
            Divider()
            HStack {
                Image(systemName: showLog ? "chevron.down" : "chevron.up")
                    .font(FB.Font.caption())
                    .foregroundStyle(FB.Colors.textMuted)
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
                        .pointerCursor()
                }
            }
            .contentShape(Rectangle())
            .onTapGesture { withAnimation(.easeOut(duration: 0.22)) { showLog.toggle() } }
            .pointerCursor()
            .padding(.horizontal, FB.Spacing.s5)
            .padding(.vertical, FB.Spacing.s2)
        }
        .background(FB.Colors.bg)
    }

    /// The log itself — slides up over the panes (it does not push them)
    /// and fills the available area so the whole scroll is reachable.
    private var logOverlay: some View {
        LogPane(model: model)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .padding(.top, FB.Spacing.s2)
            .background(FB.Colors.bg)
    }
}

// MARK: - DropRow

/// Uniform card height for all three input panes, sized for a title + one
/// body line so they stay symmetric. A long server FQDN may wrap to two
/// lines (lineLimit(2)); since that's the exception, the card grows for it
/// rather than padding every pane to fit the rare case.
private let cardMinHeight: CGFloat = 76

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
    let state: DropRowState
    let isReady: Bool
    let onDrop: (URL) -> Void
    let onChoose: () -> Void

    @State private var isTargeted = false
    @State private var isHovering = false

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
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(FB.Spacing.s3)
        .frame(maxWidth: .infinity, minHeight: cardMinHeight, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: FB.Radius.md)
                .fill(isTargeted
                      ? FB.Colors.primary.opacity(0.06)
                      : (isHovering ? FB.Colors.surfaceElev : FB.Colors.surface))
        )
        .overlay(
            RoundedRectangle(cornerRadius: FB.Radius.md)
                .strokeBorder(
                    isTargeted ? FB.Colors.primary
                        : (isReady ? FB.Colors.success.opacity(0.4)
                           : (isHovering ? FB.Colors.borderStrong : FB.Colors.border)),
                    lineWidth: isTargeted ? 1.5 : 1
                )
        )
        .contentShape(RoundedRectangle(cornerRadius: FB.Radius.md))
        .onTapGesture(perform: onChoose)
        .onHover { hovering in
            isHovering = hovering
            if hovering { NSCursor.pointingHand.push() } else { NSCursor.pop() }
        }
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
                // re-evaluates the closure each tick. Domain + expiry are
                // one concatenated label — "fqdn (expires in 5h 47m)" —
                // that wraps to (at most) two lines.
                TimelineView(.periodic(from: Date(), by: 60)) { context in
                    Text(primary + (secondary(context.date).map { " (\($0))" } ?? ""))
                        .font(FB.Font.rowHint())
                        .lineLimit(2)
                        .truncationMode(.middle)
                        .fixedSize(horizontal: false, vertical: true)
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

    @State private var isHovering = false

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
                pickerMenu
            }
        }
        .padding(FB.Spacing.s3)
        .frame(maxWidth: .infinity, minHeight: cardMinHeight, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: FB.Radius.md)
                .fill(isHovering ? FB.Colors.surfaceElev : FB.Colors.surface)
        )
        .overlay(
            RoundedRectangle(cornerRadius: FB.Radius.md)
                .strokeBorder(
                    model.selectedDisk != nil
                        ? FB.Colors.success.opacity(0.4)
                        : (isHovering ? FB.Colors.borderStrong : FB.Colors.border),
                    lineWidth: 1
                )
        )
        .onHover { isHovering = $0 }
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
                    Text("Choose drive to create boot disk (will be formatted)")
                        .foregroundStyle(FB.Colors.textMuted)
                        .lineLimit(1)
                        .truncationMode(.tail)
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

    /// The whole log as one attributed string. Rendering it as a single
    /// selectable Text (rather than one Text per line) is what lets the
    /// user drag- or keyboard-select across multiple lines and copy them —
    /// selection can't span separate Text views. Per-line color is carried
    /// by the attributes.
    private var attributed: AttributedString {
        var out = AttributedString()
        let lines = model.logLines
        for (i, line) in lines.enumerated() {
            var seg = AttributedString(line.text)
            seg.foregroundColor = line.stream == .stderr ? FB.Colors.danger : Color.primary
            out.append(seg)
            if i < lines.count - 1 { out.append(AttributedString("\n")) }
        }
        return out
    }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    Text(attributed)
                        .font(FB.Font.mono())
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Color.clear.frame(height: 1).id("log-bottom")
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
                if n > 0 { withAnimation { proxy.scrollTo("log-bottom", anchor: .bottom) } }
            }
        }
        .padding(.horizontal, FB.Spacing.s5)
        .padding(.bottom, FB.Spacing.s4)
    }
}

// MARK: - Help link

/// A small inline link that opens an explainer page on the website.
/// Shows the pointing-hand cursor on hover so it reads as a real link.
private struct HelpLink: View {
    let label: String
    let url: URL
    var body: some View {
        Button(label) { NSWorkspace.shared.open(url) }
            .buttonStyle(.link)
            .font(FB.Font.caption())
            .pointerCursor()
    }
}

/// Show the pointing-hand cursor while hovered, so anything clickable
/// (links, link-style buttons) reads as clickable.
private struct PointerOnHover: ViewModifier {
    func body(content: Content) -> some View {
        content.onHover { hovering in
            if hovering { NSCursor.pointingHand.push() } else { NSCursor.pop() }
        }
    }
}

extension View {
    func pointerCursor() -> some View { modifier(PointerOnHover()) }
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
