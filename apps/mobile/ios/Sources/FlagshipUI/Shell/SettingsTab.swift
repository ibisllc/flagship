import SwiftUI
import CryptoKit
import Flagship
import FlagshipCore
import FlagshipAPI

public struct SettingsTab: View {
    @Environment(\.screensClient) private var client
    @Environment(\.flagshipServerClient) private var server
    @Environment(\.pushRegistrar) private var pushRegistrar
    @Environment(AppState.self) private var app
    @Environment(DeveloperSettings.self) private var dev
    @Environment(DeepLinker.self) private var linker
    @Environment(PrivacySettings.self) private var privacy

    @State private var path: [SettingsRoute] = []
    @State private var vm: SettingsViewModel?
    @State private var replaceVm: ReplaceDeviceViewModel?
    @State private var replaceToast: String?
    @State private var wipeVm: WipeRestartViewModel?
    @State private var wipeToast: String?

    public init() {}

    public var body: some View {
        NavigationStack(path: $path) {
            content
                .navigationDestination(for: SettingsRoute.self) { route in
                    settingsDestination(for: route)
                }
        }
        .onChange(of: linker.pending) { _, link in consume(link) }
        .task(id: linker.pending) { consume(linker.pending) }
    }

    /// Consume a DeepLink that targets the Settings tab. Today we
    /// only handle `.recoverySetup` (Home → "Set it up" nudge); the
    /// other links are handled by the tabs that actually own them.
    private func consume(_ link: DeepLink?) {
        guard let link else { return }
        switch link {
        case .recoverySetup:
            if path.last != .recovery {
                path.append(.recovery)
            }
            _ = linker.consume()
        default:
            break
        }
    }

    @ViewBuilder
    private var content: some View {
        ZStack {
            FSColors.scheme(.light).bg.ignoresSafeArea()
            if let vm {
                SettingsScreen(
                    username: app.currentUser ?? "",
                    tier: vm.tier,
                    controlDevices: vm.controlDevices,
                    trustedDevices: vm.trustedDevices,
                    showDeveloper: dev.unlocked,
                    onAddControlDevice: { path.append(.addControlDevice) },
                    onRevokeDevice: { session in Task { await vm.revoke(session) } },
                    onDisconnectTrustedDevice: { device in await vm.disconnect(device) },
                    onSignOut: {
                        Task { @MainActor in
                            await pushRegistrar?.revoke()
                            app.signOut()
                        }
                    },
                    onOpenProviders: { path.append(.providers) },
                    onOpenRecovery: { path.append(.recovery) },
                    onOpenProfiles: { path.append(.profiles) },
                    onOpenAbout: { path.append(.about) },
                    onOpenDeveloper: { path.append(.developer) },
                    onOpenPrivacy: { path.append(.privacy) },
                    onRefresh: { await vm.load() },
                    onRemoveFromAccount: {
                        // B6a — full self-revoke: drop push token on
                        // .com, wipe Keystore (UMK / IRK / wrapped
                        // UMK / push X25519 / pushTokenId), and sign
                        // out. We tolerate the push revoke failing
                        // (network down, server already lost track) —
                        // local wipe still proceeds because the
                        // server's GC will eventually catch the
                        // orphan via E7's detector.
                        await pushRegistrar?.revoke()
                        await MainActor.run {
                            Keystore.wipe()
                            app.signOut()
                        }
                    },
                    onReplaceDevice: {
                        // B7 — fire the ReplaceDeviceViewModel. We
                        // lazily construct the VM here (rather than
                        // .task above) so the SettingsTab init stays
                        // cheap.
                        if replaceVm == nil {
                            replaceVm = ReplaceDeviceViewModel(
                                server: server,
                                username: { [app] in app.currentUser }
                            )
                        }
                        // Reuse the most recent ETag we captured from
                        // the trusted-devices fetch (vm.devicesEtag).
                        await replaceVm?.initiate(currentEtag: vm.devicesEtag)
                        // Surface the outcome as a toast — the UI
                        // doesn't yet have a dedicated pending-status
                        // card; that's a v1.1 follow-up.
                        switch replaceVm?.phase {
                        case .pending(let completesAt):
                            let hours = max(1, (completesAt - Int64(Date().timeIntervalSince1970 * 1000)) / 3_600_000)
                            replaceToast = "Replace initiated. Takes effect in ~\(hours)h unless another device objects."
                        case .failed(let msg):
                            replaceToast = msg
                        default:
                            replaceToast = nil
                        }
                    },
                    onWipeRestart: {
                        // E2/E3 — drive the wipe ceremony. Uses
                        // MockWebAuthnProvider by default; a future
                        // commit can swap in a live ASAuthorizationController
                        // wrapper without touching the VM.
                        if wipeVm == nil {
                            wipeVm = WipeRestartViewModel(
                                server: server,
                                username: { [app] in app.currentUser }
                            )
                        }
                        await wipeVm?.run(currentEtag: vm.devicesEtag)
                        switch wipeVm?.phase {
                        case .completed:
                            wipeToast = "Done. All other devices are now disconnected. Re-pair them on next open."
                            // Drop to Welcome — the user just rotated
                            // identity; the in-memory session is stale.
                            await pushRegistrar?.revoke()
                            app.signOut()
                        case .failed(let msg):
                            wipeToast = msg
                        default:
                            wipeToast = nil
                        }
                    },
                    hasCloudRecovery: app.hasCloudRecovery
                )
                .alert(
                    "Replace device",
                    isPresented: Binding(
                        get: { replaceToast != nil },
                        set: { if !$0 { replaceToast = nil } }
                    )
                ) {
                    Button("OK") { replaceToast = nil }
                } message: {
                    Text(replaceToast ?? "")
                }
                .alert(
                    "Wipe & restart",
                    isPresented: Binding(
                        get: { wipeToast != nil },
                        set: { if !$0 { wipeToast = nil } }
                    )
                ) {
                    Button("OK") { wipeToast = nil }
                } message: {
                    Text(wipeToast ?? "")
                }
            } else {
                ProgressView()
            }
        }
        .task {
            if vm == nil {
                vm = SettingsViewModel(
                    client: client,
                    server: server,
                    username: { [app] in app.currentUser }
                )
            }
            if case .idle = vm?.tier { await vm?.load() }
        }
    }

    @ViewBuilder
    private func settingsDestination(for route: SettingsRoute) -> some View {
        switch route {
        case .providers:
            ProvidersStub()
        case .recovery:
            RecoveryContainer(onShowPostRecoveryProgress: { path.append(.postRecoveryProgress) })
        case .postRecoveryProgress:
            PostRecoveryContainer()
        case .about:
            AboutStub()
        case .addControlDevice:
            AddControlDeviceScreen()
        case .developer:
            DeveloperScreen(dev: dev, onWipeIdentity: {
                Task { @MainActor in
                    await pushRegistrar?.revoke()
                    app.signOut()
                }
            })
        case .privacy:
            PrivacyScreen()
        case .profiles:
            ProfilesScreen(
                profiles: app.profiles,
                activeCloudName: app.activeProfileCloudName,
                onSelect: { name in app.setActiveProfile(name) },
                onSetUpNew: {
                    // No active profile + the user wants to set one up:
                    // sign the session out so the OnboardingFlow takes
                    // over. Cheaper than threading a dedicated
                    // "Add cloud" route through this commit; that's the
                    // v2 follow-up.
                    Task { @MainActor in
                        app.signOut()
                    }
                }
            )
        }
    }
}

/// B12 — privacy preferences. Today the single toggle is biometric
/// at launch; gated behind a Face ID confirmation when turning ON
/// (matches iOS Settings.app conventions for security-relevant flips).
/// Turning OFF doesn't gate — the user is presumed authorized, the
/// alternative would be an infinite "Enter biometrics to remove
/// biometrics" loop.
struct PrivacyScreen: View {
    @Environment(\.colorScheme) private var scheme
    @Environment(PrivacySettings.self) private var privacy
    @Environment(AppState.self) private var app
    @State private var pendingError: String?

    var body: some View {
        let c = FSColors.scheme(scheme)
        ScrollView {
            VStack(alignment: .leading, spacing: FS.space.s6) {
                Text("Lock with Face ID")
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundColor(c.text)
                Toggle(isOn: Binding(
                    get: { privacy.requireBiometricAtLaunch },
                    set: { newValue in toggle(to: newValue) },
                )) {
                    Text("Require Face ID when the app opens")
                        .foregroundColor(c.text)
                }
                .tint(c.primary)
                Text("When on, Flagship asks for Face ID each time the app launches or returns from the background. Apps stay running, your pods stay reachable — this just controls who can see and tap.")
                    .font(FS.font.bodySm())
                    .foregroundColor(c.textMuted)
                if let msg = pendingError {
                    Text(msg).font(FS.font.caption()).foregroundColor(c.danger)
                }
                Spacer()
            }
            .padding(FS.space.s6)
        }
        .navigationTitle("Privacy")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func toggle(to newValue: Bool) {
        pendingError = nil
        if newValue {
            // Enabling — challenge once so a malicious bystander
            // can't silently enable lock-and-trap. On success, persist
            // the preference + sync to AppState.
            Task {
                do {
                    try await BiometricGate().evaluate(reason: "Enable Face ID lock")
                    privacy.requireBiometricAtLaunch = true
                    app.requireBiometricAtLaunch = true
                    // Already past auth → stay unlocked this session.
                    app.markUnlocked()
                } catch {
                    pendingError = "Couldn't enable: \(error.localizedDescription)"
                }
            }
        } else {
            // Disabling doesn't gate — see the docs above.
            privacy.requireBiometricAtLaunch = false
            app.requireBiometricAtLaunch = false
        }
    }
}

struct ProvidersStub: View {
    var body: some View {
        FSCard { Text("LLM provider configuration — coming soon.") }
            .padding(FS.space.s6)
            .navigationTitle("Providers")
            .navigationBarTitleDisplayMode(.inline)
    }
}

struct RecoveryContainer: View {
    @Environment(\.flagshipServerClient) private var serverClient
    @Environment(ToastCenter.self) private var toasts
    @State private var vm: RecoveryViewModel?
    var onShowPostRecoveryProgress: () -> Void = {}

    var body: some View {
        ZStack {
            FSColors.scheme(.light).bg.ignoresSafeArea()
            if let vm {
                RecoveryScreen(
                    vm: vm,
                    onRunSetup: {
                        // Fresh UMK seed for the demo. Real call site
                        // passes the live UMK derived from Keystore.
                        let seed = SymmetricKey(size: .bits256)
                        await vm.setup(umkSeed: seed)
                        if case .registered = vm.phase {
                            toasts.success("Recovery is active.")
                        }
                    },
                    onRunRecover: {
                        let recovered = await vm.recover()
                        if recovered != nil {
                            toasts.success("UMK recovered.")
                        }
                    },
                    onShowReattachProgress: onShowPostRecoveryProgress
                )
            } else { ProgressView() }
        }
        .task {
            if vm == nil {
                // Wire the platform-backed provider on device; the
                // simulator path falls back to a stable HKDF derivation.
                vm = RecoveryViewModel(
                    client: serverClient,
                    webAuthn: PlatformWebAuthnProvider()
                )
            }
        }
    }
}

/// Embeds the post-recovery polling view-model + screen. Lives in the
/// shell so the SettingsTab can navigate to it without leaking the
/// screens-client dependency into Routes.swift (which is FlagshipCore,
/// and FlagshipCore can't import FlagshipAPI).
struct PostRecoveryContainer: View {
    @Environment(\.screensClient) private var client
    @State private var vm: PostRecoveryViewModel?

    var body: some View {
        ZStack {
            FSColors.scheme(.light).bg.ignoresSafeArea()
            if let vm {
                PostRecoveryScreen(vm: vm)
            } else { ProgressView() }
        }
        .task {
            if vm == nil { vm = PostRecoveryViewModel(client: client) }
        }
    }
}

struct AboutStub: View {
    @Environment(\.colorScheme) private var scheme
    @Environment(DeveloperSettings.self) private var dev
    @Environment(ToastCenter.self) private var toasts
    @State private var tapCount: Int = 0

    var body: some View {
        let c = FSColors.scheme(scheme)
        ScrollView {
            VStack(alignment: .leading, spacing: FS.space.s4) {
                Text("Flagship").font(FS.font.h2()).foregroundColor(c.text)
                Text("Your stuff, on your hardware.").font(FS.font.body()).foregroundColor(c.textMuted)
                FSCard {
                    VStack(alignment: .leading, spacing: FS.space.s3) {
                        labeled("Version", "0.1.0 (dev)", c: c)
                            .contentShape(Rectangle())
                            .onTapGesture {
                                tapCount += 1
                                if tapCount >= 3 && !dev.unlocked {
                                    dev.unlocked = true
                                    toasts.success("Developer menu unlocked.")
                                }
                            }
                        labeled("License", "BUSL-1.1 → Apache 2.0 (2030)", c: c)
                        labeled("Source", "github.com/ibisllc/flagship", c: c, mono: true)
                    }
                }
                if dev.unlocked {
                    Text("Developer menu is in Settings.")
                        .font(FS.font.caption())
                        .foregroundColor(c.textMuted)
                }
            }
            .padding(FS.space.s6)
        }
        .navigationTitle("About")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func labeled(_ label: String, _ value: String, c: FSColors, mono: Bool = false) -> some View {
        HStack {
            Text(label).foregroundColor(c.textMuted)
            Spacer()
            Text(value).font(mono ? FS.font.mono() : FS.font.body()).foregroundColor(c.text)
        }
    }
}
