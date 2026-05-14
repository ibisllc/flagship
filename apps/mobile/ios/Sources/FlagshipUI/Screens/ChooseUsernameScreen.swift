import SwiftUI
import FlagshipAPI

/// D.2.2 — ChooseUsernameScreen.
///
/// Live availability check (debounced 350 ms) against the Worker's
/// `/api/users/check`. The response carries an optional `testAccount`
/// block; when present the typed username unlocks a sandboxed demo
/// flow without hitting the real claim path. The list of test-account
/// usernames LIVES OFF THE OPEN SOURCE (Worker env secret); mobile
/// never bakes them in.
public struct ChooseUsernameScreen: View {
    @Environment(\.flagshipServerClient) private var server
    @State private var username: String = ""
    @State private var vm: ChooseUsernameViewModel?

    /// Real-flow continuation. Called with the validated username
    /// when the CTA's tapped and the typed name is NOT a test
    /// account.
    var onContinue: (String) -> Void
    /// Sandbox continuation. Called with the typed username + the
    /// metadata the Worker returned when the typed name matches the
    /// off-git test-account list. The host (OnboardingFlow) then
    /// runs DemoFixtures.activate(...).
    var onDemoActivate: (String, TestAccountMeta) -> Void

    public init(
        onContinue: @escaping (String) -> Void = { _ in },
        onDemoActivate: @escaping (String, TestAccountMeta) -> Void = { _, _ in }
    ) {
        self.onContinue = onContinue
        self.onDemoActivate = onDemoActivate
    }

    public var body: some View {
        FSScreen {
            VStack(alignment: .leading, spacing: FS.space.s6) {
                Spacer().frame(height: FS.space.s12)
                Text("Pick a username.").font(FS.font.h2())
                FSColorReader { c in
                    Text("This is permanent. It becomes the middle of your server's domain (e.g. home.<username>.flagship.services).")
                        .font(FS.font.body()).foregroundColor(c.textMuted)
                }
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
                }
                .task(id: username) {
                    await vm?.evaluate(username)
                }
                Spacer()
                FSPrimaryButton(
                    ctaLabel,
                    enabled: vm?.status.allowsContinue ?? false,
                    block: true,
                    large: true
                ) {
                    guard let vm else { return }
                    if let meta = vm.status.testAccountMeta {
                        onDemoActivate(username, meta)
                    } else {
                        onContinue(username)
                    }
                }
            }
            .padding(.horizontal, FS.space.s6)
            .padding(.bottom, FS.space.s8)
        }
        .task {
            if vm == nil { vm = ChooseUsernameViewModel(server: server) }
        }
    }

    private var ctaLabel: String {
        if let meta = vm?.status.testAccountMeta { return "Enter \(meta.display)" }
        return "Continue"
    }

    private var helperText: String? {
        guard let status = vm?.status else { return "Letters and digits only. 1–32 characters." }
        switch status {
        case .empty:                     return "Letters and digits only. 1–32 characters."
        case .invalid:                   return nil
        case .checking:                  return "Checking…"
        case .available:                 return "Available."
        case .networkFallbackAvailable:  return "Looks OK — we'll confirm when you continue."
        case .taken:                     return nil
        case .testAccount(let meta):
            return "Sandboxed test mode (\(meta.display)). State resets every \(meta.ttlHours) h."
        }
    }

    private var errorText: String? {
        guard let status = vm?.status else { return nil }
        switch status {
        case .invalid(let reason): return reason
        case .taken:               return "Already taken."
        default:                   return nil
        }
    }
}
