import SwiftUI
import Flagship
import FlagshipCore

/// Phone-side v2 create-server flow.
///
/// Phase layout: design → scan/paste → match → minting/delivering →
/// delivered. The delivered card doubles as the placeholder detail
/// page for the pending pod — the user can tap it from the device
/// list and see the same content (with a Cancel order button).
public struct CreateServerStubScreen: View {
    @Environment(\.colorScheme) private var scheme
    @Bindable var vm: CreateServerViewModel
    var onDelivered: (_ serverDomain: String, _ name: String, _ description: String) -> Void = { _, _, _ in }
    var onDemoComplete: (_ name: String, _ description: String) -> Void = { _, _ in }
    var onCancel: () -> Void = {}

    public init(
        vm: CreateServerViewModel,
        onDelivered: @escaping (_ serverDomain: String, _ name: String, _ description: String) -> Void = { _, _, _ in },
        onDemoComplete: @escaping (_ name: String, _ description: String) -> Void = { _, _ in },
        onCancel: @escaping () -> Void = {}
    ) {
        self.vm = vm
        self.onDelivered = onDelivered
        self.onDemoComplete = onDemoComplete
        self.onCancel = onCancel
    }

    public var body: some View {
        let c = FSColors.scheme(scheme)
        ScrollView {
            VStack(alignment: .leading, spacing: FS.space.s6) {
                Spacer().frame(height: FS.space.s8)
                switch vm.phase {
                case .design:                designPage(c: c)
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
    }

    // MARK: - Phase 1: Design

    private func designPage(c: FSColors) -> some View {
        VStack(alignment: .leading, spacing: FS.space.s4) {
            phaseHeader("Design your server", subtitle: "Pick a short name + a one-line description. You'll see this everywhere the FQDN used to live.", c: c)

            FSCard {
                VStack(alignment: .leading, spacing: FS.space.s3) {
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
                    bootUnlockPicker(c: c)
                }
            }

            FSPrimaryButton("Continue", enabled: vm.canAdvanceFromDesign, block: true, large: true) {
                vm.continueToScan()
            }
            .accessibilityIdentifier("cs-continue-button")

            if vm.canAdvanceFromDesign {
                FSGhostButton(
                    "Skip — pretend it's already running",
                    block: true
                ) {
                    onDemoComplete(vm.name, vm.description)
                }
                .accessibilityIdentifier("cs-skip-button")
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
                    Text("Status: pending — the server hasn't phoned home yet.")
                        .font(FS.font.caption())
                        .foregroundColor(c.textMuted)
                }
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
