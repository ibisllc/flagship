import SwiftUI
import FlagshipCore
import FlagshipAPI

/// Onboarding stack presented as a fullScreenCover over the RootShell
/// when AppState.isPaired == false.
///
///   Welcome
///     ├─ Create your account → ChooseUsername → OpenAccount →
///     │     SecureAccount
///     │     Phase 2 decouples account identity from server
///     │     provisioning: OpenAccount generates the UMK, derives the
///     │     IRK, POSTs a standalone `claimUsername`, and names this
///     │     first device. SecureAccount then nudges a skippable backup
///     │     (cloud pre-selected) before the user lands on Home with
///     │     ZERO servers + an "Add your first server" CTA. Provisioning
///     │     a box (the old CreateServer mint/relay flow, claim removed)
///     │     is now a reusable "Add a server" reachable from Home.
///     └─ I already have an account → JoinUsernameScreen (username-first)
///           → preflight /api/account/resolve (200 always):
///             ├─ demo    → DemoFixtures.activate (attach a new device)
///             ├─ unknown → inline "no account by that name" state
///             └─ single/multi → RealAccountLoginScreen — the Phase-3
///                       state machine (RealAccountLoginViewModel):
///                       no-recovery STATE / single 7-day-grace takeover
///                       / multi 24h-grace + recovery-TOTP takeover →
///                       install UMK → re-pair → label this device
///                       `admin` → completeOnboarding.
public struct OnboardingFlow: View {
    @Environment(AppState.self) private var app
    @Environment(DeepLinker.self) private var linker
    @Environment(\.pairingRelayClient) private var pairingRelay
    @Environment(\.flagshipServerClient) private var server
    @State private var path: [OnboardingRoute] = []

    public init() {}

    public var body: some View {
        NavigationStack(path: $path) {
            WelcomeScreen(
                onCreate:   { path.append(.chooseUsername) },
                onExisting: { path.append(.recoverFromWelcome) }
            )
            .onChange(of: linker.pending) { _, link in consumePairingLink(link) }
            .task(id: linker.pending) { consumePairingLink(linker.pending) }
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
                            // The account/identity now exists. Before
                            // landing in the app, nudge a backup via the
                            // skippable "Secure your account" step. This
                            // is the NEW-account path only.
                            path.append(.secureAccount(username: username))
                        }
                    )
                case .secureAccount(let username):
                    // Skippable backup nudge. Cloud is pre-selected (when
                    // iCloud is available); "Save a backup file" routes to
                    // the existing KeyfileExportScreen; "Skip for now"
                    // confirms then proceeds. Either way we finish
                    // onboarding into the app from here.
                    SecureAccountScreen(
                        username: username,
                        onSecured: {
                            app.completeOnboarding(username: username, pods: [])
                        },
                        onSkip: {
                            app.completeOnboarding(username: username, pods: [])
                        }
                    )
                case .recoverFromWelcome:
                    // Username-first Join. The single preflight branches:
                    // demo attaches a device + opens the sandbox here;
                    // unknown renders inline on the screen; single/multi
                    // push the Phase-3 RealAccountLoginScreen, which runs
                    // the real takeover state machine.
                    JoinUsernameScreen(
                        onDemo: { username, demoServer in
                            DemoFixtures.activate(
                                app,
                                username: username,
                                demoServer: demoServer
                            )
                        },
                        onRealAccount: { resolution in
                            path.append(.realAccountLogin(resolution: resolution))
                        }
                    )
                case .realAccountLogin(let resolution):
                    // Phase 3 — the real single/multi state machine. The
                    // VM runs the Mock passkey-PRF unwrap, installs the
                    // recovered UMK, and initiates the takeover re-pair
                    // (multi attaches the recovery-TOTP / recovery-code
                    // as totpProof). On completion the host records this
                    // device's `admin` label and flips AppState paired.
                    RealAccountLoginScreen(
                        resolution: resolution,
                        onComplete: { username in
                            completeRealAccountLogin(username: username)
                        },
                        onBack: { path.removeLast() }
                    )
                case .joinByPairing(let joinUrl):
                    // Phase 3b — brand-new collaborator joining via QR.
                    // The incoming JoinAccount flow attaches a FRESH
                    // device key + installs the shared UMK into a new
                    // per-profile slot, then we complete onboarding
                    // paired on the joined account.
                    JoinAccountScreen(
                        vm: JoinAccountViewModel(relay: pairingRelay, server: server),
                        initialJoinUrl: joinUrl,
                        onJoined: { profile in
                            completePairingJoin(profile: profile)
                        }
                    )
                }
            }
        }
    }

    /// Observe the linker for a Phase-3b `.joinAccount` deeplink while
    /// UNPAIRED and push the incoming join flow.
    private func consumePairingLink(_ link: DeepLink?) {
        guard case .joinAccount(let sid, let pk) = link else { return }
        let joinUrl = "https://flagshipserver.com/join?sid=\(sid)&pk=\(pk)"
        if path.last != .joinByPairing(joinUrl: joinUrl) {
            path.append(.joinByPairing(joinUrl: joinUrl))
        }
        _ = linker.consume()
    }

    // MARK: - State writes

    /// Phase 3 — completion of the real single/multi takeover. By the
    /// time we're here `RealAccountLoginViewModel` has ALREADY:
    ///   - run the Mock passkey-PRF unwrap of the cloud UMK,
    ///   - installed the recovered UMK via `Keystore.installUMK` (the
    ///     stub `completeRecoveryPair` left it on the floor — retired),
    ///   - initiated the takeover re-pair (multi with `totpProof`).
    /// So the host's only job is to record this device's **`admin`**
    /// label (the no-lockout / `ukey.*`-reach primitive) and flip
    /// AppState to paired with the resolved username (pods hydrate from
    /// /devices later — Phase 4). The "recovered-user" placeholder is
    /// gone; the username comes from the preflight throughout.
    /// Phase 3b — completion of a brand-new collaborator pairing-join.
    /// The JoinAccountViewModel has already minted a fresh device key,
    /// verified the admin's admit, installed the shared UMK into THIS
    /// account's per-profile slot, and POSTed `/devices/admit`. The host
    /// records the new (quarantined, non-admin) profile + flips paired.
    fileprivate func completePairingJoin(profile: JoinAccountViewModel.AdmittedProfile) {
        app.completeOnboarding(username: profile.cloudName, pods: [])
        app.addProfile(
            Profile(
                cloudName: profile.cloudName,
                deviceLabel: profile.deviceLabel
            ),
            setActive: true
        )
    }

    fileprivate func completeRealAccountLogin(username: String) {
        app.completeOnboarding(username: username, pods: [])
        // Label this device `admin`. A credential-proven takeover makes
        // the new device the admin (reach = ukey.*); record it locally
        // so the profile + any device-label surface reflects it.
        // completeOnboarding upserts the profile by cloudName, so this
        // refresh sets the label without duplicating the entry.
        app.addProfile(
            Profile(
                cloudName: username,
                deviceLabel: RealAccountLoginViewModel.adminDeviceLabel,
                createdAt: app.activeProfile?.createdAt ?? Date()
            ),
            setActive: true
        )
    }
}
