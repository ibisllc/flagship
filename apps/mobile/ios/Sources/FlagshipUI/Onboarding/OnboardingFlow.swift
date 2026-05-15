import SwiftUI
import FlagshipCore
import FlagshipAPI

/// Onboarding stack presented as a fullScreenCover over the RootShell
/// when AppState.isPaired == false.
///
///   Welcome
///     ├─ Create your account → ChooseUsername → CreateServer
///     │     ├─ real flow:  mintInstallBlob + relay deliver
///     │     │              → pod lands in AppState with status=.pending
///     │     │              → PendingPodWatcher polls install-events
///     │     │                until the freshly-booted box phones home,
///     │     │                then flips status to .online.
///     │     ├─ demo skip:   "pretend it's already running" — pod
///     │     │              lands as .online with no real provisioning
///     │     └─ test-account: DemoFixtures.activate (3 sample pods)
///     └─ I already have an account → RecoverFromWelcomeScreen
///           (WebAuthn-PRF recovery via the user's passkey →
///           PostRecoveryChoice: Keep both / Replace lost / Wipe)
///           — wired in B3. B1 just lays the path entry.
public struct OnboardingFlow: View {
    @Environment(AppState.self) private var app
    @State private var path: [OnboardingRoute] = []

    public init() {}

    public var body: some View {
        NavigationStack(path: $path) {
            WelcomeScreen(
                onCreate:   { path.append(.chooseUsername) },
                onExisting: { path.append(.recoverFromWelcome) }
            )
            .navigationDestination(for: OnboardingRoute.self) { route in
                switch route {
                case .chooseUsername:
                    ChooseUsernameScreen(
                        onContinue: { username in
                            path.append(.createServer(username: username))
                        },
                        onDemoActivate: { username, _ in
                            DemoFixtures.activate(app, username: username)
                        }
                    )
                case .createServer(let username):
                    OnboardingCreateServer(
                        username: username,
                        onDelivered: { name, description, serverDomain, serial in
                            completePendingPair(
                                username: username,
                                name: name,
                                description: description,
                                serverDomain: serverDomain,
                                serial: serial
                            )
                        },
                        onSkipDemo: { name, description in
                            completeOnlinePair(
                                username: username,
                                name: name,
                                description: description
                            )
                        }
                    )
                case .recoverFromWelcome:
                    // Placeholder until B3 lands the real WebAuthn-PRF
                    // recovery flow. The current copy makes the user-
                    // intent explicit (the dropped PodPairScreen tried
                    // to imply you could "claim" someone else's pod —
                    // you can't; you can only recover your own account).
                    RecoveryFromWelcomeStub(onCancel: { path.removeLast() })
                }
            }
        }
    }

    // MARK: - State writes

    /// Real-flow completion. After the QR-relay deliver succeeds, the
    /// CreateServerViewModel has minted + delivered the InstallBlob;
    /// the freshly-flashed box hasn't booted yet. Add the pod with
    /// status=.pending + auth-code serial recorded. PendingPodWatcher
    /// (spawned by RootShell) polls /api/install-events/<serial>
    /// until `ready` arrives, then flips status to .online.
    fileprivate func completePendingPair(
        username: String, name: String, description: String,
        serverDomain: String, serial: String
    ) {
        let label = name.isEmpty ? "Home" : name
        let pod = PodInfo(
            podId: "pod-\(UUID().uuidString.prefix(6).lowercased())",
            name: label,
            description: description.isEmpty ? nil : description,
            fqdn: serverDomain,
            status: .pending,
            pendingAuthCodeSerial: serial.isEmpty ? nil : serial
        )
        app.completeOnboarding(username: username, pods: [pod])
    }

    /// Demo-skip completion ("pretend it's already running") and the
    /// PodPair stub. No real pod; show one as online so the rest of
    /// the surfaces have something to render.
    fileprivate func completeOnlinePair(username: String, name: String, description: String) {
        let label = name.isEmpty ? "Home" : name
        let slug = SlugUtil.slugify(label)
        let pod = PodInfo(
            podId: "home",
            name: label,
            description: description.isEmpty ? nil : description,
            fqdn: "\(slug).\(username).flagship.services",
            status: .online
        )
        app.completeOnboarding(username: username, pods: [pod])
    }
}

/// Placeholder for the recovery branch from Welcome. B3 replaces
/// this with the real WebAuthn-PRF flow + PostRecoveryChoiceScreen.
/// Kept here so the navigation graph compiles after the PodPair
/// deletion lands; production traffic doesn't reach this view until
/// the user runs an iOS build where B1 is the head — by then B3
/// is on top.
private struct RecoveryFromWelcomeStub: View {
    @Environment(\.colorScheme) private var scheme
    var onCancel: () -> Void = {}
    var body: some View {
        let c = FSColors.scheme(scheme)
        VStack(alignment: .leading, spacing: FS.space.s4) {
            Spacer().frame(height: FS.space.s12)
            Text("Recover your account").font(FS.font.h2()).foregroundColor(c.text)
            Text("Authenticate with your passkey to bring this device into your existing Flagship account. You can choose whether to keep your other devices working or replace a lost one.")
                .font(FS.font.body()).foregroundColor(c.textMuted)
            Spacer()
            FSGhostButton("Back", block: true, action: onCancel)
            Spacer().frame(height: FS.space.s8)
        }
        .padding(.horizontal, FS.space.s6)
        .background(c.bg.ignoresSafeArea())
        .navigationTitle("Recover")
        .navigationBarTitleDisplayMode(.inline)
    }
}

private struct OnboardingCreateServer: View {
    let username: String
    /// Real flow: the QR-relay delivered. Carries the chosen name +
    /// description AND the server-side data the VM produced so the
    /// caller can record the pending pod accurately.
    let onDelivered: (_ name: String, _ description: String, _ serverDomain: String, _ serial: String) -> Void
    /// Demo skip — "Skip — pretend it's already running."
    let onSkipDemo: (_ name: String, _ description: String) -> Void

    @Environment(\.flagshipServerClient) private var serverClient
    @Environment(\.qrRelayClient) private var qrRelay
    @State private var vm: CreateServerViewModel?

    var body: some View {
        ZStack {
            FSColors.scheme(.light).bg.ignoresSafeArea()
            if let vm {
                CreateServerStubScreen(
                    vm: vm,
                    onDelivered: { serverDomain, name, description in
                        let serial = vm.lastDeliveredSerial ?? ""
                        onDelivered(name, description, serverDomain, serial)
                    },
                    onDemoComplete: onSkipDemo,
                    onCancel: {}
                )
            } else { ProgressView() }
        }
        .task {
            if vm == nil {
                vm = CreateServerViewModel(
                    username: username,
                    server: serverClient,
                    relay: qrRelay
                )
            }
        }
    }
}
