import SwiftUI
import FlagshipCore

/// Pair-with-the-desktop-Burner screen. Presented (as a sheet) from the
/// create-server delivery chooser once the server is designed. The user
/// scans the QR the Burner shows (or types its short code), confirms the
/// 6-digit security code, and the recipe is minted + delivered over the
/// live session. A dropped session ends the flow (the Burner re-locks).
public struct BurnerPairScreen: View {
    @Environment(\.colorScheme) private var scheme
    @Bindable var vm: BurnerPairViewModel
    var onDelivered: (_ serverDomain: String, _ serial: String) -> Void
    var onCancel: () -> Void

    public init(
        vm: BurnerPairViewModel,
        onDelivered: @escaping (_ serverDomain: String, _ serial: String) -> Void,
        onCancel: @escaping () -> Void
    ) {
        self.vm = vm
        self.onDelivered = onDelivered
        self.onCancel = onCancel
    }

    public var body: some View {
        let c = FSColors.scheme(scheme)
        ScrollView {
            VStack(alignment: .leading, spacing: FS.space.s6) {
                Spacer().frame(height: FS.space.s6)
                switch vm.phase {
                case .scan:       scanPage(c: c)
                case .enterCode:  enterCodePage(c: c)
                case .connecting:
                    header("Connecting", "Opening the secure channel to the burner…", c: c)
                    spinner(c: c)
                case .matching(let code, let gate):
                    matchPage(code: code, gateOpen: gate, c: c)
                case .delivering:
                    header("Delivering", "Minting your recipe and sending it to the burner…", c: c)
                    spinner(c: c)
                case .delivered(let domain):
                    deliveredPage(domain: domain, c: c)
                case .failed(let msg):
                    failurePage(msg, c: c)
                }
                Spacer().frame(height: FS.space.s12)
            }
            .padding(.horizontal, FS.space.s6)
        }
        .background(c.bg.ignoresSafeArea())
        .onChange(of: deliveredKey) { _, _ in
            if case .delivered(let domain) = vm.phase {
                onDelivered(domain, vm.lastDeliveredSerial ?? "")
            }
        }
    }

    /// Stable key so the delivered callback fires exactly once.
    private var deliveredKey: String {
        if case .delivered(let d) = vm.phase { return "delivered:\(d)" }
        return "\(vm.phase)"
    }

    // MARK: - Scan

    private func scanPage(c: FSColors) -> some View {
        VStack(alignment: .leading, spacing: FS.space.s4) {
            header("Pair with the burner", "On your computer, open the Flagship Burner — it shows a QR code and a short code. Point your camera at it.", c: c)

            FSCard(padding: 0) {
                QRScannerView(
                    onScan: { code in Task { await vm.qrDetected(code) } },
                    onError: { _ in },
                    validate: { BurnerPairing.looksLikeBurnerCode($0) }
                )
                .frame(height: 300)
                .clipShape(RoundedRectangle(cornerRadius: FS.radius.md))
            }

            Button("Enter the code instead") { vm.switchToEnterCode() }
                .font(FS.font.body())
                .foregroundColor(c.primary)

            whereToGetBurner(c: c)
        }
    }

    private func enterCodePage(c: FSColors) -> some View {
        VStack(alignment: .leading, spacing: FS.space.s4) {
            header("Enter the burner code", "Type the short code shown under the QR on your computer (like ABCD-EFGH).", c: c)
            FSCard {
                FSField(value: $vm.typedCode, label: "Burner code", placeholder: "ABCD-EFGH")
                    .textInputAutocapitalization(.characters)
                    .autocorrectionDisabled()
            }
            FSPrimaryButton("Connect", enabled: vm.canSubmitCode, block: true, large: true) {
                Task { await vm.submitCode() }
            }
            Button("Scan the QR instead") { vm.switchToScan() }
                .font(FS.font.body())
                .foregroundColor(c.primary)
            whereToGetBurner(c: c)
        }
    }

    private func whereToGetBurner(c: FSColors) -> some View {
        FSCard {
            VStack(alignment: .leading, spacing: FS.space.s2) {
                Label("Don't have the burner?", systemImage: "questionmark.circle")
                    .font(FS.font.h4())
                    .foregroundColor(c.text)
                Text("The Flagship Burner is a small desktop app that writes your server to a USB stick. Get it at flagshipserver.com, open it, and it'll show the code to scan here.")
                    .font(FS.font.caption())
                    .foregroundColor(c.textMuted)
            }
        }
    }

    // MARK: - Match (SAS)

    private func matchPage(code: String, gateOpen: Bool, c: FSColors) -> some View {
        VStack(alignment: .leading, spacing: FS.space.s4) {
            header("Confirm the security code", "Check that this matches the code on your computer. Only confirm if they're the same.", c: c)
            FSCard {
                VStack(spacing: FS.space.s3) {
                    Text(BurnerPairing_format(code))
                        .font(.system(size: 40, design: .monospaced).weight(.bold))
                        .foregroundColor(c.text)
                        .frame(maxWidth: .infinity)
                }
                .padding(.vertical, FS.space.s4)
            }
            FSPrimaryButton("They match — pair & send", enabled: gateOpen, block: true, large: true) {
                Task { await vm.confirmAndDeliver() }
            }
            FSGhostButton("Cancel", block: true) {
                Task { await vm.cancel(); onCancel() }
            }
        }
    }

    // MARK: - Delivered / failure

    private func deliveredPage(domain: String, c: FSColors) -> some View {
        VStack(alignment: .leading, spacing: FS.space.s4) {
            header("Recipe sent", "Your computer's burner has the recipe. Write it to a USB stick there, then boot your hardware.", c: c)
            FSCard {
                Label(domain, systemImage: "checkmark.seal.fill")
                    .font(FS.font.h4())
                    .foregroundColor(c.text)
            }
            FSPrimaryButton("Done", block: true, large: true) {
                onDelivered(domain, vm.lastDeliveredSerial ?? "")
            }
        }
    }

    private func failurePage(_ msg: String, c: FSColors) -> some View {
        VStack(alignment: .leading, spacing: FS.space.s4) {
            header("Pairing failed", msg, c: c)
            FSPrimaryButton("Try again", block: true, large: true) { vm.switchToScan() }
            FSGhostButton("Cancel", block: true) { Task { await vm.cancel(); onCancel() } }
        }
    }

    // MARK: - Bits

    private func header(_ title: String, _ subtitle: String, c: FSColors) -> some View {
        VStack(alignment: .leading, spacing: FS.space.s2) {
            Text(title).font(FS.font.h2()).foregroundColor(c.text)
            Text(subtitle).font(FS.font.body()).foregroundColor(c.textMuted)
        }
    }

    private func spinner(c: FSColors) -> some View {
        FSCard { HStack { Spacer(); ProgressView(); Spacer() }.padding(.vertical, FS.space.s6) }
    }
}

/// Local helper to format the 6-digit SAS ("123 456") without importing the
/// burner-mac copy. Mirrors BurnerPairing.formatMatchCode.
private func BurnerPairing_format(_ code: String) -> String {
    guard code.count == 6 else { return code }
    let i = code.index(code.startIndex, offsetBy: 3)
    return code[code.startIndex..<i] + " " + code[i...]
}
