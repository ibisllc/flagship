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
    @Environment(\.secretMailboxClient) private var mailbox
    /// The pending boot approvals, shown inside their section.
    @State private var approvals: SecretRequestsModel?
    /// Bumped by a boot-approval push or link so the section opens.
    @State private var openApprovals = 0
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
            // No page of its own: the Server approvals section opens with the request in it.
            openApprovals += 1
            Task { await approvals?.reload() }
            _ = linker.consume()
        case .accountActivity:
            if path.last != .auditLog { path.append(.auditLog) }
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
                    approvals: approvals,
                    openApprovals: openApprovals,
                    onOpenPostRecovery: { path.append(.postRecovery) },
                    onOpenAuditLog: { path.append(.auditLog) },
                    onRefresh: {
                        await vm.load()
                        await approvals?.reload()
                    },
                    onLoadMoreAudit: { await vm.loadMoreAudit() },
                    onLoadMoreBox: { await vm.loadMoreBoxEvents() }
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
            if approvals == nil { approvals = makeApprovals() }
            // The approvals load on their own, so the header can show how many wait
            // even when the daemon feed can't load.
            Task { await approvals?.loadIfNeeded() }
            if case .idle = vm?.state { await vm?.load() }
        }
    }
}

extension ActivityTab {
    /// The account's pending approvals, over the coordinator for the signed-in user.
    @MainActor
    func makeApprovals() -> SecretRequestsModel {
        SecretRequestsModel(
            source: { [app, mailbox] in
                guard let username = app.currentUser else { return nil }
                return Self.coordinator(mailbox: mailbox, username: username)
            },
            isFirstBoot: { [app] serverDomain in
                // A box absent from the list (no reconcile yet) is treated as on its first boot.
                guard let pod = app.pods.first(where: { $0.fqdn.lowercased() == serverDomain.lowercased() }) else { return true }
                return !pod.cameOnline
            },
            onRequests: { verified in
                // Mirror the pending approvals onto the watch (a no-op when unwired).
                WatchSecurityAlertsBridge.shared.publishApprovals(
                    verified.map { WatchProtocol.PendingApproval(secretRequest: $0.pending) }
                )
            }
        )
    }

    static func coordinator(mailbox: any SecretMailboxClient, username: String) -> SecretRequestCoordinator {
        SecretRequestCoordinator(
            mailbox: mailbox,
            username: username,
            irkProvider: {
                try await Keystore.deriveIRK(reason: "Approve your server's boot secret")
            },
            unsealSeedProvider: { serverDomain in
                // The installer seals the LUKS key against one of the phone's
                // Ed25519 keys. Try the per-server BAK first (derivable from the
                // UMK), then the IRK: whichever it was sealed against opens it.
                var seeds: [Data] = []
                if let bak = try? await Keystore.deriveBAK(
                    serverId: serverDomain,
                    reason: "Unseal the disk key for \(serverDomain)"
                ) {
                    seeds.append(bak.rawRepresentation)
                }
                if let irk = try? await Keystore.deriveIRK(reason: "Unseal the disk key") {
                    seeds.append(irk.rawRepresentation)
                }
                return seeds
            },
            // The RootEntitlement this approval mints signs under the admin master
            // root when this device holds one (a reburned admin-pinned box rejects
            // an IRK-signed one), else the owner IRK.
            orderKeyProvider: {
                Keystore.hasAdminRoot
                    ? try await Keystore.adminRootKey(reason: "Authorize your server to serve")
                    : nil
            },
            // "Quick approve from Apple Watch": a plain unlock approval signs the
            // boot-response with the delegate key (role="delegate"), no biometric.
            watchDelegateKeyProvider: { Keystore.watchDelegateKey() }
        )
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
