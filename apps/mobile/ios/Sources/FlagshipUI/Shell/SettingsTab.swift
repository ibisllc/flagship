import SwiftUI
import CryptoKit
import FlagshipCore
import FlagshipAPI

public struct SettingsTab: View {
    @Environment(\.screensClient) private var client
    @Environment(AppState.self) private var app
    @Environment(DeveloperSettings.self) private var dev

    @State private var path: [SettingsRoute] = []
    @State private var vm: SettingsViewModel?

    public init() {}

    public var body: some View {
        NavigationStack(path: $path) {
            content
                .navigationDestination(for: SettingsRoute.self) { route in
                    settingsDestination(for: route)
                }
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
                    showDeveloper: dev.unlocked,
                    onAddControlDevice: { path.append(.addControlDevice) },
                    onRevokeDevice: { session in Task { await vm.revoke(session) } },
                    onSignOut: { app.signOut() },
                    onOpenProviders: { path.append(.providers) },
                    onOpenRecovery: { path.append(.recovery) },
                    onOpenAbout: { path.append(.about) },
                    onOpenDeveloper: { path.append(.developer) },
                    onRefresh: { await vm.load() }
                )
            } else {
                ProgressView()
            }
        }
        .task {
            if vm == nil { vm = SettingsViewModel(client: client) }
            if case .idle = vm?.tier { await vm?.load() }
        }
    }

    @ViewBuilder
    private func settingsDestination(for route: SettingsRoute) -> some View {
        switch route {
        case .providers:
            ProvidersStub()
        case .recovery:
            RecoveryContainer()
        case .about:
            AboutStub()
        case .addControlDevice:
            AddControlDeviceScreen()
        case .developer:
            DeveloperScreen(dev: dev, onWipeIdentity: {
                app.signOut()
            })
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
                    }
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
