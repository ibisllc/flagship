import SwiftUI
import CryptoKit
import Flagship
import FlagshipCore
import FlagshipAPI

public struct SettingsTab: View {
    @Environment(\.screensClient) private var client
    @Environment(\.flagshipServerClient) private var server
    @Environment(\.pairingRelayClient) private var pairingRelay
    @Environment(\.pushRegistrar) private var pushRegistrar
    @Environment(ToastCenter.self) private var toasts
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
    @State private var companionRequestsVm: CompanionRequestsViewModel?
    @State private var pendingCompanionCount: Int = 0

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

    /// Consume a DeepLink that targets the Settings tab. Handles
    /// `.recoverySetup` (Home → "Set it up" nudge) and Phase 3b
    /// `.joinAccount` (a scanned/native-camera pairing link arriving
    /// while the app is already paired — routes into the incoming
    /// add-profile join flow). Other links are handled by their owning
    /// tabs.
    private func consume(_ link: DeepLink?) {
        guard let link else { return }
        switch link {
        case .recoverySetup:
            if path.last != .recovery {
                path.append(.recovery)
            }
            _ = linker.consume()
        case .joinAccount(let sid, let pk):
            // Reconstruct the canonical /join link the JoinAccountViewModel
            // parses (a deeplink can arrive as either the universal-link
            // or custom-scheme form; rebuild the canonical https form).
            let joinUrl = "https://\(PairingQr.joinHost)\(PairingQr.joinPath)?sid=\(sid)&pk=\(pk)"
            if path.last != .joinAccount(joinUrl: joinUrl) {
                path.append(.joinAccount(joinUrl: joinUrl))
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
                    controlDevices: vm.controlDevices,
                    trustedDevices: vm.trustedDevices,
                    // Developer tools are a mock-mode concern: a shipped
                    // live build never surfaces them. The only way in is the
                    // deliberate pre-login 3-tap on the Welcome box, which
                    // flips to mock first.
                    showDeveloper: !dev.useLiveClient,
                    onAddDevice: {
                        // Adding a device hands over the UMK (account master
                        // key) — gate it behind an explicit Face ID before we
                        // even reveal the pairing QR.
                        Task { @MainActor in
                            do {
                                try await BiometricGate().evaluate(
                                    reason: "Add a device that can hold your account key")
                                path.append(.addDevice)
                            } catch {
                                // Cancelled or failed — stay put.
                            }
                        }
                    },
                    onScanPairingCode: { path.append(.scanPairingCode) },
                    onRevokeDevice: { session in Task { await vm.revoke(session) } },
                    onDisconnectTrustedDevice: { device in await vm.disconnect(device) },
                    onLock: {
                        // Tier 1 — LOCK. Re-gate behind Face ID with zero
                        // side effects: no network, the key + session stay
                        // in the Keychain. Re-entry is the BiometricLockScreen.
                        app.lock()
                    },
                    onSignOut: {
                        // Tier 2 — SIGN OUT. Erase this device's local key
                        // material from the Keychain (snoop-hardening at
                        // rest) but DO NOT revoke server-side: the device
                        // stays a valid account member, so signing back in
                        // via passkey recovery restores the SAME IRK and
                        // re-pairs instantly. Deliberately NO pushRegistrar
                        // revoke — that's a server mutation reserved for the
                        // danger-zone eviction below.
                        //
                        // #52 — ACTION-LAYER gate (not just UI): without
                        // cloud recovery this Keychain entry is the ONLY
                        // copy of the identity key, so wiping it orphans
                        // the account. The screen already replaces the
                        // confirm with a route into recovery enrollment;
                        // this guard makes the wipe structurally
                        // unreachable even if some other path fires the
                        // closure. Demo/mock sessions are exempt (they
                        // never wrap a real UMK).
                        guard SignOutPolicy.evaluate(
                            hasCloudRecovery: app.hasCloudRecovery,
                            isDemoAccount: !dev.useLiveClient
                        ) == .allowed else { return }
                        Keystore.wipe()
                        app.signOut()
                    },
                    onOpenProviders: { path.append(.providers) },
                    onOpenAiKeys: { path.append(.aiKeys) },
                    onOpenRecovery: { path.append(.recovery) },
                    onOpenKeyfileBackup: { path.append(.keyfileBackup) },
                    onOpenProfiles: { path.append(.profiles) },
                    onOpenPeerBackup: { path.append(.peerBackup) },
                    onOpenCompanionDock: { path.append(.companionDock) },
                    onOpenCompanionRequests: { path.append(.companionRequests) },
                    pendingCompanionWritesCount: pendingCompanionCount,
                    onOpenAbout: { path.append(.about) },
                    onOpenDeveloper: { path.append(.developer) },
                    onOpenPrivacy: { path.append(.privacy) },
                    onRefresh: { await vm.load() },
                    onRemoveFromAccount: {
                        // Recovery gate (mirrors onSignOut): removing this
                        // device wipes the local key, so without cloud
                        // recovery it would orphan the account. The button
                        // is greyed in that state; this action-layer guard
                        // makes the wipe structurally unreachable even if
                        // some other path fires the closure. Demo/mock
                        // sessions are exempt.
                        guard SignOutPolicy.evaluate(
                            hasCloudRecovery: app.hasCloudRecovery,
                            isDemoAccount: !dev.useLiveClient
                        ) == .allowed else { return }
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
                        // On a successful initiate, push the dedicated
                        // FINALIZE screen (24h grace countdown + Complete).
                        // A failure stays inline as a toast.
                        switch replaceVm?.phase {
                        case .pending(let completesAt):
                            path.append(.replaceDeviceFinalize(completesAt: completesAt))
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
                    hasCloudRecovery: app.hasCloudRecovery,
                    signOutPolicy: SignOutPolicy.evaluate(
                        hasCloudRecovery: app.hasCloudRecovery,
                        isDemoAccount: !dev.useLiveClient
                    ),
                    onRecoveryRequired: {
                        toasts.warning("Set up account recovery to use this.")
                    }
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
            if case .idle = vm?.browserSessions { await vm?.load() }
        }
        .task {
            await refreshCompanionPendingCount()
        }
    }

    /// One-shot fetch of the pending companion-write count so the
    /// Settings nav row can render a badge. Best-effort: a daemon that
    /// doesn't implement the endpoint yet silently leaves the badge at
    /// 0 instead of surfacing an error.
    private func refreshCompanionPendingCount() async {
        do {
            let r = try await client.companionPendingWrites()
            pendingCompanionCount = r.pending.count
        } catch {
            pendingCompanionCount = 0
        }
    }

    @ViewBuilder
    private func settingsDestination(for route: SettingsRoute) -> some View {
        switch route {
        case .providers:
            ProvidersStub()
        case .aiKeys:
            AiKeysScreen(vm: AiKeysViewModel())
        case .recovery:
            RecoveryContainer(onShowPostRecoveryProgress: { path.append(.postRecoveryProgress) })
        case .keyfileBackup:
            KeyfileExportScreen(
                vm: KeyfileExportViewModel(username: app.currentUser ?? "")
            )
        case .postRecoveryProgress:
            PostRecoveryContainer()
        case .about:
            AboutStub()
        case .addDevice:
            // Phase 3b — admin side. Construct the VM with the active
            // account; the relay seam comes from the environment.
            AddDeviceScreen(
                vm: AddDeviceViewModel(
                    account: app.currentUser ?? "",
                    relay: pairingRelay
                )
            )
        case .scanPairingCode:
            // Phase 3b — incoming side via the in-app scanner (no
            // pre-filled URL → the screen shows the camera).
            JoinAccountScreen(
                vm: JoinAccountViewModel(relay: pairingRelay, server: server),
                onJoined: { profile in
                    app.addProfile(
                        Profile(
                            cloudName: profile.cloudName,
                            deviceLabel: profile.deviceLabel
                        ),
                        setActive: true
                    )
                }
            )
        case .joinAccount(let joinUrl):
            // Phase 3b — incoming side via a deeplink/universal link.
            JoinAccountScreen(
                vm: JoinAccountViewModel(relay: pairingRelay, server: server),
                initialJoinUrl: joinUrl,
                onJoined: { profile in
                    app.addProfile(
                        Profile(
                            cloudName: profile.cloudName,
                            deviceLabel: profile.deviceLabel
                        ),
                        setActive: true
                    )
                }
            )
        case .replaceDeviceFinalize(let completesAt):
            // B7 — the finalize surface (24h grace countdown + Complete).
            // Reuses the VM built by onReplaceDevice when present; the
            // container reconstructs it if we arrived cold (e.g. a future
            // deep link) so the screen always has a driver.
            ReplaceDeviceFinalizeContainer(
                vm: $replaceVm,
                completesAt: completesAt,
                onCompleted: {
                    // The IRK just rotated — the in-memory session is
                    // stale. Drop push + sign out so the app re-pairs
                    // cleanly on next open.
                    Task { @MainActor in
                        await pushRegistrar?.revoke()
                        app.signOut()
                    }
                }
            )
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
        case .peerBackup:
            PeerBackupScreen(vm: PeerBackupViewModel(client: client))
        case .companionDock:
            CompanionDockScreen(
                vm: CompanionDockViewModel(client: client),
                podBaseUrl: app.currentPod.map { CompanionTicketURL.podBaseUrl(forFqdn: $0.fqdn) },
                username: app.currentUser ?? ""
            )
        case .companionRequests:
            CompanionRequestsContainer(
                vm: $companionRequestsVm,
                onPendingCountChanged: { count in pendingCompanionCount = count }
            )
        }
    }
}

/// P14 Phase 2 — container that owns the CompanionRequestsViewModel
/// lifecycle so the SettingsTab can navigate to it without keeping the
/// VM alive after pop. Mirrors PostRecoveryContainer's shape.
struct CompanionRequestsContainer: View {
    @Environment(\.screensClient) private var client
    @Environment(\.flagshipServerClient) private var server
    @Environment(AppState.self) private var app
    @Binding var vm: CompanionRequestsViewModel?
    var onPendingCountChanged: (Int) -> Void = { _ in }

    var body: some View {
        ZStack {
            FSColors.scheme(.light).bg.ignoresSafeArea()
            if let vm {
                CompanionRequestsScreen(vm: vm)
                    .onChange(of: countFor(vm.state)) { _, newValue in
                        onPendingCountChanged(newValue)
                    }
            } else {
                ProgressView()
            }
        }
        .task {
            if vm == nil {
                vm = CompanionRequestsViewModel(
                    client: client,
                    server: server,
                    username: { [app] in app.currentUser }
                )
            }
            if case .idle = vm?.state { await vm?.load() }
        }
    }

    private func countFor(_ state: LoadingState<[CompanionPendingWrite]>) -> Int {
        if case .loaded(let rows) = state { return rows.count }
        return 0
    }
}

/// B7 — owns the ReplaceDeviceViewModel for the finalize screen. Reuses
/// the VM already built by `onReplaceDevice` (passed through the binding)
/// or constructs one on cold entry. Built as a container so the VM is
/// created in `.task` (never during view-body evaluation), mirroring
/// `CompanionRequestsContainer`.
struct ReplaceDeviceFinalizeContainer: View {
    @Environment(\.flagshipServerClient) private var server
    @Environment(AppState.self) private var app
    @Binding var vm: ReplaceDeviceViewModel?
    let completesAt: Int64?
    var onCompleted: () -> Void = {}

    var body: some View {
        ZStack {
            FSColors.scheme(.light).bg.ignoresSafeArea()
            if let vm {
                ReplaceDeviceFinalizeScreen(
                    vm: vm,
                    completesAt: completesAt,
                    onCompleted: onCompleted
                )
            } else {
                ProgressView()
            }
        }
        .task {
            if vm == nil {
                vm = ReplaceDeviceViewModel(
                    server: server,
                    username: { [app] in app.currentUser }
                )
            }
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
                Text("On by default. Flagship asks for Face ID each time the app launches or returns from the background, so you stay signed in without re-entering your passphrase. Turn it off to open straight in. Either way your apps keep running and your pods stay reachable — this only controls who can see and tap.")
                    .font(FS.font.bodySm())
                    .foregroundColor(c.textMuted)
                if let msg = pendingError {
                    Text(msg).font(FS.font.caption()).foregroundColor(c.danger)
                }

                Divider().padding(.vertical, FS.space.s2)

                Text("Require your passphrase")
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundColor(c.text)
                Toggle(isOn: Binding(
                    get: { privacy.requirePassphraseAtLaunch },
                    set: { privacy.requirePassphraseAtLaunch = $0 },
                )) {
                    Text("Sign in with your passphrase every time")
                        .foregroundColor(c.text)
                }
                .tint(c.primary)
                .accessibilityIdentifier("privacy-require-passphrase-toggle")
                Text("Off by default. When on, Flagship doesn't keep you signed in — each launch needs a full sign-in with your account passphrase, not just Face ID. The strongest option, and the slowest.")
                    .font(FS.font.bodySm())
                    .foregroundColor(c.textMuted)

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
    @Environment(AppState.self) private var app
    @State private var vm: RecoveryViewModel?
    var onShowPostRecoveryProgress: () -> Void = {}

    var body: some View {
        ZStack {
            FSColors.scheme(.light).bg.ignoresSafeArea()
            if let vm {
                RecoveryScreen(
                    vm: vm,
                    onRunSetup: { passphrase in
                        // Fresh UMK seed for the demo. Real call site
                        // (SecureAccountScreen) passes the live UMK from
                        // Keystore. The passphrase comes from the screen's
                        // validated SecureFields.
                        let seed = SymmetricKey(size: .bits256)
                        await vm.setup(umkSeed: seed, passphrase: passphrase)
                        if case .registered = vm.phase {
                            toasts.success("Recovery is active.")
                        }
                    },
                    onRunRecover: { passphrase in
                        let recovered = await vm.recover(
                            username: app.currentUser ?? "",
                            passphrase: passphrase
                        )
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
                    webAuthn: PlatformWebAuthnProvider(),
                    username: { [app] in app.currentUser }
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
