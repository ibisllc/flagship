import SwiftUI
import FlagshipAPI
import FlagshipCore

/// "Connect to an existing account" — one page, both ways back in.
///
///   - Sign in with your account name: the username-first Join. On submit a
///     single preflight (`/api/account/resolve`, 200 always) branches:
///       demo         → the host attaches a new device + opens the sandbox;
///       unknown      → an inline "No Flagship account by that name" state;
///       single/multi → the host pushes the real login state machine.
///   - Join with a pairing code: Scan a code (the in-app scanner) or paste the
///     code or link the other device shows; either opens the incoming join.
///
/// A pairing link pasted into the name field goes to join, with a note.
/// See docs/login-and-account-redesign.md.
public struct ConnectAccountScreen: View {
    @Environment(\.flagshipServerClient) private var server
    @Environment(\.sessionStore) private var sessionStore
    @Environment(ToastCenter.self) private var toasts
    @Environment(\.colorScheme) private var scheme
    @State private var username: String = ""
    @State private var code: String = ""
    @State private var vm: LoginViewModel?
    @State private var nameError: String?
    @State private var codeError: String?
    @State private var demoPairError: String?

    var onDemo: (_ username: String, _ demoServer: DemoServerBlock?) -> Void
    var onRealAccount: (_ resolution: AccountResolution) -> Void
    /// Opens the incoming join: a link to connect at once, or nil for the scanner.
    var onJoin: (_ joinUrl: String?) -> Void

    public init(
        onDemo: @escaping (_ username: String, _ demoServer: DemoServerBlock?) -> Void = { _, _ in },
        onRealAccount: @escaping (_ resolution: AccountResolution) -> Void = { _ in },
        onJoin: @escaping (_ joinUrl: String?) -> Void = { _ in }
    ) {
        self.onDemo = onDemo
        self.onRealAccount = onRealAccount
        self.onJoin = onJoin
    }

    public var body: some View {
        let c = FSColors.scheme(scheme)
        FSScreen {
            ScrollView {
                VStack(alignment: .leading, spacing: FS.space.s6) {
                    Text("Connect to an existing account")
                        .font(FS.font.h2())
                        .accessibilityAddTraits(.isHeader)
                        .padding(.top, FS.space.s4)
                        .accessibilityIdentifier("connect-account")
                    signInSection(c)
                    orDivider(c)
                    pairingSection(c)
                }
                .padding(.horizontal, FS.space.s6)
                .padding(.bottom, FS.space.s8)
                .fsReadingColumn()
            }
            .scrollDismissesKeyboard(.interactively)
        }
        .navigationTitle("")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            if vm == nil { vm = LoginViewModel(server: server) }
        }
    }

    // MARK: - Sign in with your account name

    @ViewBuilder
    private func signInSection(_ c: FSColors) -> some View {
        VStack(alignment: .leading, spacing: FS.space.s3) {
            Text("Sign in with your account name")
                .font(FS.font.h4())
                .accessibilityAddTraits(.isHeader)
            FSField(
                value: $username,
                label: "Account name",
                placeholder: "bright-maple",
                helper: nameHelper,
                error: nameError,
                keyboard: .asciiCapable
            )
            .textContentType(.username)
            .submitLabel(.continue)
            .onSubmit { Task { await submitName() } }
            .accessibilityIdentifier("connect-name-field")
            .onChange(of: username) { _, _ in
                if let vm, !isResolving {
                    if case .resolved = vm.phase { vm.reset() }
                    if case .failed = vm.phase { vm.reset() }
                }
                nameError = nil
                demoPairError = nil
            }

            if showUnknownState { unknownState(c) }

            FSPrimaryButton(
                isResolving ? "Checking…" : "Continue",
                enabled: !username.trimmingCharacters(in: .whitespaces).isEmpty && !isResolving,
                block: true,
                large: true
            ) {
                Task { await submitName() }
            }
            .accessibilityIdentifier("connect-name-continue")
            .accessibilityHint("Signs in to the account with this name.")
        }
    }

    // MARK: - or

    private func orDivider(_ c: FSColors) -> some View {
        HStack(spacing: FS.space.s3) {
            Rectangle().fill(c.border).frame(height: 1)
            Text("or")
                .font(FS.font.caption())
                .foregroundColor(c.textMuted)
            Rectangle().fill(c.border).frame(height: 1)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("or")
        .accessibilityIdentifier("connect-or")
    }

    // MARK: - Join with a pairing code

    @ViewBuilder
    private func pairingSection(_ c: FSColors) -> some View {
        VStack(alignment: .leading, spacing: FS.space.s3) {
            Text("Join with a pairing code")
                .font(FS.font.h4())
                .accessibilityAddTraits(.isHeader)
            Text("On a device of that account, open Settings → Trusted devices → Add a device.")
                .font(FS.font.bodySm())
                .foregroundColor(c.textMuted)
            Button {
                onJoin(nil)
            } label: {
                Label("Scan a code", systemImage: "qrcode.viewfinder")
                    .font(FS.font.scaled(16, weight: .semibold))
                    .frame(maxWidth: .infinity)
                    .frame(minHeight: 48)
                    .foregroundColor(c.text)
                    .overlay(RoundedRectangle(cornerRadius: FS.radius.md, style: .continuous).stroke(c.border, lineWidth: 1))
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("connect-scan")
            .accessibilityHint("Opens the camera to scan the other device's code.")
            FSField(
                value: $code,
                label: "Code or link",
                placeholder: "https://flagshipserver.com/join?…",
                error: codeError,
                keyboard: .URL
            )
            .submitLabel(.join)
            .onSubmit { submitCode() }
            .accessibilityIdentifier("connect-pair-field")
            .onChange(of: code) { _, _ in codeError = nil }
            FSSecondaryButton("Join", block: true, large: true) { submitCode() }
                .accessibilityIdentifier("connect-pair-continue")
                .accessibilityHint("Joins the account with this code or link.")
        }
    }

    // MARK: - Actions

    private func submitCode() {
        switch ConnectInput.readPairingField(code) {
        case .none: codeError = ConnectInput.emptyCode
        case .error(let msg): codeError = msg
        case .join(let link):
            codeError = nil
            onJoin(link)
        }
    }

    private func submitName() async {
        switch ConnectInput.readNameField(username) {
        case .none: return
        case .error(let msg):
            nameError = msg
            return
        case .join(let link, let note):
            nameError = nil
            toasts.info(note)
            onJoin(link)
            return
        case .signIn(let name):
            if name != username { username = name }
            await resolve(name)
        }
    }

    private func resolve(_ name: String) async {
        guard let vm, !isResolving else { return }
        await vm.submit(name)
        guard case .resolved(let outcome) = vm.phase else { return }
        switch outcome {
        case .demo(let u, let demoServer):
            if let demoServer {
                do {
                    if demoServer.lifecycle == .up {
                        try await DemoSessionPairer.ensurePaired(
                            username: u,
                            server: demoServer,
                            client: server,
                            store: sessionStore
                        )
                    } else {
                        await sessionStore.setDemoSession(
                            DemoSessionRecord(username: u, server: demoServer)
                        )
                    }
                } catch {
                    demoPairError = "The demo server is online, but this device couldn't create a paired session. Try again."
                    return
                }
            }
            onDemo(u, demoServer)
        case .realAccount(let resolution):
            onRealAccount(resolution)
        case .unknown:
            break
        }
    }

    // MARK: - Derived view state

    private var isResolving: Bool {
        if case .resolving = vm?.phase { return true }
        return false
    }

    private var showUnknownState: Bool {
        if case .resolved(.unknown) = vm?.phase { return true }
        return false
    }

    private var nameHelper: String? {
        if let demoPairError { return demoPairError }
        switch vm?.phase {
        case .resolving: return "Checking…"
        case .failed(let msg): return msg
        default: return "The name you picked when you made the account."
        }
    }

    @ViewBuilder
    private func unknownState(_ c: FSColors) -> some View {
        FSCard {
            HStack(alignment: .top, spacing: FS.space.s2) {
                Image(systemName: "magnifyingglass")
                    .foregroundColor(c.textMuted)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 4) {
                    Text("No Flagship account by that name")
                        .font(FS.font.bodySm())
                        .foregroundColor(c.text)
                    Text("Check the spelling, or go back and create a new account.")
                        .font(FS.font.caption())
                        .foregroundColor(c.textMuted)
                }
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("join-unknown")
    }
}
