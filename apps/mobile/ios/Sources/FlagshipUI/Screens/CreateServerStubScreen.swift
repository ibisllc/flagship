import SwiftUI
import Flagship

/// Phone-side v2 create-server flow.
///
/// User pastes / scans the QR URL shown on `flagshipserver.com`, the
/// app derives the SAS match code, user confirms the code shows the
/// same digits on both screens, the app mints + signs an InstallBlob
/// and delivers it through the QR-relay. The browser receives the
/// AEAD-decrypted recipe and writes the personalized ISO.
public struct CreateServerStubScreen: View {
    @Environment(\.colorScheme) private var scheme
    @Bindable var vm: CreateServerViewModel
    var onDelivered: (_ serverDomain: String, _ name: String, _ description: String) -> Void = { _, _, _ in }
    var onDemoComplete: (_ name: String, _ description: String) -> Void = { _, _ in }

    public init(
        vm: CreateServerViewModel,
        onDelivered: @escaping (_ serverDomain: String, _ name: String, _ description: String) -> Void = { _, _, _ in },
        onDemoComplete: @escaping (_ name: String, _ description: String) -> Void = { _, _ in }
    ) {
        self.vm = vm
        self.onDelivered = onDelivered
        self.onDemoComplete = onDemoComplete
    }

    public var body: some View {
        let c = FSColors.scheme(scheme)
        ScrollView {
            VStack(alignment: .leading, spacing: FS.space.s6) {
                Spacer().frame(height: FS.space.s12)
                Text("Provision a new server").font(FS.font.h2()).foregroundColor(c.text)
                Text("Open flagshipserver.com on your desktop. Scan or paste the QR code into this app — the page will start writing your personalized ISO once you confirm the match codes line up.")
                    .font(FS.font.body())
                    .foregroundColor(c.textMuted)

                switch vm.phase {
                case .parseQr:               formCard(c: c)
                case .connecting:            spinnerCard("Connecting to flagshipserver.com…", c: c)
                case .matching(let code, let armed):
                    matchCard(code: code, gateOpen: armed, c: c)
                case .minting:               spinnerCard("Minting install blob…", c: c)
                case .delivering:            spinnerCard("Delivering through the relay…", c: c)
                case .delivered(let serial, let serverDomain):
                    deliveredCard(serial: serial, serverDomain: serverDomain, c: c)
                case .failed(let msg):
                    failureCard(msg: msg, c: c)
                }

                Spacer().frame(height: FS.space.s12)
            }
            .padding(.horizontal, FS.space.s6)
        }
        .background(c.bg.ignoresSafeArea())
    }

    // MARK: - Phase cards

    private func formCard(c: FSColors) -> some View {
        VStack(alignment: .leading, spacing: FS.space.s4) {
            FSCard {
                VStack(alignment: .leading, spacing: FS.space.s3) {
                    Text("NAME THIS SERVER")
                        .font(.system(size: 12, weight: .semibold))
                        .tracking(1)
                        .foregroundColor(c.textMuted)
                    FSField(value: $vm.name, label: "Short name", placeholder: "Home, Office, Garage")
                        .accessibilityIdentifier("cs-name-field")
                    FSField(value: $vm.description, label: "One-line description", placeholder: "Failover for work · Music projects", helper: "Shown wherever the FQDN used to be.")
                        .accessibilityIdentifier("cs-description-field")
                }
            }

            FSCard {
                VStack(alignment: .leading, spacing: FS.space.s3) {
                    Text("PASTE THE QR URL")
                        .font(.system(size: 12, weight: .semibold))
                        .tracking(1)
                        .foregroundColor(c.textMuted)
                    Text("On your desktop, open flagshipserver.com. Copy the URL behind the QR (long-press the QR), and paste it here. Or tap the camera button to scan.")
                        .font(FS.font.bodySm())
                        .foregroundColor(c.textMuted)
                    FSField(
                        value: $vm.qrUrl,
                        label: "",
                        placeholder: "https://flagshipserver.com/qr?s=…&k=…"
                    )
                    .accessibilityIdentifier("cs-qr-field")
                }
            }

            FSPrimaryButton("Connect", enabled: vm.canSubmit, block: true, large: true) {
                Task { await vm.connectAndMatch() }
            }
            .accessibilityIdentifier("cs-connect-button")

            if !vm.name.trimmingCharacters(in: .whitespaces).isEmpty {
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

    private func spinnerCard(_ message: String, c: FSColors) -> some View {
        FSCard(padding: FS.space.s8) {
            VStack(spacing: FS.space.s4) {
                ProgressView()
                Text(message)
                    .font(FS.font.body())
                    .foregroundColor(c.textMuted)
            }
            .frame(maxWidth: .infinity)
        }
    }

    private func matchCard(code: String, gateOpen: Bool, c: FSColors) -> some View {
        VStack(alignment: .leading, spacing: FS.space.s4) {
            FSCard(padding: FS.space.s6) {
                VStack(alignment: .leading, spacing: FS.space.s2) {
                    Text("VERIFY MATCH CODE")
                        .font(.system(size: 12, weight: .semibold))
                        .tracking(1)
                        .foregroundColor(c.textMuted)
                        .accessibilityIdentifier("cs-match-label")
                    Text(QrRelay.formatMatchCode(code))
                        .font(.system(size: 40, weight: .semibold, design: .monospaced))
                        .foregroundColor(c.text)
                        .tracking(6)
                        .frame(maxWidth: .infinity, alignment: .center)
                        .padding(.vertical, FS.space.s2)
                    Text("Look at the desktop screen. These six digits must match exactly. If they don't, someone is in the middle — cancel.")
                        .font(FS.font.bodySm())
                        .foregroundColor(c.textMuted)
                }
            }
            FSPrimaryButton(
                gateOpen ? "Codes match — confirm" : "Reading…",
                enabled: gateOpen,
                block: true,
                large: true
            ) {
                Task { await vm.confirmAndDeliver() }
            }
            FSGhostButton("Cancel", block: true) {
                Task { await vm.cancel() }
            }
        }
    }

    private func deliveredCard(serial: String, serverDomain: String, c: FSColors) -> some View {
        VStack(alignment: .leading, spacing: FS.space.s4) {
            FSCard(padding: FS.space.s6) {
                VStack(alignment: .leading, spacing: FS.space.s3) {
                    HStack(spacing: FS.space.s2) {
                        Image(systemName: "checkmark.seal.fill").foregroundColor(c.success)
                        Text("Delivered").font(FS.font.h3()).foregroundColor(c.text)
                    }
                    labeled("Server", serverDomain, mono: true, c: c)
                    labeled("Serial", serial, mono: true, c: c)
                    Text("The flagshipserver.com page is writing your personalized ISO now. Once you flash + boot, the server will phone home and appear in your pod list.")
                        .font(FS.font.bodySm())
                        .foregroundColor(c.textMuted)
                }
            }
            FSPrimaryButton("Done", block: true, large: true) {
                onDelivered(serverDomain, vm.name, vm.description)
            }
        }
    }

    private func failureCard(msg: String, c: FSColors) -> some View {
        VStack(alignment: .leading, spacing: FS.space.s4) {
            ErrorCard(message: msg)
            FSGhostButton("Try again", block: true) {
                vm.phase = .parseQr
            }
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
