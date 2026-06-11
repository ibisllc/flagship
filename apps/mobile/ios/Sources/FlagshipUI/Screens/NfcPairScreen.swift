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
            FSCard {
                VStack(alignment: .leading, spacing: FS.space.s2) {
                    Text("Optional check: the box's LED blinks this pattern")
                        .font(FS.font.caption()).foregroundColor(c.textMuted)
                    HStack(spacing: FS.space.s2) {
                        ForEach(Array(confirmation.sasLed.enumerated()), id: \.offset) { _, symbol in
                            Circle()
                                .fill(ledColor(symbol))
                                .frame(width: 14, height: 14)
                        }
                        Spacer()
                        Text(confirmation.sasDisplay)
                            .font(FS.font.mono()).foregroundColor(c.textMuted)
                    }
                }
            }
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
