import SwiftUI
import FlagshipAPI
import FlagshipCore

/// C3 — minimal SwiftUI surface over `NfcPairViewModel`. Renders one
/// of five visual states matching the view model's `Phase` cases. Not
/// yet wired into the main onboarding flow; reachable via DeveloperScreen
/// for hardware testing.
public struct NfcPairScreen: View {
    @Environment(\.colorScheme) private var scheme
    @Bindable var vm: NfcPairViewModel
    /// In-progress glance the user is assembling (3 taps → one glance).
    @State private var workingGlance: [Character] = []

    public init(vm: NfcPairViewModel) {
        self.vm = vm
    }

    public var body: some View {
        let c = FSColors.scheme(scheme)
        ScrollView {
            VStack(alignment: .leading, spacing: FS.space.s4) {
                Text("Pair a Flagship box").font(FS.font.h2()).foregroundColor(c.text)

                switch vm.phase {
                case .idle:
                    idleView(c: c)
                case .readingTag:
                    busyView(c: c, message: "Hold your phone to the box…")
                case .askingForWifi(let confirmation):
                    wifiFormView(c: c, confirmation: confirmation)
                case .sealing:
                    busyView(c: c, message: "Sealing your Wi-Fi for the box…")
                case .depositing:
                    busyView(c: c, message: "Sending it to the box…")
                case .success(let message):
                    successView(c: c, message: message)
                case .failure(let message, let fallbackAvailable):
                    failureView(c: c, message: message, fallbackAvailable: fallbackAvailable)
                case .ledSasFallback:
                    ledSasFallbackView(c: c)
                }
            }
            .padding(FS.space.s6)
        }
        .background(c.bg.ignoresSafeArea())
        .navigationTitle("NFC pair")
        .navigationBarTitleDisplayMode(.inline)
    }

    @ViewBuilder
    private func idleView(c: FSColors) -> some View {
        FSCard {
            VStack(alignment: .leading, spacing: FS.space.s3) {
                Text("Make sure your box is plugged in but UNPAIRED. The status LED should be slowly pulsing.")
                    .font(FS.font.bodySm()).foregroundColor(c.textMuted)
                Text("Tap your phone to the box's tag area (usually a sticker on the top or side) and hold for ~2 seconds.")
                    .font(FS.font.bodySm()).foregroundColor(c.textMuted)
            }
        }
        FSPrimaryButton("Tap your box", block: true, large: true) {
            Task { await vm.startTap() }
        }
    }

    @ViewBuilder
    private func busyView(c: FSColors, message: String) -> some View {
        FSCard {
            HStack(spacing: FS.space.s3) {
                ProgressView().tint(c.primary)
                Text(message).font(FS.font.body()).foregroundColor(c.text)
            }
        }
    }

    private func ledColor(_ symbol: Character) -> Color {
        switch symbol {
        case "R": return .red
        case "G": return .green
        case "B": return .blue
        default:  return .yellow
        }
    }

    @ViewBuilder
    private func wifiFormView(c: FSColors, confirmation: NfcPairViewModel.PairConfirmation) -> some View {
        FSCard {
            VStack(alignment: .leading, spacing: FS.space.s2) {
                Text("Paired with").font(FS.font.caption()).foregroundColor(c.textMuted)
                Text(confirmation.boxLabel).font(FS.font.mono()).foregroundColor(c.text)
                Text("Box ID \(confirmation.suffix6)")
                    .font(FS.font.caption()).foregroundColor(c.textMuted)
                Text("Send your Wi-Fi within 30 seconds of the tap — after that the box rolls a fresh pairing session.")
                    .font(FS.font.caption()).foregroundColor(c.textMuted)
            }
        }
        if !confirmation.sasLed.isEmpty {
            ledSasCaptureCard(c: c, confirmation: confirmation)
        }
        FSField(
            value: $vm.ssid,
            label: "Wi-Fi network (SSID)",
            placeholder: "e.g. My Home Wi-Fi"
        )
        FSField(
            value: $vm.psk,
            label: "Wi-Fi password",
            placeholder: "Network password",
            secure: true
        )
        FSCard {
            VStack(alignment: .leading, spacing: FS.space.s2) {
                Text("Regulatory region").font(FS.font.caption()).foregroundColor(c.text)
                Picker("Region", selection: $vm.regulatoryRegion) {
                    Text("United States (US)").tag("US")
                    Text("European Union (DE)").tag("DE")
                    Text("United Kingdom (GB)").tag("GB")
                    Text("Japan (JP)").tag("JP")
                    Text("Canada (CA)").tag("CA")
                    Text("Australia (AU)").tag("AU")
                }
                .pickerStyle(.menu)
                Text("Tells the box which Wi-Fi channels are legal where it'll live.")
                    .font(FS.font.caption()).foregroundColor(c.textMuted)
            }
        }
        FSPrimaryButton(
            "Send to box",
            enabled: !vm.ssid.isEmpty,
            block: true,
            large: true
        ) {
            Task { await vm.sendSealedWifi() }
        }
        FSGhostButton("Cancel", block: true) {
            vm.reset()
        }
    }

    /// N-PHONE-6 — the active "optional SAS glance". Shows the expected
    /// LED pattern and lets the user record what the box actually blinked,
    /// one glance at a time, then renders the strict 3-of-3 verdict.
    @ViewBuilder
    private func ledSasCaptureCard(c: FSColors, confirmation: NfcPairViewModel.PairConfirmation) -> some View {
        FSCard {
            VStack(alignment: .leading, spacing: FS.space.s3) {
                HStack {
                    Text("Check the box's LED")
                        .font(FS.font.caption()).foregroundColor(c.text)
                    Spacer()
                    Text(confirmation.sasDisplay)
                        .font(FS.font.mono()).foregroundColor(c.textMuted)
                }
                Text("The box's status LED blinks this 3-by-3 pattern. Optional, but it catches a wrong box in a crowded room.")
                    .font(FS.font.caption()).foregroundColor(c.textMuted)

                // The full expected pattern, grouped into 3 glances.
                HStack(spacing: FS.space.s3) {
                    ForEach(0..<3, id: \.self) { g in
                        HStack(spacing: FS.space.s1) {
                            ForEach(Array(glance(confirmation.sasLed, g).enumerated()), id: \.offset) { _, sym in
                                Circle().fill(ledColor(sym)).frame(width: 12, height: 12)
                            }
                        }
                    }
                    Spacer()
                }

                if let capture = vm.ledCapture {
                    ledCaptureProgress(c: c, capture: capture)
                } else {
                    FSGhostButton("Verify the LED pattern", block: true) {
                        vm.beginLedSasCapture()
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func ledCaptureProgress(
        c: FSColors,
        capture: NfcPairViewModel.LedSasCapture
    ) -> some View {
        switch capture.verdict {
        case .confirmed:
            HStack(spacing: FS.space.s2) {
                Image(systemName: "checkmark.seal.fill").foregroundColor(.green)
                Text("LED pattern matched — this is your box.")
                    .font(FS.font.bodySm()).foregroundColor(c.text)
            }
        case .mismatch:
            VStack(alignment: .leading, spacing: FS.space.s2) {
                HStack(spacing: FS.space.s2) {
                    Image(systemName: "xmark.octagon.fill").foregroundColor(c.danger)
                    Text("That didn't match. Don't send Wi-Fi — you may be looking at the wrong box.")
                        .font(FS.font.bodySm()).foregroundColor(c.text)
                }
                FSGhostButton("Try the LED check again", block: true) {
                    vm.resetLedSasCapture()
                }
            }
        case .pending:
            if let g = capture.currentGlance {
                VStack(alignment: .leading, spacing: FS.space.s2) {
                    Text("Glance \(g + 1) of 3 — tap the 3 colors the LED just blinked:")
                        .font(FS.font.caption()).foregroundColor(c.textMuted)
                    // One row per pulse-color; the user assembles a glance
                    // by tapping 3 colors. We collect into a working buffer
                    // shown as chips, then submit when 3 are chosen.
                    glancePicker(c: c)
                }
            } else {
                ProgressView().tint(c.primary)
            }
        }
    }

    /// A simple 4-color tap pad that records one full glance (3 pulses)
    /// then submits it. State for the in-progress glance lives in the
    /// screen; completed glances live in the view model's capture.
    @ViewBuilder
    private func glancePicker(c: FSColors) -> some View {
        VStack(alignment: .leading, spacing: FS.space.s2) {
            HStack(spacing: FS.space.s2) {
                ForEach(Array(workingGlance.enumerated()), id: \.offset) { _, sym in
                    Circle().fill(ledColor(sym)).frame(width: 16, height: 16)
                }
                if workingGlance.count < 3 {
                    ForEach(0..<(3 - workingGlance.count), id: \.self) { _ in
                        Circle().strokeBorder(c.textMuted, lineWidth: 1).frame(width: 16, height: 16)
                    }
                }
                Spacer()
            }
            HStack(spacing: FS.space.s2) {
                ForEach(["R", "G", "B", "Y"], id: \.self) { sym in
                    Button {
                        if workingGlance.count < 3 {
                            workingGlance.append(Character(sym))
                            if workingGlance.count == 3 {
                                vm.recordLedGlance(String(workingGlance))
                                workingGlance = []
                            }
                        }
                    } label: {
                        Circle()
                            .fill(ledColor(Character(sym)))
                            .frame(width: 32, height: 32)
                            .overlay(Circle().strokeBorder(c.text.opacity(0.2), lineWidth: 1))
                    }
                    .buttonStyle(.plain)
                }
                Spacer()
            }
        }
    }

    /// The first `LED_SAS_PULSES_PER_GLANCE` symbols of glance `g`.
    private func glance(_ seq: String, _ g: Int) -> [Character] {
        let chars = Array(seq)
        let lo = g * 3
        guard lo + 3 <= chars.count else { return [] }
        return Array(chars[lo..<(lo + 3)])
    }

    @ViewBuilder
    private func successView(c: FSColors, message: String) -> some View {
        FSCard {
            HStack(spacing: FS.space.s3) {
                Image(systemName: "checkmark.circle.fill")
                    .foregroundColor(.green)
                    .font(.system(size: 24))
                Text(message).font(FS.font.body()).foregroundColor(c.text)
            }
        }
        FSSecondaryButton("Pair another box", block: true) {
            vm.reset()
        }
    }

    @ViewBuilder
    private func failureView(c: FSColors, message: String, fallbackAvailable: Bool) -> some View {
        FSCard {
            HStack(spacing: FS.space.s3) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .foregroundColor(c.danger)
                    .font(.system(size: 22))
                Text(message).font(FS.font.body()).foregroundColor(c.text)
            }
        }
        FSPrimaryButton("Try again", block: true, large: true) {
            vm.reset()
        }
        if fallbackAvailable {
            FSSecondaryButton("Pair using the box's LED instead", block: true) {
                vm.startLedSasFallback()
            }
        }
    }

    /// Q2 fallback seam — the LED capture + decode flow (N-PHONE-6)
    /// mounts here. Until it lands this view explains the degrade path
    /// and routes back to the tap or the DIY monitor+QR path.
    @ViewBuilder
    private func ledSasFallbackView(c: FSColors) -> some View {
        FSCard {
            VStack(alignment: .leading, spacing: FS.space.s3) {
                Text("Pair with the box's LED").font(FS.font.h3()).foregroundColor(c.text)
                Text("Your phone finishes pairing over Wi-Fi and confirms the box by its status-LED blink pattern.")
                    .font(FS.font.bodySm()).foregroundColor(c.textMuted)
                Text("LED pairing isn't available in this build yet. You can retry the tap, or plug a monitor into the box and pair with the on-screen QR code.")
                    .font(FS.font.bodySm()).foregroundColor(c.textMuted)
            }
        }
        FSPrimaryButton("Try the tap again", block: true, large: true) {
            vm.reset()
        }
    }
}
