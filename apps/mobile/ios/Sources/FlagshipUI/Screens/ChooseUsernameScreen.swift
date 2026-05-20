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
    /// Sandbox continuation. Called with the typed username, the
    /// test-account metadata the Worker returned, and (Plan A) the
    /// optional `demoServer` block describing a live Hetzner VPS when
    /// the matched username has one. The host (OnboardingFlow) then
    /// runs DemoFixtures.activate(..., demoServer:) — when the block
    /// is present the demo renders ONE live device; otherwise the
    /// legacy 3-fixture path runs.
    var onDemoActivate: (String, TestAccountMeta, DemoServerBlock?) -> Void

    public init(
        onContinue: @escaping (String) -> Void = { _ in },
        onDemoActivate: @escaping (String, TestAccountMeta, DemoServerBlock?) -> Void = { _, _, _ in }
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
                        // Plan A — when the Worker also returned a
                        // `demoServer` block, pass it through so
                        // DemoFixtures renders the one-live-device
                        // path. Nil ⇒ legacy 3-fixture path.
                        onDemoActivate(username, meta, vm.status.demoServerBlock)
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
        case .testAccount(let meta, let demoServer):
            if let demoServer {
                // Plan A — surface the live state so the user knows
                // whether tapping connect will provision (none) or
                // open straight away (up).
                switch demoServer.lifecycle {
                case .up:
                    return "Live demo (\(meta.display)) — server is up. Idle reset every \(demoServer.ttlIdleMinutes) min."
                case .provisioning:
                    return "Live demo (\(meta.display)) — server is starting. Idle reset every \(demoServer.ttlIdleMinutes) min."
                case .none:
                    return "Live demo (\(meta.display)) — connect spins up a real server. Idle reset every \(demoServer.ttlIdleMinutes) min."
                }
            }
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
