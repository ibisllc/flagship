import SwiftUI
#if canImport(UIKit)
import UIKit
#endif
import FlagshipAPI

/// **Open account** — the create-onboarding step that decouples account
/// identity from server provisioning (Phase 2 of the login redesign).
///
/// After ChooseUsername reserves a handle, this screen actually *opens*
/// the account: it generates the UMK, derives the IRK, POSTs a
/// standalone `claimUsername`, and captures a human-readable name for
/// this first device ("everyone is addressed as a device with a
/// human-readable name"). No server is provisioned here — the user lands
/// on Home with zero servers and an "Add your first server" CTA.
///
/// See docs/login-and-account-redesign.md (principles 1 + 6).
public struct OpenAccountScreen: View {
    @Environment(\.flagshipServerClient) private var server
    @Environment(\.colorScheme) private var scheme

    let username: String
    /// Called once the account is open. Carries the chosen device name
    /// so the host can complete onboarding with `pods: []`.
    var onOpened: (_ accountName: String, _ deviceName: String, _ deviceId: String) -> Void

    @State private var vm: OpenAccountViewModel?

    public init(
        username: String,
        onOpened: @escaping (_ accountName: String, _ deviceName: String, _ deviceId: String) -> Void = { _, _, _ in }
    ) {
        self.username = username
        self.onOpened = onOpened
    }

    public var body: some View {
        let c = FSColors.scheme(scheme)
        FSScreen {
            VStack(alignment: .leading, spacing: FS.space.s6) {
                Spacer().frame(height: FS.space.s12)
                Text("Open your account.").font(FS.font.h2())
                Text("We'll create your account keys for \(username) and name this device. You can add a server afterwards — or run with none.")
                    .font(FS.font.body())
                    .foregroundColor(c.textMuted)

                if let vm {
                    FSField(
                        value: Binding(
                            get: { vm.accountName },
                            set: { vm.accountName = $0 }
                        ),
                        label: "Account display name",
                        placeholder: "Johnson Family",
                        helper: "Encrypted and shown above @\(username). It is never used in links."
                    )
                    .textInputAutocapitalization(.words)
                    .accessibilityIdentifier("open-account-account-name")

                    FSField(
                        value: Binding(
                            get: { vm.deviceName },
                            set: { vm.deviceName = $0 }
                        ),
                        label: "Name this device",
                        placeholder: "\(username)'s iPhone",
                        helper: "Shown wherever your devices are listed. You can change it later.",
                        error: errorText
                    )
                    .textInputAutocapitalization(.words)
                    .autocorrectionDisabled(false)
                    .accessibilityIdentifier("open-account-device-name")
                }

                Spacer()

                FSPrimaryButton(
                    ctaLabel,
                    enabled: (vm?.canOpen ?? false),
                    block: true,
                    large: true
                ) {
                    Task { await open() }
                }
                .accessibilityIdentifier("open-account-continue")
            }
            .padding(.horizontal, FS.space.s6)
            .padding(.bottom, FS.space.s8)
        }
        .navigationTitle("Open account")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            if vm == nil {
                vm = OpenAccountViewModel(
                    username: username,
                    server: server,
                    defaultDeviceName: OpenAccountScreen.osDeviceName()
                )
            }
        }
    }

    private func open() async {
        guard let vm else { return }
        await vm.openAccount()
        if case .opened(let deviceName) = vm.phase, let deviceId = vm.createdDeviceId {
            onOpened(vm.effectiveAccountName, deviceName, deviceId)
        }
    }

    private var ctaLabel: String {
        if case .opening = vm?.phase { return "Opening…" }
        return "Open account"
    }

    private var errorText: String? {
        if case .failed(let msg) = vm?.phase { return msg }
        return nil
    }

    /// Best-effort OS device name. On the simulator/host this is often a
    /// generic value; the VM falls back to "<username>'s iPhone" when
    /// it's empty.
    private static func osDeviceName() -> String? {
        #if canImport(UIKit)
        let name = UIDevice.current.name
        return name.isEmpty ? nil : name
        #else
        return nil
        #endif
    }
}
