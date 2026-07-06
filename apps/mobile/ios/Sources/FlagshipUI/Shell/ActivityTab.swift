import SwiftUI
import FlagshipCore
import FlagshipAPI
import Flagship

public struct ActivityTab: View {
    @Environment(\.screensClient) private var client
    @Environment(\.flagshipServerClient) private var server
    @Environment(AppState.self) private var app
    @Environment(DeepLinker.self) private var linker
    @State private var path: [ActivityRoute] = []
    @State private var vm: ActivityViewModel?
    /// Server filter for the switcher. `nil` = "All servers" (the default and
    /// the entry the dropdown starts on). Picking a concrete server also
    /// repoints the active pod so its per-server install events load; "All
    /// servers" leaves the active pod untouched and shows the unfiltered feed
    /// (account-wide events are always all-servers; true cross-pod aggregation
    /// of install events is a follow-up).
    @State private var serverFilter: String?

    public init() {}

    public var body: some View {
        NavigationStack(path: $path) {
            content
                .navigationDestination(for: ActivityRoute.self) { route in
                    switch route {
                    case .secretRequests: SecretRequestsContainer()
                    case .installProgress(let serial): InstallProgressStub(serial: serial)
                    case .postRecovery: PostRecoveryContainer()
                    case .auditLog:
                        AuditLogScreen(
                            vm: AuditLogViewModel(
                                server: server,
                                username: app.currentUser ?? ""
                            )
                        )
                    }
                }
        }
        .onChange(of: linker.pending) { _, link in
            consume(link)
        }
        .task(id: linker.pending) { consume(linker.pending) }
    }

    /// Pop or push onto our path stack when a DeepLink lands on this
    /// tab. Specific-requestId unlock approves still drop onto the
    /// list (a per-id detail screen would be a future enhancement).
    private func consume(_ link: DeepLink?) {
        guard let link else { return }
        switch link {
        case .secretRequests:
            if !path.contains(.secretRequests) { path.append(.secretRequests) }
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
                ActivityScreen(
                    state: vm.state,
                    pods: app.pods,
                    currentPodId: serverFilter,
                    leaderPodId: app.leaderPodId,
                    onPickPod: { pod in
                        serverFilter = pod.podId
                        app.setCurrentPod(pod.podId)
                    },
                    onPickAll: { serverFilter = nil },
                    onOpenApprovals: { path.append(.secretRequests) },
                    onOpenPostRecovery: { path.append(.postRecovery) },
                    onOpenAuditLog: { path.append(.auditLog) },
                    onRefresh: { await vm.load() }
                )
            } else {
                ProgressView()
            }
        }
        .task {
            if vm == nil {
                vm = ActivityViewModel(
                    client: client,
                    server: server,
                    username: { [app] in app.currentUser }
                )
            }
            if case .idle = vm?.state { await vm?.load() }
        }
    }
}

struct InstallProgressStub: View {
    let serial: String
    var body: some View {
        VStack(spacing: FS.space.s4) {
            ProgressView()
            Text("Watching \(serial)…").font(FS.font.mono())
        }
        .padding(FS.space.s8)
        .navigationTitle("Provisioning")
        .navigationBarTitleDisplayMode(.inline)
    }
}
