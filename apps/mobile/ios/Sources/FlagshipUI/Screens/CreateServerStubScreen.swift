import SwiftUI
import UIKit
import Flagship
import FlagshipAPI
import FlagshipCore

/// Phone-side v2 create-server flow.
///
/// Phase layout: design → scan/paste → match → minting/delivering →
/// delivered. The delivered card doubles as the placeholder detail
/// page for the pending pod — the user can tap it from the device
/// list and see the same content (with a Cancel order button).
public struct CreateServerStubScreen: View {
    @Environment(\.colorScheme) private var scheme
    @Environment(DeveloperSettings.self) private var dev
    @Environment(\.flagshipServerClient) private var server
    @Bindable var vm: CreateServerViewModel
    /// Which sub-step of the design phase is showing. The long single-scroll
    /// form is split into one decision per page: 0 identity, 1 boot unlock,
    /// 2 backups.
    @State private var designStep = 0
    private let designStepCount = 3
    /// Live install ladder on the delivered page, polling the per-order
    /// status with the just-minted serial — the page used to show a
    /// hardcoded "Status: pending" that never moved.
    @State private var deliveredTimeline: ProvisionTimelineViewModel?
    // Delivery-chooser state.
    @State private var pairVM: BurnerPairViewModel?
    @State private var showPair = false
    @State private var shareURL: URL?
    @State private var showShare = false
    @State private var deliveryBusy = false
    @State private var copiedToast = false
    /// Fires the moment the delivered page APPEARS (vs `onDelivered`,
    /// which waits for the "Done" tap) so the host can surface the new
    /// pending pod on the Home list immediately.
    var onDeliveredVisible: (_ serverDomain: String, _ name: String, _ description: String) -> Void = { _, _, _ in }
    var onDelivered: (_ serverDomain: String, _ name: String, _ description: String) -> Void = { _, _, _ in }
    var onCancel: () -> Void = {}

    public init(
        vm: CreateServerViewModel,
        onDeliveredVisible: @escaping (_ serverDomain: String, _ name: String, _ description: String) -> Void = { _, _, _ in },
        onDelivered: @escaping (_ serverDomain: String, _ name: String, _ description: String) -> Void = { _, _, _ in },
        onCancel: @escaping () -> Void = {}
    ) {
        self.vm = vm
        self.onDeliveredVisible = onDeliveredVisible
        self.onDelivered = onDelivered
        self.onCancel = onCancel
    }

    public var body: some View {
        let c = FSColors.scheme(scheme)
        ScrollView {
            VStack(alignment: .leading, spacing: FS.space.s6) {
                Spacer().frame(height: FS.space.s8)
                switch vm.phase {
                case .design:                designPage(c: c)
                case .deliveryChooser:       deliveryChooserPage(c: c)
                case .scanQr:                scanPage(c: c)
                case .pasteQr:               pastePage(c: c)
                case .connecting:
                    phaseHeader("Connecting", subtitle: "Opening the secure channel…", c: c)
                    spinnerCard(c: c)
                case .matching(let code, let gate):
                    matchPage(code: code, gateOpen: gate, c: c)
                case .minting:
                    phaseHeader("Almost there", subtitle: "Minting the install blob…", c: c)
                    spinnerCard(c: c)
                case .delivering:
                    phaseHeader("Delivering", subtitle: "Pushing your boot recipe to the desktop…", c: c)
                    spinnerCard(c: c)
                case .delivered(let serial, let serverDomain):
                    deliveredPage(serial: serial, serverDomain: serverDomain, c: c)
                case .failed(let msg):
                    failurePage(msg: msg, c: c)
                }
                Spacer().frame(height: FS.space.s12)
            }
            .padding(.horizontal, FS.space.s6)
        }
        .background(c.bg.ignoresSafeArea())
        .sheet(isPresented: $showPair) {
            if let pairVM {
                NavigationStack {
                    BurnerPairScreen(
                        vm: pairVM,
                        onDelivered: { domain, serial in
                            showPair = false
                            vm.lastDeliveredSerial = serial
                            vm.phase = .delivered(serial: serial, serverDomain: domain)
                        },
                        onCancel: { showPair = false }
                    )
                    .navigationTitle("Pair with burner")
                    .navigationBarTitleDisplayMode(.inline)
                }
            }
        }
        .sheet(isPresented: $showShare) {
            if let shareURL { ShareSheet(items: [shareURL]) }
        }
    }

    // MARK: - Delivery chooser

    private func deliveryChooserPage(c: FSColors) -> some View {
        VStack(alignment: .leading, spacing: FS.space.s4) {
            phaseHeader("Get it to a burner", subtitle: "Your recipe is ready. Pick how to send it to the Flagship burner that writes your USB stick.", c: c)

            Button { startPair() } label: {
                deliveryCard(icon: "qrcode.viewfinder", accent: c.primary,
                             title: "Pair with the burner app",
                             body: "Scan the burner's QR (or type its code) and the recipe is sent over a secure live link. Easiest if the burner is open in front of you.",
                             c: c)
            }
            .buttonStyle(.plain)
            .disabled(deliveryBusy)

            Button { Task { await shareRecipe() } } label: {
                deliveryCard(icon: "square.and.arrow.up", accent: c.text,
                             title: "Save / share recipe file",
                             body: "Save the recipe as a file or send it (AirDrop, Messages, Mail). Whoever builds the box opens it in the burner. No secrets in the file.",
                             c: c)
            }
            .buttonStyle(.plain)
            .disabled(deliveryBusy)

            Button { Task { await copyRecipe() } } label: {
                deliveryCard(icon: "doc.on.clipboard", accent: c.text,
                             title: copiedToast ? "Copied!" : "Copy recipe to clipboard",
                             body: "Copy the recipe text, then paste it into the burner's “I have a recipe” box.",
                             c: c)
            }
            .buttonStyle(.plain)
            .disabled(deliveryBusy)

            // MOCK mode only: drive the whole create flow end-to-end with no
            // desktop/burner via the legacy demo-QR relay path. Keeps the
            // mock onboarding smoke test exercising a real mint+deliver.
            if !dev.useLiveClient {
                FSGhostButton("Use a demo QR (mock)", block: true) {
                    Task { await vm.qrDetected(QrRelay.makeDemoQrUrl()) }
                }
                .accessibilityIdentifier("cs-demo-qr-button")
            }

            if deliveryBusy { spinnerCard(c: c) }
        }
    }

    private func deliveryCard(icon: String, accent: Color, title: String, body: String, c: FSColors) -> some View {
        FSCard(padding: FS.space.s6) {
            VStack(alignment: .leading, spacing: FS.space.s3) {
                ZStack {
                    RoundedRectangle(cornerRadius: FS.radius.sm).fill(accent.opacity(0.12))
                    Image(systemName: icon).foregroundColor(accent).font(.system(size: 22, weight: .semibold))
                }
                .frame(width: 44, height: 44)
                Text(title).font(FS.font.h3()).foregroundColor(c.text)
                Text(body).font(FS.font.body()).foregroundColor(c.textMuted)
            }
        }
    }

    private func startPair() {
        let vmPair = BurnerPairViewModel(client: LiveBurnerPairClient(), minter: vm)
        pairVM = vmPair
        showPair = true
    }

    private func shareRecipe() async {
        guard !deliveryBusy else { return }
        deliveryBusy = true
        defer { deliveryBusy = false }
        do {
            let minted = try await vm.mintRecipeJSON()
            let dir = URL(fileURLWithPath: NSTemporaryDirectory())
            let url = dir.appendingPathComponent("\(SlugUtil.slugify(vm.name)).flagship-recipe.json")
            try minted.json.data(using: .utf8)?.write(to: url, options: [.atomic])
            shareURL = url
            showShare = true
            // The recipe is out — surface the pending pod via the delivered page.
            vm.phase = .delivered(serial: minted.serial, serverDomain: minted.serverDomain)
        } catch {
            vm.phase = .failed(error.localizedDescription)
        }
    }

    private func copyRecipe() async {
        guard !deliveryBusy else { return }
        deliveryBusy = true
        defer { deliveryBusy = false }
        do {
            let minted = try await vm.mintRecipeJSON()
            UIPasteboard.general.string = minted.json
            copiedToast = true
            vm.phase = .delivered(serial: minted.serial, serverDomain: minted.serverDomain)
        } catch {
            vm.phase = .failed(error.localizedDescription)
        }
    }

    // MARK: - Phase 1: Design

    private func designPage(c: FSColors) -> some View {
        let (title, subtitle) = designStepHeader(designStep)
        return VStack(alignment: .leading, spacing: FS.space.s4) {
            phaseHeader(title, subtitle: subtitle, c: c)
            Text("Step \(designStep + 1) of \(designStepCount)")
                .font(.caption.monospacedDigit())
                .foregroundStyle(c.textMuted)

            FSCard {
                VStack(alignment: .leading, spacing: FS.space.s3) {
                    switch designStep {
                    case 0:
                        FSField(value: $vm.name, label: "Short name", placeholder: "Home, Office, Garage")
                            .accessibilityIdentifier("cs-name-field")
                        FSField(
                            value: $vm.description,
                            label: "One-line description",
                            placeholder: "Failover for work · Music projects",
                            helper: "Up to ~40 characters."
                        )
                        .accessibilityIdentifier("cs-description-field")
                        recipeTtlPicker(c: c)
                    case 1:
                        bootUnlockPicker(c: c)
                        Divider().background(c.border)
                        diskEncryptionToggle(c: c)
                        Divider().background(c.border)
                        advancedSection(c: c)
                    default:
                        backupPolicyPicker(c: c)
                    }
                }
            }

            designNav(c: c)
        }
    }

    /// Per-step title + subtitle for the design wizard.
    private func designStepHeader(_ step: Int) -> (String, String) {
        switch step {
        case 0:  return ("Name your server", "A short name + one-line description. You'll see this everywhere the FQDN used to live.")
        case 1:  return ("Boot unlock", "How this box comes back online after a reboot.")
        default: return ("Backups", "How this server's data is protected.")
        }
    }

    /// Back / Next (or Continue on the last step). Step 0 gates Next behind a
    /// non-empty name; every other step is free to advance.
    @ViewBuilder
    private func designNav(c: FSColors) -> some View {
        VStack(spacing: FS.space.s2) {
            if designStep < designStepCount - 1 {
                FSPrimaryButton(
                    "Next",
                    enabled: designStep != 0 || vm.canAdvanceFromDesign,
                    block: true,
                    large: true
                ) {
                    designStep += 1
                }
                .accessibilityIdentifier("cs-next-button")
            } else {
                FSPrimaryButton("Continue", enabled: vm.canAdvanceFromDesign, block: true, large: true) {
                    vm.proceedToDelivery()
                }
                .accessibilityIdentifier("cs-continue-button")
            }
            if designStep > 0 {
                FSGhostButton("Back", block: true) { designStep -= 1 }
                    .accessibilityIdentifier("cs-back-button")
            }
        }
    }

    // MARK: - Recipe TTL picker
    //
    // The recipe TTL gates how long the freshly-burned USB can sit
    // before booting + registering. Once the daemon registers it
    // doesn't matter — but a stolen/lost recipe is bounded by this
    // window. Default 6 hours; 5 min floor, 24 hour ceiling.
    private func recipeTtlPicker(c: FSColors) -> some View {
        let hoursDouble = Double(vm.recipeTtlMs) / 3_600_000.0
        return VStack(alignment: .leading, spacing: FS.space.s2) {
            HStack {
                Text("Recipe expires in")
                    .font(.subheadline)
                    .foregroundStyle(c.text)
                Spacer()
                Text(ttlLabel(hoursDouble))
                    .font(.subheadline.monospacedDigit())
                    .foregroundStyle(c.text)
                    .accessibilityIdentifier("cs-ttl-label")
            }
            Slider(
                value: Binding(
                    get: { hoursDouble },
                    set: { vm.setRecipeTtlHours($0) }
                ),
                in: 0.5...24,
                step: 0.5
            )
            .accessibilityIdentifier("cs-ttl-slider")
            Text("After this window, the unused USB can't install — re-mint from this screen.")
                .font(.caption)
                .foregroundStyle(c.textMuted)
        }
    }

    private func ttlLabel(_ hours: Double) -> String {
        if hours < 1 {
            return "\(Int(round(hours * 60))) min"
        }
        if hours == floor(hours) {
            return "\(Int(hours)) hour\(hours == 1 ? "" : "s")"
        }
        return String(format: "%.1f hours", hours)
    }

    // MARK: - Boot-unlock policy picker
    //
    // Two tiers, no middle ground (the design decision in
    // docs/security-phone-as-unlock-endpoint.md §7a.1). "auto" is the
    // default — a box that reboots without the phone, with a remote kill
    // switch. "approve" gates every boot behind the phone (theft-resistant,
    // assumes stable infrastructure).
    private func bootUnlockPicker(c: FSColors) -> some View {
        VStack(alignment: .leading, spacing: FS.space.s2) {
            Text("Boot unlock")
                .font(.subheadline)
                .foregroundStyle(c.text)
            bootUnlockOption(
                mode: .auto,
                title: "Reboots on its own",
                subtitle: "Best for flaky power or connections. After you approve its first boot, the box self-unlocks on every reboot — no phone needed. Revocable any time.",
                c: c
            )
            bootUnlockOption(
                mode: .approve,
                title: "Authorize each boot",
                subtitle: "Most theft-resistant. The box asks your phone (Face ID) on every reboot. Best for critical servers on stable infrastructure.",
                c: c
            )
        }
    }

    private func bootUnlockOption(
        mode: BootUnlockStore.Mode,
        title: String,
        subtitle: String,
        c: FSColors
    ) -> some View {
        let selected = vm.bootUnlockMode == mode
        return Button {
            vm.bootUnlockMode = mode
        } label: {
            HStack(alignment: .top, spacing: FS.space.s3) {
                Image(systemName: selected ? "largecircle.fill.circle" : "circle")
                    .foregroundColor(selected ? c.primary : c.textMuted)
                    .padding(.top, 2)
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).font(.subheadline.weight(.medium)).foregroundColor(c.text)
                    Text(subtitle).font(.caption).foregroundColor(c.textMuted)
                }
                Spacer(minLength: 0)
            }
            .padding(FS.space.s3)
            .background(
                RoundedRectangle(cornerRadius: FS.radius.md)
                    .stroke(selected ? c.primary : c.border, lineWidth: selected ? 2 : 1)
            )
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("cs-bootunlock-\(mode.rawValue)")
    }

    // MARK: - Disk-encryption toggle
    //
    // Default ON (LUKS-encrypt the data disk; the box fetches its unlock key at
    // boot). OFF = "none": plaintext disk — less safe, but the only option for a
    // box that can't keep network at boot (e.g. Wi-Fi-only, where the boot-time
    // unlock-key fetch can't run). Carried in the SIGNED InstallBlob via the
    // trailing `de=none` (encrypted stays absent ⇒ legacy bytes).
    private func diskEncryptionToggle(c: FSColors) -> some View {
        VStack(alignment: .leading, spacing: FS.space.s2) {
            Toggle(isOn: $vm.encryptDisk) {
                Text("Encrypt disk")
                    .font(.subheadline.weight(.medium))
                    .foregroundColor(c.text)
            }
            .tint(c.primary)
            .accessibilityIdentifier("cs-encrypt-disk-toggle")
            Text(vm.encryptDisk
                 ? "Recommended. Your data disk is LUKS-encrypted; the box unlocks it at boot."
                 : "Less safe — the disk is left unencrypted. Only for boxes that can't keep network at boot (e.g. Wi-Fi-only), where the boot-time unlock can't run.")
                .font(.caption)
                .foregroundColor(c.textMuted)
        }
    }

    // MARK: - Advanced mode
    //
    // ONE toggle, OFF by default, "for people who know what they're doing".
    // It gates the offline path: embed-secrets (the box SWK in the recipe), so a
    // box can install fully offline with no post-registration phone step. The
    // DEFAULT (Advanced off) is the secret-free recipe — the phone deposits the
    // SWK after the box registers. (Choose-your-own-ISO + debug/local-CLI have no
    // mobile analogue; they live on the website/webapp.)
    @ViewBuilder
    private func advancedSection(c: FSColors) -> some View {
        VStack(alignment: .leading, spacing: FS.space.s2) {
            Toggle(isOn: $vm.advancedMode) {
                VStack(alignment: .leading, spacing: 1) {
                    Text("Advanced mode")
                        .font(.subheadline.weight(.medium))
                        .foregroundColor(c.text)
                    Text("For people who know what they're doing.")
                        .font(.caption)
                        .foregroundColor(c.textMuted)
                }
            }
            .tint(c.primary)
            .accessibilityIdentifier("cs-advanced-toggle")

            if vm.advancedMode {
                Toggle(isOn: $vm.embedSecrets) {
                    Text("Embed secrets for offline install")
                        .font(.subheadline.weight(.medium))
                        .foregroundColor(c.text)
                }
                .tint(c.primary)
                .accessibilityIdentifier("cs-embed-secrets-toggle")
                .padding(.leading, FS.space.s3)
                Text(vm.embedSecrets
                     ? "The recipe carries the box's app key. The box installs fully offline — no later step on your phone — but the recipe now holds a secret. Keep it safe."
                     : "Off (recommended): the recipe holds no app key. Your phone delivers it securely once the box comes online.")
                    .font(.caption)
                    .foregroundColor(c.textMuted)
                    .padding(.leading, FS.space.s3)
            }
        }
    }

    // MARK: - Backup policy picker (draft-only metadata)
    //
    // Mirrors the webapp's `#cs-backup-policy` dropdown
    // (apps/web/public/webapp/views/create-server.js). NOT carried in the
    // signed InstallBlob — applied later via an owner-signed
    // `set-backup-policy` order. Three tiers, default "phone-only" matching
    // the webapp's `?? "phone-only"` default in buildDraft.js.
    private func backupPolicyPicker(c: FSColors) -> some View {
        VStack(alignment: .leading, spacing: FS.space.s2) {
            Text("Backup policy")
                .font(.subheadline)
                .foregroundStyle(c.text)
            backupPolicyOption(
                policy: .phoneOnly,
                title: "Phone-side backups",
                subtitle: "The default. Your phone pulls an encrypted backup of each app on a schedule. Restores need this device. Because the backup lives on your phone, your server's data can't grow larger than your phone's free space.",
                c: c
            )
            backupPolicyOption(
                policy: .peer,
                title: "Peer-distributed backups",
                subtitle: "Your encrypted shards are stored across other Flagship users (and theirs on you). Recoverable from any device with your account.",
                c: c
            )
            backupPolicyOption(
                policy: .none,
                title: "No backups",
                subtitle: "Power-user opt-out. If the box dies before you back up manually, the data is gone.",
                c: c
            )
        }
    }

    private func backupPolicyOption(
        policy: CreateServerDraftStore.BackupPolicy,
        title: String,
        subtitle: String,
        c: FSColors
    ) -> some View {
        let selected = vm.backupPolicy == policy
        return Button {
            vm.backupPolicy = policy
        } label: {
            HStack(alignment: .top, spacing: FS.space.s3) {
                Image(systemName: selected ? "largecircle.fill.circle" : "circle")
                    .foregroundColor(selected ? c.primary : c.textMuted)
                    .padding(.top, 2)
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).font(.subheadline.weight(.medium)).foregroundColor(c.text)
                    Text(subtitle).font(.caption).foregroundColor(c.textMuted)
                }
                Spacer(minLength: 0)
            }
            .padding(FS.space.s3)
            .background(
                RoundedRectangle(cornerRadius: FS.radius.md)
                    .stroke(selected ? c.primary : c.border, lineWidth: selected ? 2 : 1)
            )
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("cs-backup-policy-\(policy.rawValue)")
    }

    // MARK: - Phase 2: Scan

    private func scanPage(c: FSColors) -> some View {
        VStack(alignment: .leading, spacing: FS.space.s4) {
            phaseHeader(
                "Scan the QR",
                subtitle: "On your desktop, open flagshipserver.com. Aim the viewfinder at the QR on the homepage.",
                c: c
            )

            FSCard(padding: 0) {
                QRScannerView(
                    onScan: { code in Task { await vm.qrDetected(code) } },
                    onError: { _ in
                        // The scanner reticle flashes red + buzzes on
                        // a bad QR — no separate toast needed.
                    },
                    validate: { payload in
                        // Only accept QRs that parse cleanly as a v2
                        // relay URL. Anything else keeps the scanner
                        // live so the user can re-aim.
                        (try? QrRelay.parseQrUrl(payload)) != nil
                    }
                )
                .frame(height: 300)
                .clipShape(RoundedRectangle(cornerRadius: FS.radius.md))
            }
            .accessibilityIdentifier("cs-scanner-card")

            Button {
                vm.switchToPaste()
            } label: {
                Text("Copy the QR link instead?")
                    .font(FS.font.bodySm())
                    .underline()
                    .foregroundColor(c.primary)
                    .frame(maxWidth: .infinity, alignment: .center)
            }
            .accessibilityIdentifier("cs-paste-toggle")
            .padding(.top, FS.space.s2)

            // MOCK mode only: no desktop QR needed. Generate a valid demo QR
            // locally and run the REAL flow against the mock relay/server, so
            // the whole create-server UI is testable end-to-end without infra.
            // (Replaces the old "skip — pretend it's running" shortcut, which
            // faked an online server instead of exercising the real flow.)
            if !dev.useLiveClient {
                FSGhostButton("Use a demo QR (mock)", block: true) {
                    Task { await vm.qrDetected(QrRelay.makeDemoQrUrl()) }
                }
                .accessibilityIdentifier("cs-demo-qr-button")
            }

            FSGhostButton("Back", block: true) { vm.phase = .design }
        }
    }

    // MARK: - Phase 3: Paste

    private func pastePage(c: FSColors) -> some View {
        VStack(alignment: .leading, spacing: FS.space.s4) {
            phaseHeader(
                "Paste the QR link",
                subtitle: "Right-click (or long-press) the QR on flagshipserver.com, copy the link, and paste it here.",
                c: c
            )

            FSCard {
                FSField(
                    value: $vm.qrUrl,
                    label: "QR link",
                    placeholder: "https://flagshipserver.com/qr?s=…&k=…"
                )
                .accessibilityIdentifier("cs-qr-field")
            }

            FSPrimaryButton("Submit", enabled: vm.canSubmitPaste, block: true, large: true) {
                Task { await vm.submitPaste() }
            }
            .accessibilityIdentifier("cs-submit-button")

            FSGhostButton("Back to viewfinder", block: true) { vm.switchToScan() }
        }
    }

    // MARK: - Phase 5: Match

    private func matchPage(code: String, gateOpen: Bool, c: FSColors) -> some View {
        VStack(alignment: .leading, spacing: FS.space.s4) {
            phaseHeader(
                "Confirm match code",
                subtitle: "These six digits must match what the desktop shows. If they don't, someone is in the middle — cancel.",
                c: c
            )
            FSCard(padding: FS.space.s6) {
                Text(QrRelay.formatMatchCode(code))
                    .font(.system(size: 44, weight: .semibold, design: .monospaced))
                    .foregroundColor(c.text)
                    .tracking(6)
                    .frame(maxWidth: .infinity, alignment: .center)
                    .padding(.vertical, FS.space.s2)
                    .accessibilityIdentifier("cs-match-label")
            }
            FSPrimaryButton(
                gateOpen ? "Codes match — confirm" : "Reading…",
                enabled: gateOpen,
                block: true,
                large: true
            ) {
                Task { await vm.confirmAndDeliver() }
            }
            .accessibilityIdentifier("cs-confirm-button")
            FSGhostButton("Cancel", block: true) { Task { await vm.cancel() } }
        }
    }

    // MARK: - Phase 8: Delivered

    private func deliveredPage(serial: String, serverDomain: String, c: FSColors) -> some View {
        VStack(alignment: .leading, spacing: FS.space.s4) {
            phaseHeader(
                "Your boot disk is on the way",
                subtitle: "The desktop browser should have started downloading your personalized ISO. Flash it, boot any commodity machine, and the new server will phone home and finish setup automatically.",
                c: c
            )
            FSCard {
                VStack(alignment: .leading, spacing: FS.space.s3) {
                    HStack(spacing: FS.space.s2) {
                        Image(systemName: "arrow.down.circle.fill").foregroundColor(c.success)
                        Text("Delivered").font(FS.font.h4()).foregroundColor(c.text)
                    }
                    labeled("Server", serverDomain, mono: true, c: c)
                    labeled("Serial", serial, mono: true, c: c)
                    ProvisionTimelineView(status: deliveredTimeline?.status)
                        .padding(.top, FS.space.s1)
                }
            }
            .onAppear {
                onDeliveredVisible(serverDomain, vm.name, vm.description)
                deliveredTimeline?.stop()
                let timeline = ProvisionTimelineViewModel(serial: serial, server: server)
                deliveredTimeline = timeline
                timeline.start()
            }
            .onDisappear {
                deliveredTimeline?.stop()
                deliveredTimeline = nil
            }
            Link(destination: URL(string: "https://flagshipserver.com/docs/install")!) {
                HStack {
                    Image(systemName: "book.fill")
                    Text("How to flash + boot")
                }
                .font(.system(size: 15, weight: .semibold))
                .foregroundColor(c.primary)
                .frame(maxWidth: .infinity)
                .padding(.vertical, FS.space.s3)
            }
            FSPrimaryButton("Done", block: true, large: true) {
                onDelivered(serverDomain, vm.name, vm.description)
            }
            .accessibilityIdentifier("cs-done-button")
            FSDangerButton("Cancel order", block: true) {
                onCancel()
            }
            .accessibilityIdentifier("cs-cancel-order-button")
        }
    }

    // MARK: - Failure

    private func failurePage(msg: String, c: FSColors) -> some View {
        VStack(alignment: .leading, spacing: FS.space.s4) {
            phaseHeader("Something went wrong", subtitle: nil, c: c)
            ErrorCard(message: msg)
            FSGhostButton("Try again", block: true) { vm.resetToDesign() }
        }
    }

    // MARK: - Helpers

    @ViewBuilder
    private func phaseHeader(_ title: String, subtitle: String?, c: FSColors) -> some View {
        VStack(alignment: .leading, spacing: FS.space.s2) {
            Text(title).font(FS.font.h2()).foregroundColor(c.text)
            if let subtitle {
                Text(subtitle).font(FS.font.body()).foregroundColor(c.textMuted)
            }
        }
    }

    private func spinnerCard(c: FSColors) -> some View {
        FSCard(padding: FS.space.s8) {
            VStack(spacing: FS.space.s3) {
                ProgressView()
                Text("Hang on…").font(FS.font.bodySm()).foregroundColor(c.textMuted)
            }
            .frame(maxWidth: .infinity)
        }
    }

    private func labeled(_ label: String, _ value: String, mono: Bool = false, c: FSColors) -> some View {
        HStack(alignment: .top) {
            Text(label).font(FS.font.caption()).foregroundColor(c.textMuted)
            Spacer()
            Text(value)
                .font(mono ? FS.font.mono() : FS.font.body())
                .foregroundColor(c.text)
                .lineLimit(1)
                .truncationMode(.middle)
        }
    }
}
