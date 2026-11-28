import SwiftUI
import Flagship
import FlagshipAPI
import FlagshipCore

/// "Choose your own account name" (sign-up, from the suggestion screen or a name-grant link). The account is opened
/// under the suggested name, then renamed once the chosen name is paid for (ChooseAccountNameViewModel).
public struct ChooseAccountNameScreen: View {
    @Environment(\.flagshipServerClient) private var server
    @Environment(\.paymentsComClient) private var paymentsClient
    @Environment(\.openURL) private var openURL
    @State private var vm: ChooseAccountNameViewModel?
    @State private var showsWhy = false
    @FocusState private var nameFocused: Bool
    @FocusState private var codeFocused: Bool
    @ScaledMetric(relativeTo: .body) private var statusIdealWidth: CGFloat = 200

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

    private static let statusId = "choose-name-status"
    private static let messageId = "choose-name-message"

    /// The live client, or (Debug, the mock gym) one that answers from `-smoke-held-names`.
    private static func nameChangeClient() -> any AccountNameChangeClient {
        #if DEBUG
        if GymLaunch.usesMocks { return GymHeldNameClient(args: ProcessInfo.processInfo.arguments) }
        #endif
        return LiveAccountNameChangeClient()
    }

    public var body: some View {
        FSScreen {
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(alignment: .leading, spacing: FS.space.s6) {
                        Spacer().frame(height: FS.space.s8)
                        Text("Choose your own account name").font(FS.font.h2())
                            .lineLimit(nil)
                            .fixedSize(horizontal: false, vertical: true)
                        if let vm { content(vm) }
                    }
                    .padding(.horizontal, FS.space.s6)
                    .padding(.bottom, FS.space.s8)
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .scrollDismissesKeyboard(.interactively)
                // A hold, or any sentence, scrolls into view above the keyboard.
                .onChange(of: vm?.heldStatus) { _, status in
                    guard status != nil else { return }
                    withAnimation { proxy.scrollTo(Self.statusId) }
                }
                .onChange(of: vm?.message) { _, msg in
                    guard msg != nil else { return }
                    withAnimation { proxy.scrollTo(Self.messageId) }
                }
            }
        }
        .navigationBarBackButtonHidden(vm?.opened != nil || vm?.isWorking == true)
        .sheet(isPresented: $showsWhy) {
            if let vm, let held = vm.heldDetails {
                HeldNameWhySheet(name: held.name, domain: held.domain, heldUntil: held.heldUntil)
            }
        }
        .task {
            if vm == nil {
                let open = OpenAccountViewModel(username: suggested, server: server,
                                                defaultDeviceName: UIDevice.current.name, deferPqBinding: true)
                let model = ChooseAccountNameViewModel(
                    suggested: suggested,
                    grant: grant,
                    openAccount: {
                        await open.openAccount()
                        if case .failed(let msg) = open.phase { throw ChooseNameOpenError(message: msg) }
                        guard let keys = open.opened else { throw Keystore.KeystoreError.keyNotFound }
                        return keys
                    },
                    client: Self.nameChangeClient(),
                    server: server,
                    wallet: paymentsClient.map { PaymentsCenterNameChangeWallet(client: $0) }
                )
                vm = model
                // A name handed in (a name-grant link) is checked at once.
                model.nameDidChange()
            }
        }
        .onChange(of: vm?.heldStatus) { _, status in
            // VoiceOver hears the hold as soon as the check comes back.
            guard let status else { return }
            AccessibilityNotification.Announcement(status).post()
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

    /// Close the keyboard first, so the answer under the field has room, then act.
    private func submit(_ vm: ChooseAccountNameViewModel, _ action: @escaping (ChooseAccountNameViewModel) async -> Void) {
        nameFocused = false
        codeFocused = false
        Task { await action(vm) }
    }

    @ViewBuilder
    private func statusLine(_ vm: ChooseAccountNameViewModel, _ status: String, _ c: FSColors) -> some View {
        let text = Text(status).font(FS.font.bodySm()).foregroundColor(c.text)
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityIdentifier("choose-name-status")
        let why = Button {
            nameFocused = false
            codeFocused = false
            showsWhy = true
        } label: {
            Text(HeldNameText.why).font(FS.font.bodySm().weight(.medium)).underline().foregroundColor(c.accent)
                .frame(minHeight: 44)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(HeldNameText.whyLabel(name: vm.heldDetails?.name ?? vm.name))
        .accessibilityIdentifier("choose-name-why")
        if vm.showsWhy {
            // Why? beside the line while both fit; on its own line at large text sizes.
            ViewThatFits(in: .horizontal) {
                HStack(alignment: .firstTextBaseline, spacing: FS.space.s3) {
                    text.frame(minWidth: 0, idealWidth: statusIdealWidth, maxWidth: .infinity, alignment: .leading)
                    why.fixedSize()
                }
                VStack(alignment: .leading, spacing: 0) {
                    text
                    why
                }
            }
            .id(Self.statusId)
        } else {
            text.id(Self.statusId)
        }
    }

    @ViewBuilder
    private func content(_ vm: ChooseAccountNameViewModel) -> some View {
        FSColorReader { c in
            VStack(alignment: .leading, spacing: FS.space.s4) {
                if case .done(let name) = vm.phase {
                    Text("Your account is now \(name).").font(FS.font.body()).foregroundColor(c.text)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("choose-name-done")
                    FSPrimaryButton(String(localized: "Continue"), block: true, large: true) {
                        guard let keys = vm.opened else { return }
                        onOpened(name, ChooseAccountNameViewModel.displayName(for: name), keys.deviceDisplayName, keys.deviceId)
                    }
                } else {
                    if vm.grant != nil {
                        Text(NameGrantText.setAside).font(FS.font.body()).foregroundColor(c.text)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    VStack(alignment: .leading, spacing: FS.space.s2) {
                        FSField(
                            value: Binding(get: { vm.name }, set: { vm.name = $0 }),
                            label: String(localized: "Account name"),
                            error: vm.nameProblem ?? vm.checkProblem,
                            prefix: VoiciAddress.prefix,
                            focus: $nameFocused
                        )
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled(true)
                        .submitLabel(.done)
                        .onSubmit {
                            nameFocused = false
                            Task { await vm.checkNow() }
                        }
                        .accessibilityIdentifier("choose-name-field")
                        // A pasted address keeps only the name. Stripped after the edit lands: a binding setter that
                        // changes the text it was given leaves the field showing the old text.
                        .onChange(of: vm.name) { _, typed in
                            let bare = VoiciAddress.stripPrefix(typed)
                            if bare != typed { vm.name = bare; return }
                            vm.nameDidChange()
                        }
                        if let status = vm.heldStatus {
                            statusLine(vm, status, c)
                        }
                    }
                    if vm.isHeld {
                        Text(HeldNameText.pickAnother).font(FS.font.bodySm()).foregroundColor(c.textMuted)
                            .fixedSize(horizontal: false, vertical: true)
                            .accessibilityIdentifier("choose-name-pick-another")
                    }
                    if vm.isFreeGrant {
                        FSPrimaryButton(String(localized: "Continue"), enabled: vm.canPay, block: true, large: true) {
                            submit(vm) { await $0.continueWithGrant() }
                        }
                        .accessibilityIdentifier("choose-name-continue")
                    } else {
                        Text("Your own account name costs $10.").font(FS.font.body()).foregroundColor(c.textMuted)
                            .fixedSize(horizontal: false, vertical: true)
                        FSPrimaryButton(String(localized: "Pay $10"), enabled: vm.canPay, block: true, large: true) {
                            submit(vm) { await $0.pay() }
                        }
                        .accessibilityIdentifier("choose-name-pay")
                        if vm.showsCode {
                            FSField(value: Binding(get: { vm.code }, set: { vm.code = $0 }), label: String(localized: "Voucher code"),
                                    focus: $codeFocused)
                                .textInputAutocapitalization(.never)
                                .autocorrectionDisabled(true)
                                .submitLabel(.done)
                                .onSubmit { submit(vm) { await $0.useCode() } }
                                .accessibilityIdentifier("choose-name-code")
                            FSSecondaryButton(String(localized: "Use voucher"), block: true) {
                                submit(vm) { await $0.useCode() }
                            }
                            .disabled(!vm.canUseCode)
                            .accessibilityIdentifier("choose-name-use-code")
                        } else {
                            FSGhostButton(String(localized: "Use a voucher"), block: true) {
                                nameFocused = false
                                vm.showsCode = true
                            }
                            .disabled(vm.isWorking || vm.isHeld)
                            .accessibilityIdentifier("choose-name-show-code")
                        }
                    }
                    if vm.isWorking {
                        Text("Setting up your account name…").font(FS.font.caption()).foregroundColor(c.textMuted)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    if let msg = vm.message, msg != vm.heldStatus {
                        Text(msg).font(FS.font.caption()).foregroundColor(c.danger)
                            .fixedSize(horizontal: false, vertical: true)
                            .id(Self.messageId)
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

/// "Why is {name} held?": how `.com` dibs works and who to write to. Opened from the status line's Why?.
struct HeldNameWhySheet: View {
    let name: String
    let domain: String
    let heldUntil: Int64?
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        let c = FSColors.scheme(scheme)
        ScrollView {
            VStack(alignment: .leading, spacing: FS.space.s4) {
                Text(HeldNameText.whyLabel(name: name))
                    .font(FS.font.h2())
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityAddTraits(.isHeader)
                    .accessibilityIdentifier("held-why-title")
                Text(HeldNameText.rule(heldUntil: heldUntil))
                    .font(.body).foregroundColor(c.text)
                    .fixedSize(horizontal: false, vertical: true)
                Text(HeldNameText.yoursTitle)
                    .font(FS.font.body().weight(.semibold)).foregroundColor(c.text)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityAddTraits(.isHeader)
                Text(HeldNameText.yours(domain: domain))
                    .font(.body).foregroundColor(c.textMuted)
                    .fixedSize(horizontal: false, vertical: true)
                FSPrimaryButton(HeldNameText.emailUs, block: true, large: true) {
                    if let url = SupportContact.heldNameURL(name: name) { openURL(url) }
                }
                .accessibilityIdentifier("held-why-email")
                FSSecondaryButton(HeldNameText.howDibsWorks, block: true) {
                    openURL(HeldNameText.dibsPageURL())
                }
                .accessibilityIdentifier("held-why-dibs")
                FSGhostButton(String(localized: "OK"), block: true) { dismiss() }
                    .accessibilityIdentifier("held-why-ok")
            }
            .padding(FS.space.s6)
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }
}

/// Opening the account failed; its sentence is already the user's.
public struct ChooseNameOpenError: Error, LocalizedError {
    public let message: String
    public init(message: String) { self.message = message }
    public var errorDescription: String? { message }
}
