import SwiftUI
import FlagshipCore

/// "Set up a box from a store" (docs/retail-box-setup.md §4): renders `RetailClaimViewModel`.
public struct RetailClaimScreen: View {
    @Environment(\.colorScheme) private var scheme
    @Bindable var vm: RetailClaimViewModel
    var onClose: () -> Void
    var onOpenServer: (String) -> Void
    @State private var password = ""
    @State private var passwordRefused = false
    @State private var pasted = ""

    public init(vm: RetailClaimViewModel, onClose: @escaping () -> Void, onOpenServer: @escaping (String) -> Void = { _ in }) {
        self.vm = vm
        self.onClose = onClose
        self.onOpenServer = onOpenServer
    }

    public var body: some View {
        let c = FSColors.scheme(scheme)
        Group {
            if case .alarm(let alarm, let domain) = vm.phase {
                alarmPage(alarm, domain: domain, c: c)
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: FS.space.s5) {
                        Spacer().frame(height: FS.space.s2)
                        page(c)
                        Spacer().frame(height: FS.space.s8)
                    }
                    .padding(.horizontal, FS.space.s6)
                    .fsReadingColumn()
                }
                .background(c.bg.ignoresSafeArea())
            }
        }
        .navigationTitle(String(localized: "Set up a box from a store"))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button(String(localized: "Close")) { vm.cancel(); onClose() }
                    .accessibilityIdentifier("rc-close")
            }
        }
    }

    private func header(_ title: String, _ body: String?, c: FSColors) -> some View {
        VStack(alignment: .leading, spacing: FS.space.s2) {
            Text(title).font(FS.font.h2()).foregroundColor(c.text).accessibilityIdentifier("rc-title")
            if let body { Text(body).font(FS.font.body()).foregroundColor(c.textMuted).accessibilityIdentifier("rc-body") }
        }
    }

    private func spinner(_ c: FSColors) -> some View {
        FSCard(padding: FS.space.s6) { ProgressView().frame(maxWidth: .infinity) }
    }

    @ViewBuilder
    private func page(_ c: FSColors) -> some View {
        switch vm.phase {
        case .intro:
            header(String(localized: "Keep the box unplugged for now"),
                   String(localized: "This phone looks for the box over Bluetooth. Start here, and plug the box in only when the app asks."), c: c)
            FSCard {
                VStack(alignment: .leading, spacing: FS.space.s2) {
                    Text("Use the network cable if you can").font(FS.font.h4()).foregroundColor(c.text)
                    Text("Plug it into your router before the power. Then your Wi-Fi password never has to travel over the air.")
                        .font(FS.font.bodySm()).foregroundColor(c.textMuted)
                }
            }
            FSPrimaryButton(String(localized: "Start"), block: true, large: true) { vm.startBluetooth() }
                .accessibilityIdentifier("rc-start")
            FSGhostButton(String(localized: "I have a setup code from the box's screen"), block: true) { vm.showCodeScanner() }
                .accessibilityIdentifier("rc-code")
        case .scanCode:
            header(String(localized: "Scan the setup code"),
                   String(localized: "Scan the QR code the box shows on its screen, or the photo someone sent you. The box must be on a network cable."), c: c)
            FSCard(padding: 0) {
                QRScannerView(onScan: { vm.startWithCode($0) }, onError: { _ in },
                              validate: { BoxClaim.parseSetupCodeLink($0) != nil })
                    .frame(height: 280)
                    .clipShape(RoundedRectangle(cornerRadius: FS.radius.md, style: .continuous))
            }
            TextField(String(localized: "Or type the 20-character code"), text: $pasted)
                .textInputAutocapitalization(.characters)
                .autocorrectionDisabled()
                .textFieldStyle(.roundedBorder)
                .accessibilityIdentifier("rc-code-field")
            FSPrimaryButton(String(localized: "Continue"), enabled: BoxClaim.normalizeSetupCode(pasted) != nil, block: true) {
                vm.startWithCode(pasted)
            }
            .accessibilityIdentifier("rc-code-continue")
        case .checkingNearby:
            header(String(localized: "Checking for other boxes"), String(localized: "Keep the box unplugged for a moment."), c: c)
            spinner(c)
        case .plugIn(let hint):
            header(String(localized: "Plug in the box"),
                   String(localized: "Plug the network cable into your router if you can. Then plug in the power. The box starts by itself."), c: c)
            spinner(c)
            if hint == .pressOnce {
                Text("If the box stays off, press the power button once.")
                    .font(FS.font.body()).foregroundColor(c.text).accessibilityIdentifier("rc-press-once")
            }
            if hint == .noBox {
                FSCard {
                    VStack(alignment: .leading, spacing: FS.space.s2) {
                        Text("No new box appeared").font(FS.font.h4()).foregroundColor(c.text)
                        Text(RetailClaimCopy.resetInstructions).font(FS.font.bodySm()).foregroundColor(c.textMuted)
                    }
                }
                .accessibilityIdentifier("rc-no-box")
                FSPrimaryButton(String(localized: "Try again"), block: true) { vm.startBluetooth() }
            }
        case .connecting:
            header(String(localized: "Found your box"), String(localized: "Opening an encrypted connection…"), c: c)
            spinner(c)
        case .getReady:
            header(String(localized: "Get ready"), String(localized: "Put your finger near the box's power button. Don't press it yet."), c: c)
            spinner(c)
        case .pressNow:
            header(String(localized: "Press the power button now"),
                   String(localized: "Once, briefly. A short press does not switch the box off."), c: c)
            Image(systemName: "power.circle.fill")
                .font(.system(size: 96)).foregroundColor(c.accent)
                .frame(maxWidth: .infinity)
                .accessibilityIdentifier("rc-press-now")
        case .signing:
            header(String(localized: "Approve the new server"), String(localized: "Confirm with Face ID or your passcode to sign this server's recipe."), c: c)
            spinner(c)
        case .registeringKey:
            header(String(localized: "Registering the box"), String(localized: "Telling Flagship which box this server is…"), c: c)
            spinner(c)
        case .chooseNetwork:
            header(String(localized: "How does the box reach the internet?"), nil, c: c)
            FSPrimaryButton(String(localized: "It's on a network cable"), block: true, large: true) { vm.useCable() }
                .accessibilityIdentifier("rc-cable")
            FSGhostButton(String(localized: "Use Wi-Fi"), block: true) { vm.useWifi() }
                .accessibilityIdentifier("rc-wifi")
        case .scanningWifi:
            header(String(localized: "Looking for Wi-Fi networks"), String(localized: "The box is listing the networks it can see…"), c: c)
            spinner(c)
        case .wifiList(let nets):
            header(String(localized: "Choose your Wi-Fi"), nets.isEmpty ? String(localized: "The box sees no Wi-Fi networks. Use a network cable instead.") : nil, c: c)
            ForEach(nets) { n in
                Button { vm.pickNetwork(n.ssid) } label: {
                    FSCard(padding: FS.space.s3) {
                        HStack {
                            Image(systemName: n.signal > 60 ? "wifi" : "wifi.exclamationmark").foregroundColor(c.text)
                            Text(n.ssid).font(FS.font.body()).foregroundColor(n.supported ? c.text : c.textMuted)
                            Spacer()
                            if !n.supported { Text("Not supported").font(FS.font.bodySm()).foregroundColor(c.textMuted) }
                        }
                    }
                }
                .buttonStyle(.plain)
                .disabled(!n.supported)
                .accessibilityIdentifier("rc-net-\(n.ssid)")
            }
            FSGhostButton(String(localized: "Use a cable instead"), block: true) { vm.useCable() }
        case .wifiPassword(let ssid):
            header(String(localized: "Wi-Fi password"), ssid, c: c)
            SecureField(String(localized: "Password"), text: $password)
                .textFieldStyle(.roundedBorder)
                .accessibilityIdentifier("rc-password")
            if passwordRefused {
                Text("A Wi-Fi password has 8 to 63 characters.").font(FS.font.bodySm()).foregroundColor(c.danger)
            }
            FSPrimaryButton(String(localized: "Continue"), block: true) {
                passwordRefused = !vm.submitPassword(ssid: ssid, password: password)
            }
            .accessibilityIdentifier("rc-password-continue")
        case .wifiWarning:
            header(String(localized: "Before you send it"), RetailClaimCopy.wifiWarning, c: c)
            FSPrimaryButton(String(localized: "Use a cable instead"), block: true) { password = ""; vm.useCable() }
                .accessibilityIdentifier("rc-warning-cable")
            FSGhostButton(String(localized: "Send it"), block: true) { password = ""; vm.sendWifi() }
                .accessibilityIdentifier("rc-warning-send")
        case .connectingNetwork:
            header(String(localized: "Connecting the box"), String(localized: "The box is joining the network…"), c: c)
            spinner(c)
        case .networkFailed(let f):
            header(String(localized: "The box couldn't get online"), RetailClaimCopy.networkFailure(f), c: c)
            FSPrimaryButton(String(localized: "Try again"), block: true) { vm.retryNetwork() }
                .accessibilityIdentifier("rc-network-retry")
        case .checkingInternet:
            header(String(localized: "Checking the box online"),
                   String(localized: "Making sure the server that comes online is the box you paired with. This can take a few minutes."), c: c)
            spinner(c)
        case .done(let domain):
            header(String(localized: "Your box is set up"), String(localized: "The server that came online is the box you paired with."), c: c)
            Label(domain, systemImage: "lock.fill").font(FS.font.body()).foregroundColor(c.text)
                .accessibilityIdentifier("rc-done")
            FSPrimaryButton(String(localized: "Open the server"), block: true, large: true) { onOpenServer(domain) }
        case .stopped(let s):
            header(s.title, s.message, c: c)
                .accessibilityIdentifier("rc-stopped")
            FSPrimaryButton(String(localized: "Try again"), block: true) { vm.tryAgain() }
                .accessibilityIdentifier("rc-try-again")
        case .failed(let message):
            header(String(localized: "Setup stopped"), message, c: c)
            FSPrimaryButton(String(localized: "Try again"), block: true) { vm.tryAgain() }
        case .alarm:
            EmptyView()
        }
    }

    private func alarmPage(_ alarm: RetailClaimAlarm, domain: String, c: FSColors) -> some View {
        VStack(alignment: .leading, spacing: FS.space.s5) {
            Image(systemName: "exclamationmark.octagon.fill").font(.system(size: 64)).foregroundColor(.white)
            Text("Don't use this server").font(FS.font.h1()).foregroundColor(.white)
            Text(alarm.message).font(FS.font.body()).foregroundColor(.white)
                .accessibilityIdentifier("rc-alarm")
            Text(domain).font(FS.font.bodySm()).foregroundColor(.white.opacity(0.85))
            Spacer()
            FSDangerButton(String(localized: "Open the server to delete it"), block: true, large: true) { onOpenServer(domain) }
            FSGhostButton(String(localized: "Close"), block: true) { onClose() }
        }
        .padding(FS.space.s6)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(c.danger.ignoresSafeArea())
    }
}
