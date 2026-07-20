import SwiftUI
import AppKit
import UniformTypeIdentifiers
import FlagshipBuilderCore

/// Where the help links point. The explainer lives in the docs page (the
/// standalone how-to was folded into /docs); these open it in the browser.
enum FlagshipLinks {
    static let base = "https://flagshipserver.com"
    static let certificate = URL(string: "\(base)/docs#certificate")!
    static let recommendedDistros = URL(string: "\(base)/docs#recommended-linux")!
    static let bootingProcess = URL(string: "\(base)/docs#booting-process")!
}

/// Single-screen Builder wizard.
///
/// Three full-width option cards (Certificate → Linux ISO → USB Boot
/// Drive) stacked vertically, a big Assemble button below, and a
/// collapsed log drawer at the bottom. Each card carries a one-line
/// description and a help link to the website.
struct WizardView: View {
    @ObservedObject var model: WizardModel
    @State private var showLog = false
    /// Tracks which Wi-Fi field holds the keyboard focus so we can resign it
    /// when the log overlay opens — otherwise AppKit leaves the blue focus
    /// ring drawn over the log (a stale first-responder artifact).
    @FocusState private var wifiFocus: WifiField?

    private enum WifiField: Hashable { case ssid, password }
    // "" = follow the system appearance until the user picks a side (chosen from
    // the menu bar: View → Appearance → Auto / Light / Dark).
    @AppStorage("builder.theme") private var theme = ""

    private var preferredScheme: ColorScheme? {
        switch theme {
        case "light": return .light
        case "dark": return .dark
        default: return nil
        }
    }

    var body: some View {
        HStack(spacing: 0) {
            wizardColumn
                .frame(width: 560)
            Divider()
            HostedServersSidebar(model: model, vmManager: model.vmManager)
                .frame(width: 330)
        }
        .frame(height: 700)
        .background(FB.Colors.bg)
        .preferredColorScheme(preferredScheme)
        .task { await model.refreshDisks() }
        .onChange(of: showLog) { _, shown in
            // Drop keyboard focus the instant the log opens so AppKit doesn't
            // leave a stale focus ring painted where the field used to be.
            if shown { wifiFocus = nil }
        }
    }

    private var wizardColumn: some View {
        VStack(spacing: 0) {
            header
                .padding(.horizontal, FB.Spacing.s5)
                .padding(.top, FB.Spacing.s5)
                .padding(.bottom, FB.Spacing.s3)
            ZStack(alignment: .bottom) {
                // Only render the form when the log is hidden. Conditional
                // rendering (rather than just layering the log on top) removes
                // the text fields entirely while the log is up, so neither the
                // fields nor any leftover focus ring can float over the log.
                if !showLog {
                    stageContent
                        .padding(.horizontal, FB.Spacing.s5)
                        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
                }
                if showLog {
                    logOverlay
                        .transition(.move(edge: .bottom))
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .clipped()
            logBar
        }
    }

    // MARK: - Body

    /// The one-shot phone deposit is the gate: locked cover → SAS confirm →
    /// the destination chooser → the burn form OR the host-here pane. A
    /// sidebar selection overrides everything with that server's detail.
    /// "I have a recipe" jumps straight to a Simple-only burn form (no
    /// Advanced — no session to authorize it).
    @ViewBuilder private var stageContent: some View {
        if let selected = model.selectedHostedServer {
            VMDetailView(model: model, vmManager: model.vmManager, name: selected)
        } else if let countdown = model.homeResetCountdown {
            recipeConsumedView(countdown: countdown)
        } else {
            switch model.builderStage {
            case .locked:    coverView
            case .pairing:   pairingConfirmView
            case .session, .recipeReady, .recipeFile: destinationOrPanes
            }
        }
    }

    private func recipeConsumedView(countdown: Int) -> some View {
        VStack(spacing: FB.Spacing.s4) {
            Spacer()
            StatusCard(icon: "checkmark.circle.fill",
                       tint: FB.Colors.success,
                       title: "Recipe handed off",
                       subtitle: "The server operation is continuing in the background. You can follow it from Servers on this Mac.")
            HStack(spacing: FB.Spacing.s2) {
                ProgressView().scaleEffect(0.7)
                Text(countdown > 0
                     ? "Returning home in \(countdown)…"
                     : "Preparing a new pairing code…")
                    .font(FB.Font.caption())
                    .foregroundStyle(FB.Colors.textMuted)
            }
            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    /// Once a recipe is verified the user picks its destination; before that
    /// (waiting for the phone / loading a file) the existing panes show.
    @ViewBuilder private var destinationOrPanes: some View {
        if model.verified != nil && model.destination == nil {
            destinationChooser
        } else if model.destination == .hostHere {
            hostHerePane
        } else {
            panes
        }
    }

    // MARK: - Destination chooser (Burn to USB / Host here)

    private var destinationChooser: some View {
        VStack(alignment: .leading, spacing: FB.Spacing.s4) {
            if model.advancedAllowed { sessionHeader }
            if let v = model.verified {
                StatusCard(icon: "checkmark.seal.fill",
                           tint: FB.Colors.primary,
                           title: v.serverDomain,
                           subtitle: "Recipe verified — choose where this server should live.")
            }
            destinationCard(
                icon: "externaldrive.fill",
                title: "Burn to USB",
                subtitle: "Build a dedicated hardware appliance — the gold standard. Boot any spare box from the USB stick.",
                badge: ServerTier.hardware.badgeLabel,
                disabledReason: nil
            ) { model.destination = .burnToUSB }
            destinationCard(
                icon: "desktopcomputer",
                title: "Host on this Mac",
                subtitle: "Run the same encrypted, phone-gated appliance as a managed VM inside this app. Same recipe, same unlock — your phone still holds the keys.",
                badge: ServerTier.hostedVM.badgeLabel,
                disabledReason: hostHereDisabledReason
            ) { model.destination = .hostHere }
        }
    }

    private var hostHereDisabledReason: String? {
        let cap = model.vmManager.maxVMCount
        if cap == 0 {
            return "This Mac doesn't have enough free memory to host a server."
        }
        if model.vmManager.servers.count >= cap {
            return "This Mac is at its hosting limit (\(cap))."
        }
        return nil
    }

    private func destinationCard(icon: String, title: String, subtitle: String,
                                 badge: String, disabledReason: String?,
                                 action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(alignment: .top, spacing: FB.Spacing.s3) {
                ZStack {
                    Circle().fill(FB.Colors.surfaceElev).frame(width: 36, height: 36)
                    Image(systemName: icon)
                        .foregroundStyle(FB.Colors.primary)
                        .imageScale(.medium)
                }
                VStack(alignment: .leading, spacing: 2) {
                    HStack(alignment: .firstTextBaseline) {
                        Text(title).font(FB.Font.rowTitle()).foregroundStyle(FB.Colors.ink)
                        Spacer()
                        Text(badge)
                            .font(FB.Font.caption())
                            .foregroundStyle(FB.Colors.textMuted)
                    }
                    Text(disabledReason ?? subtitle)
                        .font(FB.Font.rowHint())
                        .foregroundStyle(disabledReason != nil ? FB.Colors.warning : FB.Colors.textMuted)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(FB.Spacing.s3)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: FB.Radius.md).fill(FB.Colors.surface))
            .overlay(RoundedRectangle(cornerRadius: FB.Radius.md)
                .strokeBorder(FB.Colors.border, lineWidth: 1))
            .contentShape(RoundedRectangle(cornerRadius: FB.Radius.md))
        }
        .buttonStyle(.plain)
        .pointerCursor()
        .disabled(disabledReason != nil)
        .opacity(disabledReason != nil ? 0.6 : 1)
    }

    // MARK: - Host here pane

    private var hostHerePane: some View {
        let host = HostResources.current()
        return VStack(alignment: .leading, spacing: FB.Spacing.s4) {
            HStack {
                Button {
                    model.destination = nil
                } label: {
                    Label("Choose destination", systemImage: "chevron.left")
                        .font(FB.Font.caption())
                }
                .buttonStyle(.link)
                .disabled(model.isRunning)
                Spacer()
            }
            if let v = model.verified {
                StatusCard(icon: "desktopcomputer",
                           tint: FB.Colors.primary,
                           title: v.serverDomain,
                           subtitle: "Will run as a managed VM on this Mac — \(VMResourcePlan.vmCPUCount(host: host)) vCPU, \(VMResourcePlan.vmMemoryBytes(host: host) / VMResourcePlan.gib) GiB RAM, \(VMResourcePlan.defaultMainDiskSizeBytes / VMResourcePlan.gib) GiB disk.")
            }
            Text("The VM installs unattended from the same image a USB burn uses, then boots encrypted and waits for your phone to unlock it. This app never sees the disk key.")
                .font(FB.Font.caption())
                .foregroundStyle(FB.Colors.textMuted)
                .fixedSize(horizontal: false, vertical: true)
            if let error = model.operationError {
                StatusCard(icon: "exclamationmark.triangle.fill",
                           tint: FB.Colors.warning,
                           title: "Couldn't create the server",
                           subtitle: error)
            }
            Spacer(minLength: FB.Spacing.s2)
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
                        if let url = model.baseDownloadURL {
                            Text(url)
                                .font(FB.Font.mono())
                                .foregroundStyle(FB.Colors.textMuted)
                                .lineLimit(1)
                                .truncationMode(.middle)
                                .frame(maxWidth: 300)
                        }
                    }
                } else {
                    Button {
                        Task { await model.runHostHere() }
                    } label: {
                        Text("Create server on this Mac")
                            .font(FB.Font.rowTitle())
                            .frame(minWidth: 200, minHeight: 28)
                    }
                    .controlSize(.large)
                    .buttonStyle(.borderedProminent)
                    .disabled(model.verified == nil || (model.effectiveRequiresUserISO && model.iso == nil))
                    Text("Encrypted disk · unlocked by your phone")
                        .font(FB.Font.caption())
                        .foregroundStyle(FB.Colors.textMuted)
                }
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, FB.Spacing.s2)
        }
    }

    private var panes: some View {
        VStack(alignment: .leading, spacing: FB.Spacing.s4) {
            // Advanced (BYO ISO) remains available after the one-shot receipt.
            if model.advancedAllowed {
                sessionHeader
                modePicker
            } else {
                recipeFileHeader
            }
            // Back to the destination chooser (only shown once a verified
            // recipe made the chooser meaningful).
            if model.destination == .burnToUSB && model.verified != nil {
                Button {
                    model.destination = nil
                } label: {
                    Label("Host on this Mac instead", systemImage: "desktopcomputer")
                        .font(FB.Font.caption())
                }
                .buttonStyle(.link)
                .pointerCursor()
                .disabled(model.isRunning)
            }
            if model.builderStage == .recipeFile {
                recipeRow
            } else {
                sessionRecipeRow
            }
            // Advanced brings its own stock Ubuntu/Debian ISO; Simple fetches a
            // server-named Debian base ISO and shows the download progress. The
            // "Use system-provided ISO" checkbox lets Advanced fetch it too.
            if model.advancedAllowed && model.mode == .advanced {
                isoRow
            }
            diskRow
            wifiRow
            Spacer(minLength: FB.Spacing.s2)
            bakeRow
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// Once the one-shot deposit completes there is no live phone connection.
    /// Keep only a recipe-level reset action; during the brief handshake the
    /// same action cancels pairing and retires the QR.
    private var sessionHeader: some View {
        HStack(spacing: FB.Spacing.s3) {
            if model.builderStage == .recipeReady {
                Label("Recipe received · phone session finished", systemImage: "checkmark.circle.fill")
                    .font(FB.Font.caption())
                    .foregroundStyle(FB.Colors.success)
            }
            Spacer(minLength: 0)
            Button {
                model.startOver()
            } label: {
                Label(model.builderStage == .recipeReady ? "Start over" : "Cancel pairing",
                      systemImage: model.builderStage == .recipeReady ? "arrow.counterclockwise" : "xmark.circle")
                    .font(FB.Font.caption())
                    .foregroundStyle(model.builderStage == .recipeReady ? FB.Colors.textMuted : FB.Colors.danger)
            }
            .buttonStyle(.plain)
            .pointerCursor()
            .disabled(model.isRunning)
        }
    }

    /// Header for the out-of-band recipe path: a back link to the pairing
    /// cover, so a user who picked "I have a recipe" by mistake can return.
    private var recipeFileHeader: some View {
        HStack(spacing: FB.Spacing.s2) {
            Button {
                model.returnToCover()
            } label: {
                Label("Pair a phone instead", systemImage: "chevron.left")
                    .font(FB.Font.caption())
            }
            .buttonStyle(.link)
            .disabled(model.isRunning)
            Spacer()
        }
    }

    /// In a live session the recipe is delivered by the phone — show its
    /// status rather than a drop target.
    private var sessionRecipeRow: some View {
        VStack(alignment: .leading, spacing: FB.Spacing.s2) {
            if let v = model.verified {
                StatusCard(icon: "checkmark.seal.fill",
                           tint: FB.Colors.primary,
                           title: v.serverDomain,
                           subtitle: "Recipe received from your phone.")
            } else if let err = model.recipeError {
                StatusCard(icon: "exclamationmark.triangle.fill",
                           tint: FB.Colors.warning,
                           title: "Couldn't read the recipe",
                           subtitle: err)
            } else {
                StatusCard(icon: "iphone.gen3",
                           tint: FB.Colors.textMuted,
                           title: "Waiting for your phone…",
                           subtitle: "Send the server recipe from the Flagship app.")
            }
        }
        .padding(.bottom, FB.Spacing.s2)
    }

    // MARK: - Locked cover (pair your phone)

    /// The locked cover. The one-shot phone deposit is the gate into the builder:
    /// scan the QR (or type the code) in the Flagship app, confirm the
    /// security code, and the burn UI opens. "I have a recipe" is the
    /// out-of-band escape hatch for a recipe received elsewhere.
    private var coverView: some View {
        VStack(spacing: FB.Spacing.s4) {
            Spacer(minLength: FB.Spacing.s2)
            Text("Pair your phone to begin")
                .font(FB.Font.title())
                .foregroundStyle(FB.Colors.ink)
            if model.isOnline {
                Text("Open the Flagship app on your phone and scan this code — or type it in. You'll confirm a short security code, then build your server here.")
                    .font(FB.Font.caption())
                    .foregroundStyle(FB.Colors.textMuted)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, FB.Spacing.s4)

                if let payload = model.pairQrPayload {
                    QRCodeView(payload: payload, size: 200)
                } else {
                    ProgressView().frame(width: 200, height: 200)
                }

                if let code = model.pairCodeDisplay {
                    VStack(spacing: FB.Spacing.s1) {
                        Text("Or enter this code")
                            .font(FB.Font.caption())
                            .foregroundStyle(FB.Colors.textMuted)
                        Text(code)
                            .font(.system(.title2, design: .monospaced, weight: .semibold))
                            .foregroundStyle(FB.Colors.ink)
                            .textSelection(.enabled)
                    }
                }

                HStack(spacing: FB.Spacing.s2) {
                    ProgressView().scaleEffect(0.6)
                    Text(model.pairStatus)
                        .font(FB.Font.caption())
                        .foregroundStyle(FB.Colors.textMuted)
                }
            } else {
                // No network: the QR / code / pairing status can't do anything, so
                // the whole pairing block is replaced by a single "waiting for the
                // internet" line. It swaps straight back to the live QR the moment
                // connectivity returns (and back here if it drops again).
                VStack(spacing: FB.Spacing.s3) {
                    Text("Connect to the internet to pair your phone.")
                        .font(FB.Font.caption())
                        .foregroundStyle(FB.Colors.textMuted)
                        .multilineTextAlignment(.center)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.horizontal, FB.Spacing.s4)
                    HStack(spacing: FB.Spacing.s2) {
                        ProgressView().scaleEffect(0.6)
                        Text("Waiting for internet connection…")
                            .font(FB.Font.rowTitle())
                            .foregroundStyle(FB.Colors.ink)
                    }
                }
                .frame(minHeight: 200)
            }

            Spacer(minLength: FB.Spacing.s2)

            Button {
                model.enterRecipeFileMode()
            } label: {
                Text("I have a recipe")
                    .font(FB.Font.caption())
            }
            .buttonStyle(.link)
            .help("Already have a recipe file from someone else? Load it directly (basic burn only).")
            .padding(.bottom, FB.Spacing.s2)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    // MARK: - SAS confirm

    /// Shown once a phone joins: display the 6-digit security code for the
    /// user to compare with their phone. The phone's tap-to-confirm flips us
    /// into the session (the builder doesn't have its own confirm button —
    /// the human comparison happens against the phone).
    private var pairingConfirmView: some View {
        VStack(spacing: FB.Spacing.s4) {
            Spacer()
            Image(systemName: "lock.shield")
                .font(.system(size: 40))
                .foregroundStyle(FB.Colors.primary)
            Text("Confirm the security code")
                .font(FB.Font.title())
                .foregroundStyle(FB.Colors.ink)
            Text("Check that this code matches the one shown in the Flagship app, then confirm on your phone.")
                .font(FB.Font.caption())
                .foregroundStyle(FB.Colors.textMuted)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.horizontal, FB.Spacing.s5)

            Text(BuilderPairing.formatMatchCode(model.pairMatchCode ?? "------"))
                .font(.system(size: 40, design: .monospaced).weight(.bold))
                .foregroundStyle(FB.Colors.ink)
                .padding(.vertical, FB.Spacing.s3)
                .padding(.horizontal, FB.Spacing.s5)
                .background(RoundedRectangle(cornerRadius: FB.Radius.md).fill(FB.Colors.surfaceSunken))

            HStack(spacing: FB.Spacing.s2) {
                ProgressView().scaleEffect(0.6)
                Text("Waiting for you to confirm on your phone…")
                    .font(FB.Font.caption())
                    .foregroundStyle(FB.Colors.textMuted)
            }
            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    /// Simple (default, server-named Debian base) vs Advanced (bring your own
    /// ISO). Disabled while a burn is running so the inputs can't change mid-run.
    /// Security choices (debug console, embed-secrets) live on the PHONE at mint
    /// time and are baked into the delivered recipe — the builder just burns it.
    private var modePicker: some View {
        HStack(spacing: FB.Spacing.s3) {
            ModePill(selection: $model.mode)
        }
        .disabled(model.isRunning)
        .opacity(model.isRunning ? 0.5 : 1)
    }

    /// The remaster runs on the builder before the write; show it in the warning
    /// (orange) tint so the bar visibly changes color when the write phase
    /// starts filling in the normal accent.
    private var progressTint: Color {
        switch model.phase {
        case "remaster": return FB.Colors.warning
        default: return FB.Colors.primary
        }
    }

    private var header: some View {
        HStack(spacing: FB.Spacing.s2) {
            if model.selectedHostedServer != nil {
                homeButton
            }
            Spacer()
        }
        .padding(.bottom, FB.Spacing.s1)
    }

    private var homeButton: some View {
        Button {
            model.selectedHostedServer = nil
        } label: {
            Image(systemName: "house.fill")
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
        .help("Return to pairing home")
        .pointerCursor()
    }

    // MARK: - Rows

    /// A clickable card with a help icon. For most rows the icon floats to the
    /// right just below the card; the certificate row overrides this and pins
    /// its icon to the right of the "Paste certificate…" prompt instead.
    private func optionGroup<Card: View, Leading: View>(
        @ViewBuilder card: () -> Card,
        @ViewBuilder leading: () -> Leading = { EmptyView() },
        help: HelpIcon
    ) -> some View {
        VStack(alignment: .leading, spacing: FB.Spacing.s2) {
            card()
            HStack {
                // Optional left-aligned control (e.g. the "Use system-provided
                // ISO" checkbox) shares the help icon's row.
                leading()
                Spacer()
                help
            }
            .padding(.trailing, FB.Spacing.s1)
        }
        .padding(.bottom, FB.Spacing.s2)
    }

    private var recipeRow: some View {
        // The certificate help icon must sit on the SAME line as the
        // "Paste certificate…" prompt (right-aligned), so this row builds its
        // own layout rather than going through the generic `optionGroup`.
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
            HStack(alignment: .center, spacing: FB.Spacing.s2) {
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
                Spacer()
                HelpIcon(
                    title: "Where to get a recipe",
                    blurb: "Pairing with the Flagship phone app is the easy path. This screen is for a recipe someone sent you out of band — paste it or drop the JSON file here.",
                    url: FlagshipLinks.certificate
                )
            }
            .padding(.trailing, FB.Spacing.s1)
        }
        .padding(.bottom, FB.Spacing.s2)
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
                // Dim ONLY the picker when fetching the base ISO ourselves; the
                // checkbox below stays interactive so it can be turned back off.
                .opacity(model.useSystemISO ? 0.4 : 1)
                .disabled(model.useSystemISO)
            },
            leading: {
                FBCheck(isOn: $model.useSystemISO, label: "Use system-provided ISO")
                    .disabled(model.isRunning)
                    .help("Fetch the recommended base ISO automatically (like Simple mode) instead of supplying your own.")
            },
            help: HelpIcon(
                title: "Recommended distributions",
                blurb: "Advanced mode remasters a stock Ubuntu or Debian installer ISO you supply. See the list of distributions known to assemble and boot cleanly.",
                url: FlagshipLinks.recommendedDistros
            )
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
            help: HelpIcon(
                title: "How does it work?",
                blurb: "The chosen USB drive is formatted and written with a single-use boot image. Booting your box from it installs an encrypted, phone-unlocked server that registers itself automatically.",
                url: FlagshipLinks.bootingProcess
            )
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
                    .focused($wifiFocus, equals: .ssid)
                SecureField("Password", text: $model.wifiPassword)
                    .textFieldStyle(.roundedBorder)
                    .focused($wifiFocus, equals: .password)
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
            if let error = model.operationError, !model.isRunning {
                StatusCard(icon: "exclamationmark.triangle.fill",
                           tint: FB.Colors.warning,
                           title: "Couldn't build the server",
                           subtitle: error)
            }
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
                    // Show the exact base-ISO URL being fetched, directly under
                    // the bar, so the download is transparent to the user.
                    if let url = model.baseDownloadURL {
                        Text(url)
                            .font(FB.Font.mono())
                            .foregroundStyle(FB.Colors.textMuted)
                            .lineLimit(1)
                            .truncationMode(.middle)
                            .textSelection(.enabled)
                            .frame(maxWidth: 300)
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
                // Saving a prepared ISO is the "burn elsewhere" path —
                // remaster only, no USB.
                if model.recipe != nil && model.iso != nil {
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
            // The separator only rests here while the log is CLOSED. When it opens
            // the line slides up to the top of the log (see logOverlay), so no line
            // shows at the bottom over the log content.
            if !showLog {
                Divider()
            }
            HStack {
                // Caret in a high-contrast filled circle (dynamic light/dark) for
                // visibility — the ink circle + bg glyph invert with the appearance.
                Image(systemName: showLog ? "chevron.down" : "chevron.up")
                    .font(FB.Font.caption().weight(.bold))
                    .foregroundStyle(FB.Colors.bg)
                    .frame(width: 20, height: 20)
                    .background(Circle().fill(FB.Colors.ink))
                Text("Log")
                    .font(FB.Font.caption())
                    .foregroundStyle(FB.Colors.textMuted)
                if !model.logLines.isEmpty {
                    Text("\(model.logLines.count)")
                        .font(FB.Font.caption().monospacedDigit())
                        .foregroundStyle(FB.Colors.textMuted)
                }
                Spacer()
                // Clear moved into the log overlay (only visible while the log is
                // on screen, above the resting separator's position).
            }
            .contentShape(Rectangle())
            .onTapGesture {
                // Resign the field before the overlay animates in so no focus
                // ring is mid-transition when the log slides up.
                wifiFocus = nil
                withAnimation(.easeOut(duration: 0.22)) { showLog.toggle() }
            }
            .pointerCursor()
            .padding(.horizontal, FB.Spacing.s5)
            .padding(.vertical, FB.Spacing.s2)
        }
        .background(FB.Colors.bg)
    }

    /// The log itself — slides up over the panes (it does not push them)
    /// and fills the available area so the whole scroll is reachable.
    private var logOverlay: some View {
        VStack(spacing: 0) {
            // The separator, slid up to the top of the UI while the log is open —
            // it rides the overlay's move-from-bottom transition, then slides back
            // down to the log bar's resting position on close.
            Divider()
            HStack {
                Spacer()
                // Clear now lives with the log — above where the resting separator
                // sits — and only while the log is on screen.
                if !model.logLines.isEmpty && !model.isRunning {
                    Button("Clear") { model.clearLog() }
                        .buttonStyle(.link)
                        .font(FB.Font.caption())
                        .pointerCursor()
                }
            }
            .frame(height: 16)
            .padding(.horizontal, FB.Spacing.s5)
            .padding(.vertical, FB.Spacing.s2)
            LogPane(model: model)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
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

// MARK: - Mode pill

/// On-brand rounded "pill" segmented toggle for Simple vs Advanced. A filled
/// teal capsule slides under the selected segment; the selected label reads in
/// white, the unselected one in muted ink. Replaces the plain `.segmented`
/// Picker — same two modes, same binding, purely a visual upgrade.
/// A small labeled checkbox matching the app's aesthetic: a rounded square that
/// fills with `tint` + a checkmark when on, a hairline-bordered empty square when
/// off. The whole row is the hit target.
private struct FBCheck: View {
    @Binding var isOn: Bool
    let label: String
    var tint: Color = FB.Colors.primary

    var body: some View {
        Button { isOn.toggle() } label: {
            HStack(spacing: FB.Spacing.s2) {
                ZStack {
                    RoundedRectangle(cornerRadius: 5, style: .continuous)
                        .fill(isOn ? tint : FB.Colors.surface)
                    RoundedRectangle(cornerRadius: 5, style: .continuous)
                        .strokeBorder(isOn ? tint : FB.Colors.border, lineWidth: 1.5)
                    if isOn {
                        Image(systemName: "checkmark")
                            .font(.system(size: 10, weight: .bold))
                            .foregroundStyle(.white)
                    }
                }
                .frame(width: 18, height: 18)
                Text(label)
                    .font(FB.Font.rowHint())
                    .foregroundStyle(isOn ? FB.Colors.ink : FB.Colors.textMuted)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .pointerCursor()
        .animation(.easeOut(duration: 0.12), value: isOn)
    }
}

private struct ModePill: View {
    @Binding var selection: BuilderMode
    @Namespace private var pill

    var body: some View {
        HStack(spacing: 0) {
            ForEach(BuilderMode.allCases, id: \.self) { mode in
                segment(mode)
            }
        }
        .padding(3)
        .background(
            Capsule(style: .continuous)
                .fill(FB.Colors.surfaceSunken)
        )
        .overlay(
            Capsule(style: .continuous)
                .strokeBorder(FB.Colors.border, lineWidth: 1)
        )
        .frame(width: 240)
    }

    private func segment(_ mode: BuilderMode) -> some View {
        let isSelected = selection == mode
        return Text(mode.menuLabel)
            .font(FB.Font.rowTitle())
            .foregroundStyle(isSelected ? Color.white : FB.Colors.textMuted)
            .frame(maxWidth: .infinity)
            .padding(.vertical, FB.Spacing.s1 + 2)
            .background(
                ZStack {
                    if isSelected {
                        Capsule(style: .continuous)
                            .fill(FB.Colors.primary)
                            .matchedGeometryEffect(id: "selectedSegment", in: pill)
                    }
                }
            )
            .contentShape(Capsule(style: .continuous))
            .onTapGesture {
                withAnimation(.spring(response: 0.28, dampingFraction: 0.82)) {
                    selection = mode
                }
            }
            .pointerCursor()
    }
}

// MARK: - Help icon

/// A small circular, brand-filled help button with a white question-mark
/// glyph. Tapping it shows the same explainer the old text link led to in a
/// popover — short copy plus a "Learn more" that opens the original URL.
private struct HelpIcon: View {
    let title: String
    let blurb: String
    let url: URL

    @State private var showPopover = false
    @State private var isHovering = false

    var body: some View {
        Button {
            showPopover.toggle()
        } label: {
            Image(systemName: "questionmark.circle.fill")
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(FB.Colors.primary)
                .opacity(isHovering ? 0.8 : 1)
        }
        .buttonStyle(.plain)
        .pointerCursor()
        .onHover { isHovering = $0 }
        .help(title)
        .popover(isPresented: $showPopover, arrowEdge: .bottom) {
            VStack(alignment: .leading, spacing: FB.Spacing.s2) {
                Text(title)
                    .font(FB.Font.rowTitle())
                    .foregroundStyle(FB.Colors.ink)
                Text(blurb)
                    .font(FB.Font.rowHint())
                    .foregroundStyle(FB.Colors.textMuted)
                    .fixedSize(horizontal: false, vertical: true)
                Button("Learn more →") {
                    NSWorkspace.shared.open(url)
                    showPopover = false
                }
                .buttonStyle(.link)
                .font(FB.Font.caption())
                .pointerCursor()
            }
            .padding(FB.Spacing.s4)
            .frame(width: 260)
        }
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
