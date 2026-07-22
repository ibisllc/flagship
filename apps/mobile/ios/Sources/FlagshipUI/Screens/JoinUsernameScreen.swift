import SwiftUI
import FlagshipAPI
import FlagshipCore

/// Username-first **Join** entry — the "I already have an account" flow.
///
/// This replaces the old `assertAny()`-first recovery container as the
/// FIRST screen of Join. The user types a bare username; on submit we
/// run a single preflight (`/api/account/resolve`, 200 always) and
/// branch:
///   - demo        → host attaches a new device + opens the sandbox.
///   - unknown     → a clean "No Flagship account by that name" STATE
///                   rendered inline (NOT an error card, NOT a 404).
///   - single/multi → host hands off to the existing passkey recovery
///                   flow (Phase 3 replaces this).
///
/// See docs/login-and-account-redesign.md.
public struct JoinUsernameScreen: View {
    @Environment(\.flagshipServerClient) private var server
    @Environment(\.sessionStore) private var sessionStore
    @Environment(\.colorScheme) private var scheme
    @State private var username: String = ""
    @State private var vm: LoginViewModel?
    @State private var demoPairError: String?

    /// Demo branch — the typed name resolved to `kind:"demo"`. Carries
    /// the username + the optional server-supplied demoServer block.
    var onDemo: (_ username: String, _ demoServer: DemoServerBlock?) -> Void
    /// Real-account branch — the typed name resolved to single/multi.
    /// Carries the full preflight so the downstream flow doesn't
    /// re-resolve.
    var onRealAccount: (_ resolution: AccountResolution) -> Void

    public init(
        onDemo: @escaping (_ username: String, _ demoServer: DemoServerBlock?) -> Void = { _, _ in },
        onRealAccount: @escaping (_ resolution: AccountResolution) -> Void = { _ in }
    ) {
        self.onDemo = onDemo
        self.onRealAccount = onRealAccount
    }

    public var body: some View {
        let c = FSColors.scheme(scheme)
        FSScreen {
            VStack(alignment: .leading, spacing: FS.space.s6) {
                Spacer().frame(height: FS.space.s12)
                Text("Welcome back.").font(FS.font.h2())
                Text("Enter your username to bring this device into your existing Flagship account.")
                    .font(FS.font.body())
                    .foregroundColor(c.textMuted)
                FSField(
                    value: $username,
                    label: "Username",
                    placeholder: "harry",
                    helper: helperText,
                    error: errorText
                )
                .keyboardType(.asciiCapable)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled(true)
                .onChange(of: username) { _, newValue in
                    let lower = newValue.lowercased()
                    if lower != newValue { username = lower }
                    // Editing after viewing the unknown / failed state
                    // returns to idle so the CTA re-arms.
                    if let vm, !isResolving {
                        if case .resolved = vm.phase { vm.reset() }
                        if case .failed = vm.phase { vm.reset() }
                    }
                    demoPairError = nil
                }

                if showUnknownState {
                    unknownState(c: c)
                }

                Spacer()

                FSPrimaryButton(
                    ctaLabel,
                    enabled: (vm?.canSubmit(username) ?? false) && !isResolving,
                    block: true,
                    large: true
                ) {
                    Task { await resolve() }
                }
                .accessibilityIdentifier("join-continue")
            }
            .padding(.horizontal, FS.space.s6)
            .padding(.bottom, FS.space.s8)
        }
        .navigationTitle("Sign in")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            if vm == nil { vm = LoginViewModel(server: server) }
        }
    }

    // MARK: - Resolve + dispatch

    private func resolve() async {
        guard let vm else { return }
        await vm.submit(username)
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
            // Stay on this screen; the inline unknown state renders.
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

    private var ctaLabel: String {
        if isResolving { return "Checking…" }
        return "Continue"
    }

    private var helperText: String? {
        if let demoPairError { return demoPairError }
        switch vm?.phase {
        case .resolving: return "Checking…"
        case .failed(let msg): return msg
        default: return "Letters and digits only."
        }
    }

    private var errorText: String? {
        // The unknown state is rendered as its own block (not a field
        // error) so it reads as guidance, not a validation failure.
        nil
    }

    @ViewBuilder
    private func unknownState(c: FSColors) -> some View {
        FSCard {
            HStack(alignment: .top, spacing: FS.space.s2) {
                Image(systemName: "magnifyingglass")
                    .foregroundColor(c.textMuted)
                VStack(alignment: .leading, spacing: 4) {
                    Text("No Flagship account by that name")
                        .font(FS.font.bodySm())
                        .foregroundColor(c.text)
                    Text("Double-check the spelling, or create a new account from the previous screen.")
                        .font(FS.font.caption())
                        .foregroundColor(c.textMuted)
                }
            }
        }
        .accessibilityIdentifier("join-unknown")
    }
}
