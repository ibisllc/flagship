import SwiftUI
import Flagship
import FlagshipAPI
import FlagshipCore

/// "Choose your own account name" (sign-up, from the suggestion screen or a name-grant link). The account is opened
/// under the suggested name, then renamed once the chosen name is paid for (ChooseAccountNameViewModel).
public struct ChooseAccountNameScreen: View {
    @Environment(\.flagshipServerClient) private var server
    @Environment(\.paymentsComClient) private var paymentsClient
    @State private var vm: ChooseAccountNameViewModel?

    let suggested: String
    let grant: NameGrant?
    /// Onboarding continues as `accountName` (the chosen name, or the suggested one kept).
    var onOpened: (_ username: String, _ accountName: String, _ deviceName: String, _ deviceId: String) -> Void

    public init(suggested: String, grant: NameGrant? = nil,
                onOpened: @escaping (_ username: String, _ accountName: String, _ deviceName: String, _ deviceId: String) -> Void) {
        self.suggested = suggested
        self.grant = grant
        self.onOpened = onOpened
    }

    public var body: some View {
        FSScreen {
            VStack(alignment: .leading, spacing: FS.space.s6) {
                Spacer().frame(height: FS.space.s8)
                Text("Choose your own account name").font(FS.font.h2())
                    .lineLimit(nil)
                    .fixedSize(horizontal: false, vertical: true)
                if let vm { content(vm) }
                Spacer()
            }
            .padding(.horizontal, FS.space.s6)
            .padding(.bottom, FS.space.s8)
        }
        .navigationBarBackButtonHidden(vm?.opened != nil || vm?.isWorking == true)
        .task {
            if vm == nil {
                let open = OpenAccountViewModel(username: suggested, server: server,
                                                defaultDeviceName: UIDevice.current.name, deferPqBinding: true)
                vm = ChooseAccountNameViewModel(
                    suggested: suggested,
                    grant: grant,
                    openAccount: {
                        await open.openAccount()
                        if case .failed(let msg) = open.phase { throw ChooseNameOpenError(message: msg) }
                        guard let keys = open.opened else { throw Keystore.KeystoreError.keyNotFound }
                        return keys
                    },
                    client: LiveAccountNameChangeClient(),
                    server: server,
                    wallet: paymentsClient.map { PaymentsCenterNameChangeWallet(client: $0) }
                )
            }
        }
        .onChange(of: vm?.completedName) { _, name in
            guard let name, let vm, let keys = vm.opened else { return }
            let accountName = name == vm.suggested ? keys.accountDisplayName : ChooseAccountNameViewModel.displayName(for: name)
            if case .done = vm.phase {
                // The success line shows first; Continue moves on.
                return
            }
            onOpened(name, accountName, keys.deviceDisplayName, keys.deviceId)
        }
    }

    @ViewBuilder
    private func content(_ vm: ChooseAccountNameViewModel) -> some View {
        FSColorReader { c in
            VStack(alignment: .leading, spacing: FS.space.s4) {
                if case .done(let name) = vm.phase {
                    Text("Your account is now \(name).").font(FS.font.body()).foregroundColor(c.text)
                        .accessibilityIdentifier("choose-name-done")
                    FSPrimaryButton(String(localized: "Continue"), block: true, large: true) {
                        guard let keys = vm.opened else { return }
                        onOpened(name, ChooseAccountNameViewModel.displayName(for: name), keys.deviceDisplayName, keys.deviceId)
                    }
                } else {
                    if vm.grant != nil {
                        Text(NameGrantText.setAside).font(FS.font.body()).foregroundColor(c.text)
                    }
                    FSField(
                        value: Binding(get: { vm.name }, set: { vm.name = $0 }),
                        label: String(localized: "Account name"),
                        error: vm.nameProblem,
                        prefix: VoiciAddress.prefix
                    )
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled(true)
                    .accessibilityIdentifier("choose-name-field")
                    // A pasted address keeps only the name. Stripped after the edit lands: a binding setter that
                    // changes the text it was given leaves the field showing the old text.
                    .onChange(of: vm.name) { _, typed in
                        let bare = VoiciAddress.stripPrefix(typed)
                        if bare != typed { vm.name = bare }
                    }
                    if vm.isFreeGrant {
                        FSPrimaryButton(String(localized: "Continue"), enabled: vm.canPay, block: true, large: true) {
                            Task { await vm.continueWithGrant() }
                        }
                        .accessibilityIdentifier("choose-name-continue")
                    } else {
                        Text("Your own account name costs $10.").font(FS.font.body()).foregroundColor(c.textMuted)
                        FSPrimaryButton(String(localized: "Pay $10"), enabled: vm.canPay, block: true, large: true) {
                            Task { await vm.pay() }
                        }
                        .accessibilityIdentifier("choose-name-pay")
                        if vm.showsCode {
                            FSField(value: Binding(get: { vm.code }, set: { vm.code = $0 }), label: String(localized: "Voucher code"))
                                .textInputAutocapitalization(.never)
                                .autocorrectionDisabled(true)
                                .accessibilityIdentifier("choose-name-code")
                            FSSecondaryButton(String(localized: "Use voucher"), block: true) {
                                Task { await vm.useCode() }
                            }
                            .disabled(!vm.canUseCode)
                            .accessibilityIdentifier("choose-name-use-code")
                        } else {
                            FSGhostButton(String(localized: "Use a voucher"), block: true) { vm.showsCode = true }
                                .disabled(vm.isWorking)
                                .accessibilityIdentifier("choose-name-show-code")
                        }
                    }
                    if vm.isWorking {
                        Text("Setting up your account name…").font(FS.font.caption()).foregroundColor(c.textMuted)
                    }
                    if let msg = vm.message {
                        Text(msg).font(FS.font.caption()).foregroundColor(c.danger)
                            .accessibilityIdentifier("choose-name-message")
                    }
                    if vm.opened != nil {
                        FSGhostButton(String(localized: "Keep \(vm.suggested)"), block: true) { vm.keepSuggested() }
                            .disabled(vm.isWorking)
                            .accessibilityIdentifier("choose-name-keep")
                    }
                }
            }
        }
    }
}

/// Opening the account failed; its sentence is already the user's.
public struct ChooseNameOpenError: Error, LocalizedError {
    public let message: String
    public init(message: String) { self.message = message }
    public var errorDescription: String? { message }
}
