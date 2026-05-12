import SwiftUI
import FlagshipCore
import FlagshipAPI

public struct ActivityTab: View {
    @Environment(\.screensClient) private var client
    @State private var path: [ActivityRoute] = []
    @State private var vm: ActivityViewModel?

    public init() {}

    public var body: some View {
        NavigationStack(path: $path) {
            content
                .navigationDestination(for: ActivityRoute.self) { route in
                    switch route {
                    case .unlockApprovals: UnlockApprovalsContainer()
                    case .installProgress(let serial): InstallProgressStub(serial: serial)
                    }
                }
        }
    }

    @ViewBuilder
    private var content: some View {
        Group {
            if let vm {
                ActivityScreen(
                    state: vm.state,
                    onApproveUnlock: { _ in
                        path.append(.unlockApprovals)
                    },
                    onRevokeSession: { _ in },
                    onRefresh: { await vm.load() }
                )
                .task(id: "activity-load") { if case .idle = vm.state { await vm.load() } }
            }
        }
        .onAppear { if vm == nil { vm = ActivityViewModel(client: client) } }
    }
}

struct UnlockApprovalsContainer: View {
    @Environment(\.screensClient) private var client
    @State private var state: LoadingState<[PendingUnlockApproval]> = .idle

    var body: some View {
        ScrollView {
            VStack(spacing: FS.space.s3) {
                switch state {
                case .idle, .loading:
                    ForEach(0..<2) { _ in ServerCardSkeleton() }
                case .failed(let msg):
                    ErrorCard(message: msg)
                case .loaded(let approvals):
                    if approvals.isEmpty {
                        FSCard { Text("No pending approvals.") }
                    } else {
                        ForEach(approvals, id: \.requestId) { r in
                            FSCard {
                                VStack(alignment: .leading) {
                                    Text(r.serverFqdn).font(FS.font.mono())
                                    if let ip = r.ip { Text("from \(ip)").font(FS.font.caption()) }
                                    FSPrimaryButton("Approve", block: true) {}
                                }
                            }
                        }
                    }
                }
            }
            .padding(FS.space.s6)
        }
        .navigationTitle("Approvals")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            state = .loading
            do {
                let r = try await client.unlockApprovalsPending()
                state = .loaded(r.pending)
            } catch {
                state = .failed(error.localizedDescription)
            }
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
