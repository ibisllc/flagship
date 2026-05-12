import SwiftUI
import FlagshipCore
import FlagshipAPI

public struct SettingsTab: View {
    @Environment(\.screensClient) private var client
    @Environment(AppState.self) private var app

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
                    pods: app.pods,
                    leaderPodId: app.leaderPodId,
                    tier: vm.tier,
                    onOpenPod: { pod in path.append(.serverDetail(podId: pod.podId)) },
                    onAddServer: { path.append(.addServer) },
                    onSetLeader: { pod in app.setLeader(pod.podId) },
                    onSignOut: { app.signOut() },
                    onOpenProviders: { path.append(.providers) },
                    onOpenRecovery: { path.append(.recovery) },
                    onOpenAbout: { path.append(.about) },
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
            RecoveryStub()
        case .about:
            AboutStub()
        case .addServer:
            AddServerChooserScreen(
                mode: .inApp,
                onProvision: { path.append(.createServer) },
                onPair:      { path.append(.podPair) }
            )
        case .podPair:
            PodPairScreen(
                onSubmit: { _, name, description in
                    let user = app.currentUser ?? "you"
                    let pod = PodInfo(
                        podId: "paired-\(UUID().uuidString.prefix(6).lowercased())",
                        name: name,
                        description: description.isEmpty ? nil : description,
                        fqdn: "\(SlugUtil.slugify(name)).\(user).flagship.services",
                        status: .online
                    )
                    app.addPod(pod)
                    path.removeAll()
                },
                onCancel: { path.removeLast() }
            )
        case .createServer:
            CreateServerStubScreen(
                username: app.currentUser ?? "",
                onDemoComplete: { name, description in
                    let user = app.currentUser ?? "you"
                    let pod = PodInfo(
                        podId: "pod-\(UUID().uuidString.prefix(6).lowercased())",
                        name: name,
                        description: description.isEmpty ? nil : description,
                        fqdn: "\(SlugUtil.slugify(name)).\(user).flagship.services",
                        status: .online
                    )
                    app.addPod(pod)
                    path.removeAll()
                }
            )
        case .serverDetail(let podId):
            ServerDetailContainer(podId: podId)
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

struct RecoveryStub: View {
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        let c = FSColors.scheme(scheme)
        ScrollView {
            VStack(alignment: .leading, spacing: FS.space.s4) {
                Text("If you lose this phone").font(FS.font.h2()).foregroundColor(c.text)
                Text("Your User Master Key (UMK) is what owns your account. Without it, no one can take over your servers, including Flagship. That's also why recovery matters.")
                    .font(FS.font.body()).foregroundColor(c.textMuted)
                FSCard {
                    VStack(alignment: .leading, spacing: FS.space.s3) {
                        Text("WebAuthn-PRF cloud recovery").font(FS.font.h4())
                        Text("Set up a security key or passkey to wrap a recovery copy of your UMK. You'll need to do this from the webapp for now.")
                            .font(FS.font.bodySm()).foregroundColor(c.textMuted)
                        FSGhostButton("Open webapp instructions") {}
                    }
                }
            }
            .padding(FS.space.s6)
        }
        .navigationTitle("Recovery")
        .navigationBarTitleDisplayMode(.inline)
    }
}

struct AboutStub: View {
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        let c = FSColors.scheme(scheme)
        ScrollView {
            VStack(alignment: .leading, spacing: FS.space.s4) {
                Text("Flagship").font(FS.font.h2()).foregroundColor(c.text)
                Text("Your stuff, on your hardware.").font(FS.font.body()).foregroundColor(c.textMuted)
                FSCard {
                    VStack(alignment: .leading, spacing: FS.space.s3) {
                        labeled("Version", "0.1.0 (dev)", c: c)
                        labeled("License", "BUSL-1.1 → Apache 2.0 (2030)", c: c)
                        labeled("Source", "github.com/ibisllc/flagship", c: c, mono: true)
                    }
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
