import SwiftUI
import FlagshipCore
import FlagshipAPI

/// Home tab. Account-wide overview + drill-down into individual servers.
public struct HomeTab: View {
    @Environment(\.screensClient) private var client
    @Environment(AppState.self) private var app

    @State private var path: [HomeRoute] = []
    @State private var vm: HomeViewModel?

    public init() {}

    public var body: some View {
        NavigationStack(path: $path) {
            content
                .navigationDestination(for: HomeRoute.self) { route in
                    destination(for: route)
                }
        }
    }

    @ViewBuilder
    private var content: some View {
        ZStack {
            FSColors.scheme(.light).bg.ignoresSafeArea()
            if let vm {
                HomeScreen(
                    state: vm.detail,
                    username: app.currentUser ?? "",
                    pods: app.pods,
                    leaderPodId: app.leaderPodId,
                    onOpenPod: { pod in path.append(.serverDetail(podId: pod.podId)) },
                    onAddServer: { path.append(.addServer) },
                    onSetLeader: { pod in app.setLeader(pod.podId) },
                    onVibeCode: {},
                    onBrowseMarketplace: {},
                    onRefresh: { await vm.load() }
                )
            } else {
                ProgressView()
            }
        }
        .task {
            if vm == nil {
                vm = HomeViewModel(client: client, podContext: app.currentPodId ?? app.leaderPodId)
            }
            if case .idle = vm?.detail { await vm?.load() }
        }
        .onChange(of: app.currentPodId) { _, _ in
            Task { await vm?.load() }
        }
    }

    @ViewBuilder
    private func destination(for route: HomeRoute) -> some View {
        switch route {
        case .serverDetail(let podId):
            // Pending pods get the placeholder detail page; online pods
            // get the full ServerDetail with monitoring + access.
            if let pod = app.pods.first(where: { $0.podId == podId }), pod.status == .pending {
                PendingServerScreen(pod: pod) {
                    app.removePod(pod.podId)
                    path.removeAll()
                }
            } else {
                ServerDetailContainer(podId: podId)
            }
        case .addServer:
            // In-app add-server only ever means "provision a new box."
            // Pairing an existing server is an onboarding-only path.
            CreateServerContainer(
                onDelivered: { serverDomain, name, description in
                    // QR-relay delivered. Add the pod to AppState with
                    // .pending status — Home now shows it as Pending,
                    // tapping it opens PendingServerScreen.
                    addPendingPod(name: name, description: description, fqdn: serverDomain)
                },
                onDemoComplete: { name, description in
                    addOnlinePodAndDismiss(name: name, description: description)
                },
                onCancel: {
                    // User backed out before delivering — drop any
                    // pending state and head home.
                    path.removeAll()
                }
            )
        case .installProgress(let serial, let name, let description):
            InstallProgressContainer(serial: serial) { fqdn in
                addOnlinePodAndDismiss(name: name, description: description, fqdn: fqdn)
            }
        }
    }

    private func addOnlinePodAndDismiss(name: String, description: String, fqdn: String? = nil) {
        let user = app.currentUser ?? "you"
        let slug = SlugUtil.slugify(name)
        let pod = PodInfo(
            podId: "pod-\(UUID().uuidString.prefix(6).lowercased())",
            name: name,
            description: description.isEmpty ? nil : description,
            fqdn: fqdn ?? "\(slug).\(user).flagship.services",
            status: .online
        )
        app.addPod(pod)
        path.removeAll()
    }

    private func addPendingPod(name: String, description: String, fqdn: String) {
        let pod = PodInfo(
            podId: "pod-\(UUID().uuidString.prefix(6).lowercased())",
            name: name,
            description: description.isEmpty ? nil : description,
            fqdn: fqdn,
            status: .pending
        )
        app.addPod(pod)
        path.removeAll()
    }
}

struct CreateServerContainer: View {
    let onDelivered: (_ serverDomain: String, _ name: String, _ description: String) -> Void
    let onDemoComplete: (_ name: String, _ description: String) -> Void
    let onCancel: () -> Void
    @Environment(\.flagshipServerClient) private var serverClient
    @Environment(\.qrRelayClient) private var qrRelay
    @Environment(AppState.self) private var app
    @State private var vm: CreateServerViewModel?

    init(
        onDelivered: @escaping (_ serverDomain: String, _ name: String, _ description: String) -> Void,
        onDemoComplete: @escaping (_ name: String, _ description: String) -> Void,
        onCancel: @escaping () -> Void = {}
    ) {
        self.onDelivered = onDelivered
        self.onDemoComplete = onDemoComplete
        self.onCancel = onCancel
    }

    var body: some View {
        ZStack {
            FSColors.scheme(.light).bg.ignoresSafeArea()
            if let vm {
                CreateServerStubScreen(
                    vm: vm,
                    onDelivered: onDelivered,
                    onDemoComplete: onDemoComplete,
                    onCancel: onCancel
                )
            } else {
                ProgressView()
            }
        }
        .task {
            if vm == nil {
                vm = CreateServerViewModel(
                    username: app.currentUser ?? "you",
                    server: serverClient,
                    relay: qrRelay
                )
            }
        }
    }
}

struct InstallProgressContainer: View {
    let serial: String
    let onFinish: (String) -> Void
    @Environment(\.screensClient) private var client
    @State private var vm: InstallProgressViewModel?

    var body: some View {
        ZStack {
            FSColors.scheme(.light).bg.ignoresSafeArea()
            if let vm {
                InstallProgressScreen(vm: vm, onFinish: onFinish)
            } else {
                ProgressView()
            }
        }
        .task {
            if vm == nil { vm = InstallProgressViewModel(serial: serial, client: client) }
        }
    }
}

/// Drill-down server detail. Owns its own detail VM AND its metrics VM
/// (the latter polls every 15s while the screen is on stage).
struct ServerDetailContainer: View {
    let podId: String
    @Environment(\.screensClient) private var client
    @Environment(\.colorScheme) private var scheme
    @State private var detailVm: HomeViewModel?
    @State private var metricsVm: ServerMetricsViewModel?

    var body: some View {
        let c = FSColors.scheme(scheme)
        ZStack {
            c.bg.ignoresSafeArea()
            if let detailVm, let metricsVm {
                ServerDetailScreen(
                    state: detailVm.detail,
                    metrics: metricsVm.state,
                    onRefresh: {
                        async let a: Void = detailVm.load()
                        async let b: Void = metricsVm.load()
                        _ = await (a, b)
                    }
                )
            } else {
                ProgressView()
            }
        }
        .navigationTitle("Server")
        .navigationBarTitleDisplayMode(.inline)
        // `.task` cancels the closure automatically on view removal —
        // which catches the case where `.onDisappear` doesn't fire
        // reliably during navigation churn on iPad.
        .task {
            if detailVm == nil {
                detailVm = HomeViewModel(client: client, podContext: podId)
            }
            if metricsVm == nil {
                metricsVm = ServerMetricsViewModel(podId: podId, client: client)
            }
            await detailVm?.load()
            metricsVm?.startPolling(every: 15)
            // Park the task here so polling stops when the view goes
            // away.
            for await _ in AsyncStream<Never> { _ in } { }
        }
        .onDisappear { metricsVm?.stopPolling() }
    }
}

struct PairedSessionsContainer: View {
    @Environment(\.screensClient) private var client
    @State private var state: LoadingState<[PairedSessionSummary]> = .idle

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: FS.space.s3) {
                switch state {
                case .idle, .loading:
                    ForEach(0..<3) { _ in ServerCardSkeleton() }
                case .failed(let msg):
                    ErrorCard(message: msg)
                case .loaded(let sessions):
                    ForEach(sessions, id: \.tokenPrefix) { s in
                        PairedSessionRow(session: s)
                    }
                }
            }
            .padding(FS.space.s6)
        }
        .navigationTitle("Paired devices")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            state = .loading
            do {
                let r = try await client.pairedSessionsList()
                state = .loaded(r.sessions)
            } catch {
                state = .failed(error.localizedDescription)
            }
        }
    }
}

struct PairedSessionRow: View {
    @Environment(\.colorScheme) private var scheme
    let session: PairedSessionSummary
    var body: some View {
        let c = FSColors.scheme(scheme)
        FSCard {
            HStack {
                Image(systemName: session.current ? "iphone.gen3" : "laptopcomputer")
                    .foregroundColor(session.current ? c.success : c.textMuted)
                VStack(alignment: .leading) {
                    Text(session.label).foregroundColor(c.text)
                    Text("token: \(session.tokenPrefix)…")
                        .font(FS.font.mono())
                        .foregroundColor(c.textMuted)
                }
                Spacer()
                if session.current { FSPill("This device", kind: .online) }
            }
        }
    }
}

struct TierStatusContainer: View {
    @Environment(\.screensClient) private var client
    @State private var vm: SettingsViewModel?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: FS.space.s4) {
                if let vm {
                    switch vm.tier {
                    case .idle, .loading:
                        ServerCardSkeleton()
                    case .failed(let msg):
                        ErrorCard(message: msg)
                    case .loaded(let t):
                        TierBreakdownCard(tier: t)
                    }
                }
            }
            .padding(FS.space.s6)
        }
        .navigationTitle("Tier & usage")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            if vm == nil { vm = SettingsViewModel(client: client) }
            await vm?.load()
        }
    }
}

struct TierBreakdownCard: View {
    @Environment(\.colorScheme) private var scheme
    let tier: TierStatusResponse
    var body: some View {
        let c = FSColors.scheme(scheme)
        FSCard {
            VStack(alignment: .leading, spacing: FS.space.s3) {
                Text(tier.tier.uppercased())
                    .font(.system(size: 12, weight: .semibold))
                    .tracking(1)
                    .foregroundColor(c.textMuted)
                if let day = tier.llmCreditsRemainingDay {
                    HStack { Text("LLM credits today"); Spacer(); Text("\(day)") }
                }
                if let usage = tier.dispatcherUsageGBmonth, let quota = tier.dispatcherFreeQuotaGBmonth {
                    HStack { Text("Bandwidth"); Spacer(); Text(String(format: "%.1f / %.0f GB", usage, quota)) }
                }
                if !tier.customDomains.isEmpty {
                    Text("Custom domains:").foregroundColor(c.textMuted)
                    ForEach(tier.customDomains, id: \.self) { d in
                        Text(d).font(FS.font.mono())
                    }
                }
            }
        }
    }
}
