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
        Group {
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
                .task(id: "home-initial-load") {
                    if case .idle = vm.detail { await vm.load() }
                }
            }
        }
        .onAppear {
            if vm == nil { vm = HomeViewModel(client: client) }
        }
    }

    @ViewBuilder
    private func destination(for route: HomeRoute) -> some View {
        switch route {
        case .serverDetail(let podId):
            ServerDetailContainer(podId: podId)
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
                    let slug = SlugUtil.slugify(name)
                    let pod = PodInfo(
                        podId: "paired-\(UUID().uuidString.prefix(6).lowercased())",
                        name: name,
                        description: description.isEmpty ? nil : description,
                        fqdn: "\(slug).\(user).flagship.services",
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
                    let slug = SlugUtil.slugify(name)
                    let pod = PodInfo(
                        podId: "pod-\(UUID().uuidString.prefix(6).lowercased())",
                        name: name,
                        description: description.isEmpty ? nil : description,
                        fqdn: "\(slug).\(user).flagship.services",
                        status: .online
                    )
                    app.addPod(pod)
                    path.removeAll()
                }
            )
        case .pairedSessions:
            PairedSessionsContainer()
        case .tierStatus:
            TierStatusContainer()
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
        .task {
            if detailVm == nil { detailVm = HomeViewModel(client: client) }
            if metricsVm == nil { metricsVm = ServerMetricsViewModel(podId: podId, client: client) }
            await detailVm?.load()
            metricsVm?.startPolling(every: 15)
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
