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
                        onDemoActivate: { username, _, demoServer in
                            // Plan A — when the Worker returned a
                            // demoServer block, render ONE real device
                            // backed by the Hetzner VPS. Otherwise
                            // fall back to the legacy 3-fixture path
                            // so already-shipped binaries / reviewers
                            // without a live VPS still work.
                            DemoFixtures.activate(
                                app,
                                username: username,
                                demoServer: demoServer
                            )
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
                    RecoverFromWelcomeContainer(
                        onComplete: { choice, seed in
                            completeRecoveryPair(choice: choice, recoveredSeed: seed)
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
    fileprivate func completeRecoveryPair(choice: RecoveryChoice, recoveredSeed: SymmetricKey) {
        // Best-effort: stash the seed under a known key in memory so a
        // follow-up commit can install it. We deliberately do NOT
        // serialize it here.
        _ = recoveredSeed
        _ = choice
        // Username from the recovery envelope's claim — not yet
        // surfaced in this flow. Use a placeholder until B4 lands the
        // /devices lookup that resolves the user's actual username.
        app.completeOnboarding(username: "recovered-user", pods: [])
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
