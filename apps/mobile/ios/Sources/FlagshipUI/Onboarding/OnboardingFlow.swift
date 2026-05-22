import SwiftUI
import CryptoKit
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
///     │     └─ demo skip:   "pretend it's already running" — pod
///     │                    lands as .online with no real provisioning
///     │       (Create is create-only — demo entry moved to Join.)
///     └─ I already have an account → JoinUsernameScreen (username-first)
///           → preflight /api/account/resolve (200 always):
///             ├─ demo    → DemoFixtures.activate (attach a new device)
///             ├─ unknown → inline "no account by that name" state
///             └─ single/multi → RecoverFromWelcomeContainer
///                       (WebAuthn-PRF recovery → PostRecoveryChoice).
///           Phase 3 replaces the single/multi leaf with the
///           LoginViewModel state machine.
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
                    // Create is create-only now. Demo + device-capability
                    // activation moved OUT of the create path and into
                    // Join (username-first preflight) per the login
                    // redesign — typing a demo username under "I already
                    // have an account" is the only demo entry.
                    ChooseUsernameScreen(
                        onContinue: { username in
                            path.append(.createServer(username: username))
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
                    // Username-first Join. The single preflight branches:
                    // demo attaches a device + opens the sandbox here;
                    // unknown renders inline on the screen; single/multi
                    // push the existing passkey container (Phase 3
                    // replaces that with the LoginViewModel state machine).
                    JoinUsernameScreen(
                        onDemo: { username, demoServer in
                            DemoFixtures.activate(
                                app,
                                username: username,
                                demoServer: demoServer
                            )
                        },
                        onRealAccount: { resolution in
                            path.append(.recoverWithPasskey(username: resolution.username))
                        }
                    )
                case .recoverWithPasskey(let username):
                    RecoverFromWelcomeContainer(
                        onComplete: { choice, seed in
                            completeRecoveryPair(
                                username: username,
                                choice: choice,
                                recoveredSeed: seed
                            )
                        },
                        onBack: { path.removeLast() }
                    )
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

    /// Post-recovery completion. The WebAuthn-PRF flow returned a
    /// recovered UMK seed and the user picked a RecoveryChoice. v1
    /// behaviour:
    ///   - .keepBothDevices  → install UMK locally; mark paired;
    ///                         pods will appear once /api/users/:u/pods
    ///                         (or a /devices flow) is consulted.
    ///   - .replaceLostDevice → same install, but B7 layers an IRK
    ///                         rotation on top. The rotation isn't in
    ///                         this commit — TODO routes through here
    ///                         until B7 wires the /re-pair POST.
    ///   - .wipeAndRestart    → blocked at the screen layer in v1.
    ///
    /// **TODO (cross-commit):** `Keystore.installUMK(seed:)` doesn't
    /// exist yet; B3 lands the recovery navigation but the actual
    /// Secure Enclave install happens in a follow-up. For now we mark
    /// the user paired with an empty pod list so the shell renders.
    fileprivate func completeRecoveryPair(
        username: String,
        choice: RecoveryChoice,
        recoveredSeed: SymmetricKey
    ) {
        // Best-effort: stash the seed under a known key in memory so a
        // follow-up commit can install it. We deliberately do NOT
        // serialize it here.
        _ = recoveredSeed
        _ = choice
        // The username now comes from the login preflight (resolved on
        // the username-first Join screen), retiring the old
        // "recovered-user" placeholder. The real Keystore.installUMK +
        // /devices pod hydration land in Phase 3.
        app.completeOnboarding(username: username, pods: [])
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
