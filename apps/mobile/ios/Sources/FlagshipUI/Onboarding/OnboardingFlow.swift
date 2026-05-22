import SwiftUI
import CryptoKit
import FlagshipCore
import FlagshipAPI

/// Onboarding stack presented as a fullScreenCover over the RootShell
/// when AppState.isPaired == false.
///
///   Welcome
///     ├─ Create your account → ChooseUsername → OpenAccount
///     │     Phase 2 decouples account identity from server
///     │     provisioning: OpenAccount generates the UMK, derives the
///     │     IRK, POSTs a standalone `claimUsername`, and names this
///     │     first device. The user then lands on Home with ZERO
///     │     servers + an "Add your first server" CTA. Provisioning a
///     │     box (the old CreateServer mint/relay flow, claim removed)
///     │     is now a reusable "Add a server" reachable from Home.
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
                    // have an account" is the only demo entry. Continuing
                    // pushes the Phase-2 Open-account step (NOT
                    // server-mint): account identity is created on its
                    // own, server provisioning is a later, optional act.
                    ChooseUsernameScreen(
                        onContinue: { username in
                            path.append(.openAccount(username: username))
                        }
                    )
                case .openAccount(let username):
                    // Phase 2 — open the account: generate the UMK,
                    // derive the IRK, POST the standalone username claim,
                    // and name this first device. Land on Home with ZERO
                    // servers. Provisioning a box is now "Add a server"
                    // from Home (CreateServerContainer in HomeTab), with
                    // the claim removed from mintInstallBlob.
                    OpenAccountScreen(
                        username: username,
                        onOpened: { _ in
                            app.completeOnboarding(username: username, pods: [])
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
}
