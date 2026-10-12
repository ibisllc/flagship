import SwiftUI
import Flagship
import FlagshipCore
import FlagshipAPI

/// Services tab: list → detail; vibe-code launcher. Owns its
/// own NavigationStack with AppsRoute as the path element type. Surfaces
/// as "Services" in the UI.
public struct ServicesTab: View {
    @Environment(\.screensClient) private var client
    @Environment(\.flagshipServerClient) private var server
    @Environment(\.colorScheme) private var scheme
    /// iPad/regular: the sidebar already names the destination, so collapse
    /// the in-content large title to inline. iPhone keeps the large title.
    @Environment(\.horizontalSizeClass) private var sizeClass
    @Environment(AppState.self) private var app
    @Environment(DeepLinker.self) private var linker

    @State private var path: [AppsRoute] = []
    @State private var vm: ServicesListViewModel?
    /// In-memory BYOK credential for the current build, set at the AI-key
    /// step and consumed by the downstream scratch/git containers. Never
    /// persisted here, never rides a route.
    @State private var buildCred = BuildCredentialHolder()
    /// Presentation-only creator filter chip (All / Yours / Shared). Narrows
    /// the rendered list; never mutates the loaded apps.
    @State private var ownerFilter: AppsOwnerFilter = .all

    public init() {}

    public var body: some View {
        NavigationStack(path: $path) {
            content
                .navigationDestination(for: AppsRoute.self) { route in destination(for: route) }
        }
        .onChange(of: linker.pending) { _, link in consume(link) }
        .task(id: linker.pending) { consume(linker.pending) }
        .onChange(of: path) { old, new in
            // Returning to the list root after a child action (e.g. an
            // uninstall popped the detail) — refresh so a removed service
            // disappears without a manual pull-to-refresh.
            if !old.isEmpty && new.isEmpty {
                Task { await vm?.load() }
            }
        }
    }

    private func consume(_ link: DeepLink?) {
        guard let link else { return }
        switch link {
        case .appDetail(let id):
            if path.last != .appDetail(serviceId: id) {
                path.append(.appDetail(serviceId: id))
            }
            _ = linker.consume()
        case .vibeCodeChat(let sessionId):
            if path.last != .vibeCodeChat(sessionId: sessionId) {
                path.openVibeSession(sessionId)
            }
            _ = linker.consume()
        case .startVibeCode:
            if path.last != .buildSource {
                path.append(.buildSource)
            }
            _ = linker.consume()
        default:
            break
        }
    }

    @ViewBuilder
    private var content: some View {
        let c = FSColors.scheme(scheme)
        ZStack {
            c.bg.ignoresSafeArea()
            if let vm {
                ScrollView {
                    VStack(alignment: .leading, spacing: FS.space.s4) {
                        subheader(c: c, vm: vm)
                        emptyOrList(vm: vm, c: c)
                        Spacer().frame(height: FS.space.s12)
                    }
                    .padding(.horizontal, FS.space.s6)
                    .padding(.top, FS.space.s2)
                    .fsReadingColumn()
                }
                .navigationTitle("Services")
                .navigationBarTitleDisplayMode(sizeClass == .regular ? .inline : .large)
                .searchable(text: searchBinding(vm: vm), placement: .navigationBarDrawer(displayMode: .automatic), prompt: "Search services")
                // Server filter: top-right, above the large title. The
                // PodSwitcher presents its panel as a popover, so it is not
                // clipped by the nav bar (the earlier in-hierarchy overlay was).
                .toolbar {
                    if app.pods.count > 1 {
                        ToolbarItem(placement: .topBarTrailing) {
                            PodSwitcher(
                                pods: app.pods,
                                currentPodId: vm.serverFilter,
                                leaderPodId: app.leaderPodId,
                                onPick: { pod in vm.serverFilter = pod.podId },
                                allLabel: "All servers",
                                onPickAll: { vm.serverFilter = nil }
                            )
                        }
                    }
                }
                .refreshable { await vm.load() }
            } else {
                ProgressView()
            }
        }
        .task {
            if vm == nil {
                vm = ServicesListViewModel(
                    client: client,
                    server: server,
                    username: { [app] in app.currentUser }
                )
            }
            // V7 — keep the dropdown in sync with whatever pods the
            // user currently owns; the source of truth lives on
            // AppState, the VM just needs a snapshot so its filter
            // can resolve podId → display name.
            vm?.availablePods = app.pods.map { ($0.podId, $0.name) }
            if case .idle = vm?.state { await vm?.load() }
        }
        .onChange(of: app.pods) { _, newPods in
            vm?.availablePods = newPods.map { ($0.podId, $0.name) }
        }
    }

    @ViewBuilder
    private func destination(for route: AppsRoute) -> some View {
        switch route {
        case .appDetail(let id):
            ServiceDetailContainer(serviceId: id, path: $path)
        case .buildSource:
            BuildSourceChooserContainer(path: $path)
        case .buildGit:
            BuildGitContainer(path: $path, holder: buildCred)
        case .buildMcp:
            BuildMcpContainer(path: $path)
        case .buildJournal(let buildId):
            BuildJournalContainer(buildId: buildId, onResume: { path.openVibeSession($0) })
        case .buildKey(let purpose):
            BuildKeyContainer(purpose: purpose, path: $path, holder: buildCred)
        case .editService(let serviceId):
            EditServiceScreen(
                name: Self.slug(of: serviceId),
                onAI: { path.append(.buildKey(purpose: .edit(serviceId: serviceId))) },
                onIDE: { path.append(.editMcp(serviceId: serviceId)) }
            )
        case .editDescribe(let serviceId):
            EditDescribeContainer(serviceId: serviceId, path: $path, holder: buildCred)
        case .editMcp(let serviceId):
            BuildMcpContainer(path: $path, editServiceId: serviceId)
        case .vibeCodeProviderPick:
            VibeCodeProviderPickScreen(
                onPickPromo: { path.append(.vibeCodeDescribe) },
                onPickBYOK: { path.append(.vibeCodeDescribe) }
            )
        case .vibeCodeDescribe:
            VibeCodeDescribeContainer(path: $path, holder: buildCred)
        case .vibeCodeGenerating(let sessionId), .vibeCodeChat(let sessionId):
            VibeCodeSessionContainer(sessionId: sessionId)
        case .serviceEnv(let appId, let creator, let slug):
            ServiceEnvContainer(appId: appId, creator: creator, slug: slug)
        case .browserTabs(let serviceId):
            BrowserTabsContainer(serviceId: serviceId, path: $path)
        case .browserViewer(_, let tabId):
            BrowserViewerContainer(tabId: tabId)
        case .inviteManage(let serviceId):
            InviteManageContainer(serviceId: serviceId, path: $path)
        case .inviteIssue(let serviceId):
            InviteIssueContainer(serviceId: serviceId, path: $path)
        case .serviceAccess(let serviceId):
            ServiceAccessContainer(serviceId: serviceId)
        case .appDatabase(let serviceId):
            AppDatabaseContainer(serviceId: serviceId, path: $path)
        case .appDatabaseTable(let serviceId, let store, let table):
            AppDbTableContainer(serviceId: serviceId, store: store, table: table)
        case .appDatabaseQuery(let serviceId, let store):
            AppDbQueryContainer(serviceId: serviceId, store: store)
        }
    }

    /// The slug half of a `<creator>--<slug>` service id.
    static func slug(of serviceId: String) -> String {
        serviceId.range(of: "--").map { String(serviceId[$0.upperBound...]) } ?? serviceId
    }

    private func searchBinding(vm: ServicesListViewModel) -> Binding<String> {
        Binding(get: { vm.searchQuery }, set: { vm.searchQuery = $0 })
    }

    @ViewBuilder
    private func subheader(c: FSColors, vm: ServicesListViewModel) -> some View {
        Text(headerSubtitle(vm: vm))
            .font(.system(size: 17))
            .foregroundColor(c.textMuted)
    }

    private func headerSubtitle(vm: ServicesListViewModel) -> String {
        guard let apps = vm.state.value else { return " " }
        return apps.isEmpty ? "Nothing installed yet." : "\(apps.count) installed"
    }

    /// vm.filteredApps already applies the server-filter + search; the owner
    /// chip is the final presentation-only narrowing.
    private func ownerFilteredApps(vm: ServicesListViewModel) -> [FlagshipAPI.AppSummary] {
        let me = (app.currentUser ?? "").lowercased()
        return vm.filteredApps.filter { ownerFilter.matches(app: $0, currentUser: me) }
    }

    @ViewBuilder
    private func emptyOrList(vm: ServicesListViewModel, c: FSColors) -> some View {
        if app.pods.isEmpty {
            // No server yet — services run on your own box, so there's
            // nothing to load. Guide to add one rather than surfacing a
            // "not paired" error.
            FSCard {
                VStack(alignment: .leading, spacing: FS.space.s3) {
                    Text("Add a server first").font(FS.font.h3()).foregroundColor(c.text)
                    Text("Services run on your own server. Add one to start building.")
                        .font(FS.font.body()).foregroundColor(c.textMuted)
                }
            }
        } else {
            switch vm.state {
        case .idle, .loading:
            VStack(spacing: FS.space.s3) {
                ForEach(0..<3) { _ in ServerCardSkeleton() }
            }
        case .failed(let msg):
            ErrorCard(message: msg)
        case .loaded:
            // Show the owner chips only when there's a meaningful split
            // (at least one shared app), so a solo user isn't given a
            // redundant All/Yours toggle.
            let me = (app.currentUser ?? "").lowercased()
            let hasShared = (vm.state.value ?? []).contains { $0.creator.lowercased() != me && !me.isEmpty }
            if hasShared {
                FSChipRow(
                    items: AppsOwnerFilter.allCases.map { .init(value: $0, label: $0.label) },
                    selection: $ownerFilter
                )
            }
            let apps = ownerFilteredApps(vm: vm)
            if apps.isEmpty {
                FSCard {
                    VStack(alignment: .leading, spacing: FS.space.s3) {
                        Text("Build your first service").font(FS.font.h3()).foregroundColor(c.text)
                        Text("Describe it in plain English. The AI writes it, your server runs it.")
                            .font(FS.font.body()).foregroundColor(c.textMuted)
                        FSPrimaryButton("Build a service", block: true) {
                            path.append(.buildSource)
                        }
                    }
                }
            } else {
                LazyVStack(spacing: FS.space.s3) {
                    ForEach(apps, id: \.serviceId) { appItem in
                        Button(action: { path.append(.appDetail(serviceId: appItem.serviceId)) }) {
                            AppRow(
                                app: appItem,
                                links: vm.linksByServiceId[appItem.serviceId],
                                currentUser: app.currentUser
                            )
                        }
                        .buttonStyle(.plain)
                    }
                }
                Button(action: { path.append(.buildSource) }) {
                    HStack(spacing: 8) {
                        Image(systemName: "sparkles").foregroundColor(c.primary)
                        Text("Build another service").font(.system(size: 15, weight: .semibold)).foregroundColor(c.primary)
                        Spacer()
                    }
                    .padding(.horizontal, FS.space.s4)
                    .padding(.vertical, FS.space.s3)
                    .background(c.primary.opacity(0.08))
                    .overlay(
                        RoundedRectangle(cornerRadius: FS.radius.md)
                            .stroke(c.primary.opacity(0.25), style: StrokeStyle(lineWidth: 1, dash: [4, 4]))
                    )
                    .clipShape(RoundedRectangle(cornerRadius: FS.radius.md))
                }.buttonStyle(.plain)
            }
            }
        }
    }

}

/// Apps tab creator filter (the chip row). `.all` shows everything; `.yours`
/// is apps you authored; `.shared` is apps authored by someone else.
enum AppsOwnerFilter: CaseIterable, Hashable {
    case all, yours, shared

    var label: String {
        switch self {
        case .all:    return "All"
        case .yours:  return "Yours"
        case .shared: return "Shared"
        }
    }

    func matches(app: FlagshipAPI.AppSummary, currentUser: String) -> Bool {
        switch self {
        case .all:    return true
        case .yours:  return currentUser.isEmpty || app.creator.lowercased() == currentUser
        case .shared: return !currentUser.isEmpty && app.creator.lowercased() != currentUser
        }
    }
}

// MARK: - Rows + containers

private struct AppRow: View {
    @Environment(\.colorScheme) private var scheme
    let app: FlagshipAPI.AppSummary
    /// V2 — per-app links (canonical + short + instances), loaded by
    /// the ServicesListViewModel after the daemon's apps-list returns.
    /// `nil` while still in flight — the row falls back to the
    /// daemon-provided urlLabel for the canonical hint.
    let links: AppLinksResponse?
    /// Drives the "by <creator>" subtitle on a shared app (one authored by
    /// someone other than the signed-in user). Nil ⇒ treat as own.
    var currentUser: String? = nil

    private var isShared: Bool {
        guard let me = currentUser?.lowercased(), !me.isEmpty else { return false }
        return app.creator.lowercased() != me
    }

    var body: some View {
        let c = FSColors.scheme(scheme)
        let running = app.status == "running"
        return FSListRow(
            leading: .icon(running ? "app.dashed" : "app", color: running ? c.success : c.textMuted),
            title: app.slug.capitalized,
            subtitle: subtitleText,
            detail: shortUrlText
        ) {
            HStack(spacing: FS.space.s2) {
                switch AppAccessCopy.listBadge(access: app.access, egress: app.egress) {
                case .draft?:
                    Image(systemName: "list.bullet.clipboard")
                        .foregroundColor(c.warning)
                        .accessibilityLabel("Suggests an access list")
                        .accessibilityIdentifier("app-row-access-draft")
                case .pending?:
                    Image(systemName: "network.badge.shield.half.filled")
                        .foregroundColor(c.warning)
                        .accessibilityLabel("Wants to reach the internet")
                        .accessibilityIdentifier("app-row-egress-pending")
                case nil:
                    EmptyView()
                }
                FSPill(running ? "Running" : "Stopped", kind: running ? .online : .idle)
                Image(systemName: "chevron.right").foregroundColor(c.textMuted)
            }
        }
    }

    /// Subtitle = the app's own summary if present, else the creator
    /// attribution for a shared app, else a short version hint.
    private var subtitleText: String? {
        if let s = app.summary, !s.isEmpty { return s }
        if isShared { return "by \(app.creator)" }
        if let v = app.version { return "v\(v)" }
        return nil
    }

    /// The short (shareable) URL for the monospaced detail line, falling back
    /// to a confirmed custom domain, then the daemon's canonical label.
    private var shortUrlText: String? {
        let confirmedCustom = (links?.customDomainConfirmed == true)
            ? links?.customDomain.map { "https://\($0)" }
            : nil
        let short = confirmedCustom ?? links?.shortUrl ?? links?.canonicalUrl ?? "https://\(app.urlLabel)…"
        return stripScheme(short)
    }

    private func stripScheme(_ s: String) -> String {
        if s.hasPrefix("https://") { return String(s.dropFirst("https://".count)) }
        if s.hasPrefix("http://") { return String(s.dropFirst("http://".count)) }
        return s
    }
}

struct ServiceDetailContainer: View {
    let serviceId: String
    @Binding var path: [AppsRoute]
    @Environment(\.screensClient) private var client
    @Environment(\.flagshipServerClient) private var server
    @Environment(\.serviceUninstallClient) private var uninstallClient
    @Environment(\.colorScheme) private var scheme
    @Environment(AppState.self) private var app
    @Environment(ToastCenter.self) private var toasts
    @State private var vm: ServiceDetailViewModel?
    /// Drives the destructive "Remove service" confirm dialog.
    @State private var confirmRemove = false

    /// The box this service runs on — the daemon there pins the owner IRK as
    /// `serverId`, so the signed uninstall must name the box the screens
    /// client is talking to, not the leader (they differ on multi-server
    /// accounts). Same resolution as the env editor / vibe-code containers.
    private var serverDomain: String {
        app.sessionPod?.fqdn ?? app.currentPod?.fqdn ?? app.leaderPod?.fqdn ?? app.pods.first?.fqdn ?? "unknown"
    }

    /// The box the screens client is talking to (the live session pod): a
    /// signed internet grant / access list must name it, not the leader.
    /// The view model asks the client first; this is the fallback.
    private var sessionServerDomain: String? {
        app.sessionPod?.fqdn ?? app.currentPod?.fqdn
    }

    var body: some View {
        let c = FSColors.scheme(scheme)
        ZStack(alignment: .top) {
            c.bg.ignoresSafeArea()
            if let vm {
                ServiceDetailScreen(
                    vm: vm,
                    username: app.currentUser,
                    pods: app.pods,
                    globalLeaderPodId: app.leaderPodId,
                    onSave: { Task { await save(vm: vm) } },
                    onRemove: { confirmRemove = true },
                    onOpenBrowserTabs: { path.append(.browserTabs(serviceId: serviceId)) },
                    onOpenCollaborators: { path.append(.inviteManage(serviceId: serviceId)) },
                    onOpenAccess: { path.append(.serviceAccess(serviceId: serviceId)) },
                    onOpenDatabase: { path.append(.appDatabase(serviceId: serviceId)) },
                    onEdit: { path.append(.editService(serviceId: serviceId)) },
                    canApproveEgress: !app.isRestrictedDevice
                )
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .confirmationDialog(
            "Remove this service?",
            isPresented: $confirmRemove,
            titleVisibility: .visible
        ) {
            Button("Remove service", role: .destructive) {
                if let vm { Task { await remove(vm: vm) } }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This uninstalls the service from \(serverDomain) and deletes its data. This can't be undone.")
        }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Button {
                        // W10 — open the per-app env-var KV editor.
                        // serviceId = "<creator>--<slug>"; split on the `--`
                        // delimiter (both halves may carry single dashes —
                        // docs/service-addressing-double-dash.md).
                        if let delim = serviceId.range(of: "--") {
                            let creator = String(serviceId[..<delim.lowerBound])
                            let slug = String(serviceId[delim.upperBound...])
                            path.append(.serviceEnv(appId: serviceId, creator: creator, slug: slug))
                        }
                    } label: {
                        Label("Configure environment", systemImage: "key")
                    }
                    .accessibilityIdentifier("service-detail-env-menu-item")
                } label: {
                    Image(systemName: "ellipsis.circle")
                }
            }
        }
        .task {
            if vm == nil {
                vm = ServiceDetailViewModel(
                    serviceId: serviceId,
                    client: client,
                    allPods: app.pods,
                    globalLeaderPodId: app.leaderPodId,
                    server: server,
                    username: { [app] in app.currentUser },
                    uninstallClient: uninstallClient,
                    serverDomain: serverDomain,
                    egressServerDomain: sessionServerDomain,
                    accessCanChange: !app.isRestrictedDevice
                )
            }
            await vm?.load()
            await vm?.loadAppLinks()
        }
    }

    private func save(vm: ServiceDetailViewModel) async {
        do {
            try await vm.save()
            toasts.success("Saved \(vm.serviceId).")
        } catch {
            toasts.error("Save failed. \(HumanError.humanize(error))")
        }
    }

    /// Sign + send the box-direct uninstall. On success, pop back to the
    /// services list (which reloads on path-empty) + toast; on failure, stay
    /// put and surface the humanized error.
    private func remove(vm: ServiceDetailViewModel) async {
        let slug = vm.detail.value?.app.slug ?? vm.serviceId
        let ok = await vm.uninstall()
        if ok {
            toasts.success("Removed \(slug).")
            // Pop straight back to the list root; ServicesTab reloads it.
            path.removeAll()
        } else if case .failed(let msg) = vm.removePhase {
            toasts.error(msg)
        } else {
            toasts.error("Couldn't remove the service. Try again in a moment.")
        }
    }
}

// One vibe-code session screen for both the fresh build (from Describe) and
// a reopened one (push deep link, operations sliver). The stream + the polled
// session state both live in VibeCodeSessionScreen.
struct VibeCodeSessionContainer: View {
    let sessionId: String
    @Environment(\.screensClient) private var client
    @Environment(ActiveOperationsCenter.self) private var operations
    @Environment(AppState.self) private var app
    @Environment(\.vibeCodeEnvelopeSigner) private var signer
    @State private var stream: VibeCodeStreamViewModel?

    var body: some View {
        Group {
            if let stream {
                VibeCodeSessionScreen(
                    stream: stream,
                    serverFqdn: app.sessionPod?.fqdn ?? app.currentPod?.fqdn ?? app.leaderPod?.fqdn ?? app.pods.first?.fqdn ?? "unknown",
                    client: client,
                    signEnvelope: signer,
                    savedCredential: {
                        VibeCodeCredentialSelection.compatible(with: SavedKeyStore().active()?.credential).credential
                    }
                )
            } else {
                ProgressView()
            }
        }
        .task {
            if stream == nil {
                // Surfaces the build in the global operations sliver as
                // "building … on <server>" while it runs.
                stream = VibeCodeStreamViewModel(
                    sessionId: sessionId,
                    client: client,
                    operations: operations,
                    serverLabel: app.currentPod?.name
                )
            }
        }
    }
}

// W10 — env editor container. Same envelope signer hook as the chat
// surface; signs via the platform Keystore in production.
struct ServiceEnvContainer: View {
    let appId: String
    let creator: String
    let slug: String
    @Environment(\.screensClient) private var client
    @Environment(AppState.self) private var app
    @Environment(\.vibeCodeEnvelopeSigner) private var signer

    var body: some View {
        ServiceEnvScreen(
            appId: appId,
            serverFqdn: app.sessionPod?.fqdn ?? app.currentPod?.fqdn ?? app.leaderPod?.fqdn ?? app.pods.first?.fqdn ?? "unknown",
            creator: creator,
            slug: slug,
            client: client,
            signEnvelope: signer
        )
    }
}

/// Starts an AI-chat session that changes an installed service.
struct EditDescribeContainer: View {
    let serviceId: String
    @Binding var path: [AppsRoute]
    let holder: BuildCredentialHolder
    @Environment(\.screensClient) private var client
    var body: some View {
        EditDescribeScreen(
            name: ServicesTab.slug(of: serviceId),
            onStart: { prompt in
                do {
                    let selection = VibeCodeCredentialSelection.compatible(with: holder.credential)
                    let resp = try await client.vibeCodeStart(VibeCodeStartRequest(
                        prompt: prompt, model: selection.model, credential: selection.credential,
                        editServiceId: serviceId
                    ))
                    if resp.needsCredential == true {
                        path.append(.buildKey(purpose: .edit(serviceId: serviceId)))
                        return nil
                    }
                    path.openEditSession(resp.sessionId, serviceId: serviceId)
                    return nil
                } catch {
                    return EditStartRefusal.from(error)
                }
            },
            onOpenSessions: { path.openBuildSessions() },
            onUseIDE: { path.append(.editMcp(serviceId: serviceId)) }
        )
    }
}

struct VibeCodeDescribeContainer: View {
    @Binding var path: [AppsRoute]
    let holder: BuildCredentialHolder
    @Environment(\.screensClient) private var client
    @Environment(\.secretMailboxClient) private var mailbox
    @Environment(ToastCenter.self) private var toasts
    @Environment(AppState.self) private var app
    var body: some View {
        VibeCodeDescribeScreen(onBuild: { prompt, name, visibility in
            do {
                // Seed the box's model with the credential chosen at the
                // AI-key step (kept on the holder so the describe screen
                // could re-render without losing it). Name + visibility are
                // the owner's choices on the form (no longer fixed).
                let selection = VibeCodeCredentialSelection.compatible(with: holder.credential)
                let resp = try await client.vibeCodeStart(
                    VibeCodeStartRequest(
                        prompt: prompt, model: selection.model, credential: selection.credential,
                        name: name, visibility: visibility
                    )
                )
                if resp.needsCredential == true {
                    // The box still has no usable model — route BACK into
                    // the AI-key step to provide one, then retry.
                    path.append(.buildKey(purpose: .scratch))
                    return nil
                }
                path.openVibeSession(resp.sessionId)
            } catch {
                if let taken = VibeCodeNameCheck.conflict(in: error) { return taken }
                switch await repairMissingServicePlatform(for: error) {
                case .accepted:
                    toasts.warning("This server was missing its app key. We sent it again; the server will restart within a few minutes. Then retry the build.")
                    return nil
                case .deferred:
                    toasts.warning("This server still needs its app key. Return Home, unlock the app if asked, and pull down to refresh before retrying.")
                    return nil
                case .notApplicable:
                    break
                }
                // Don't swallow — a tap that does nothing with no feedback
                // is a dead control. Surface the failure so the owner knows
                // the build didn't start (and a test can see why).
                toasts.error("Couldn't start the build: \(HumanError.humanize(error))")
            }
            return nil
        }, onOpenSessions: { path.openBuildSessions() })
    }

    private enum ServicePlatformRepair {
        case accepted, deferred, notApplicable
    }

    /// A platform-less secret-free box answers the vibe entry route with this
    /// exact 503. Re-arm the deterministic SWK delivery and immediately run the
    /// same owner-sealed deposit path Home uses; no key is exposed to `.com`.
    private func repairMissingServicePlatform(for error: Error) async -> ServicePlatformRepair {
        guard case let ScreensClientError.http(status, message) = error,
              status == 503,
              message.lowercased().contains("vibe-code not configured"),
              let username = app.currentUser,
              let pod = app.sessionPod,
              !pod.fqdn.isEmpty,
              !pod.identityPubKeyHex.isEmpty
        else { return .notApplicable }

        let store = PendingSwkDepositStore()
        store.markPending(for: pod.fqdn)
        let coordinator = SwkDepositCoordinator(
            username: username,
            mailbox: mailbox,
            store: store
        )
        await coordinator.depositIfNeeded(
            serverDomain: pod.fqdn,
            identityPubKeyHex: pod.identityPubKeyHex,
            allowAuthentication: true
        )
        return store.isDeposited(for: pod.fqdn) ? .accepted : .deferred
    }
}

// Build-a-service chooser container. The new create-a-service entry; fans
// into the build modes. Scratch reuses the existing vibe flow.
struct BuildSourceChooserContainer: View {
    @Binding var path: [AppsRoute]
    @Environment(\.screensClient) private var client
    @State private var activeSessions = 0
    var body: some View {
        BuildSourceChooserScreen(
            activeSessions: activeSessions,
            onScratch: { path.append(.buildKey(purpose: .scratch)) },
            onGit: { path.append(.buildGit) },
            onMcp: { path.append(.buildMcp) },
            onPastBuilds: { path.append(.buildJournal(buildId: nil)) }
        )
        // Re-counted each time the chooser shows (e.g. Back from a session).
        .task(id: path.count) {
            let sessions = (try? await client.vibeCodeSessions().sessions) ?? []
            activeSessions = sessions.filter(\.isActive).count
        }
    }
}

// git build mode container. Owns the BuildGitViewModel; a 503 on adapt
// pops back to the chooser and pushes the scratch flow. "Build with AI
// instead" routes through the AI-key step first; on return the chosen
// credential (held by `holder`) drives the adapt pass.
struct BuildGitContainer: View {
    @Binding var path: [AppsRoute]
    let holder: BuildCredentialHolder
    @Environment(\.screensClient) private var client
    @State private var vm: BuildGitViewModel?
    var body: some View {
        Group {
            if let vm {
                BuildGitScreen(
                    vm: vm,
                    onViewJournal: { id in path.append(.buildJournal(buildId: id)) },
                    onFallBackToScratch: { path.append(.buildKey(purpose: .scratch)) },
                    onBuildWithAI: {
                        guard let id = vm.buildId else { return }
                        path.append(.buildKey(purpose: .gitAdapt(buildId: id)))
                    },
                    onOpenSessions: { path.openBuildSessions() }
                )
                .onAppear {
                    // Returning from the AI-key step: a credential was chosen
                    // for THIS build → run the adapt pass with it (single use).
                    if let cred = holder.take() {
                        Task { await vm.adapt(credential: cred) }
                    }
                }
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .task { if vm == nil { vm = BuildGitViewModel(client: client) } }
    }
}

// AI-key step container. Confirms/provides the BYOK key the box's model
// uses, then dispatches per purpose: scratch seeds the describe flow; git
// adapt stashes the credential on the holder + pops back so the git
// container runs the adapt pass with it. Marketplace + MCP never reach here.
struct BuildKeyContainer: View {
    let purpose: BuildKeyPurpose
    @Binding var path: [AppsRoute]
    let holder: BuildCredentialHolder
    @State private var vm = BuildKeyViewModel()

    private var contextLabel: String {
        switch purpose {
        case .scratch:  return "Start from scratch with AI"
        case .edit:     return "Changing a service with AI"
        case .gitAdapt: return "Building this repo with AI"
        }
    }

    var body: some View {
        BuildKeyScreen(vm: vm, contextLabel: contextLabel) { cred in
            holder.credential = cred
            switch purpose {
            case .scratch:
                path.append(.vibeCodeDescribe)
            case .edit(let serviceId):
                path.append(.editDescribe(serviceId: serviceId))
            case .gitAdapt:
                // Pop back to the git screen; its onAppear takes the
                // credential off the holder + runs the adapt pass.
                if path.count > 0 { path.removeLast() }
            }
        }
    }
}

// mcp build mode container. Copy goes through UIPasteboard + a toast.
struct BuildMcpContainer: View {
    @Binding var path: [AppsRoute]
    var editServiceId: String? = nil
    @Environment(\.screensClient) private var client
    @Environment(ToastCenter.self) private var toasts
    @State private var vm: BuildMcpViewModel?
    var body: some View {
        Group {
            if let vm {
                BuildMcpScreen(
                    vm: vm,
                    onViewJournal: { id in path.append(.buildJournal(buildId: id)) },
                    onCopy: { text, msg in
                        UIPasteboard.general.string = text
                        toasts.success(msg)
                    }
                )
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .task { if vm == nil { vm = BuildMcpViewModel(client: client, editServiceId: editServiceId) } }
    }
}

// Build-journal container. Opens the list, or a specific build's timeline
// when `buildId` is non-nil.
struct BuildJournalContainer: View {
    let buildId: String?
    var onResume: (String) -> Void = { _ in }
    @Environment(\.screensClient) private var client
    @State private var vm: BuildJournalViewModel?
    var body: some View {
        Group {
            if let vm {
                BuildJournalScreen(vm: vm, onResume: onResume)
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .task {
            if vm == nil {
                let model = BuildJournalViewModel(client: client)
                vm = model
                if let buildId {
                    await model.loadDetail(buildId: buildId)
                } else {
                    await model.loadList()
                }
            }
        }
    }
}

// P8 — browser-tabs list container. Loads the tab list for an app and
// pushes the viewer onto the nav stack when a row is tapped.
struct BrowserTabsContainer: View {
    let serviceId: String
    @Binding var path: [AppsRoute]
    @Environment(\.screensClient) private var client
    @State private var vm: BrowserTabsViewModel?

    var body: some View {
        Group {
            if let vm {
                BrowserTabsScreen(vm: vm, onPick: { tab in
                    path.append(.browserViewer(serviceId: serviceId, tabId: tab.tabId))
                })
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .task {
            if vm == nil { vm = BrowserTabsViewModel(serviceId: serviceId, client: client) }
        }
    }
}

// P8 — viewer container. Owns the BrowserViewerViewModel lifecycle so
// the WS gets started/stopped with the screen.
struct BrowserViewerContainer: View {
    let tabId: String
    @Environment(\.screensClient) private var client
    @State private var vm: BrowserViewerViewModel?

    var body: some View {
        Group {
            if let vm {
                BrowserViewerScreen(vm: vm)
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .task {
            if vm == nil { vm = BrowserViewerViewModel(tabId: tabId, client: client) }
        }
    }
}

// P6 — Collaborator-invite manage container. Loads pending invites +
// active access via the BFF; exposes a "+ Issue invite" entry that
// pushes the issue screen onto the same nav stack. Labels are resolved
// from the local-only InviteLabelBook — never via the wire.
struct InviteManageContainer: View {
    let serviceId: String
    @Binding var path: [AppsRoute]
    @Environment(\.screensClient) private var client
    @Environment(\.inviteLabelBook) private var labelBook
    @State private var vm: InviteManageViewModel?
    @State private var appUrl: String = ""

    var body: some View {
        Group {
            if let vm, !appUrl.isEmpty {
                InviteManageScreen(
                    vm: vm,
                    appLabel: appLabel(for: serviceId),
                    appUrlForShare: appUrl,
                    onIssueTapped: { path.append(.inviteIssue(serviceId: serviceId)) }
                )
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .task {
            if appUrl.isEmpty {
                appUrl = await resolveAppShareUrl(serviceId: serviceId, client: client)
            }
            if vm == nil {
                vm = InviteManageViewModel(
                    serviceId: serviceId,
                    client: client,
                    labelBook: labelBook
                )
            }
        }
    }

    private func appLabel(for serviceId: String) -> String {
        if let delim = serviceId.range(of: "--") {
            return String(serviceId[delim.upperBound...]).capitalized
        }
        return serviceId
    }
}

/// #92 — host for the per-service access-gating ("Who can open this") admin
/// surface. Resolves the box this service runs on (the daemon there pins the
/// owner IRK as `serverId`, so the set-mode + redeem envelopes target it,
/// matching the env-editor / uninstall resolution) + the current username.
struct ServiceAccessContainer: View {
    let serviceId: String
    @Environment(AppState.self) private var app

    private var serverDomain: String {
        app.sessionPod?.fqdn ?? app.currentPod?.fqdn ?? app.leaderPod?.fqdn ?? app.pods.first?.fqdn ?? "unknown"
    }

    private var serviceLabel: String {
        if let delim = serviceId.range(of: "--") {
            return String(serviceId[delim.upperBound...]).capitalized
        }
        return serviceId
    }

    var body: some View {
        ServiceAccessScreen(
            serverDomain: serverDomain,
            serviceRef: serviceId,
            serviceLabel: serviceLabel,
            username: app.currentUser ?? "you"
        )
    }
}

/// Share-URL root for an installed app — the tier-1 canonical URL of THIS
/// box's instance (`https://<urlLabel>.<server>.<user>.flagship.services`),
/// the only form the box's per-box wildcard cert covers (model A′). The
/// daemon's app-detail response carries it as `app.url`; we never derive a
/// `<slug>.<creator>` (tier-2) form locally — that name has no valid cert
/// until the shared service-cert phase ships. Last-resort fallback (detail
/// fetch failed) keeps the URL syntactically valid for the share sheet.
private func resolveAppShareUrl(serviceId: String, client: any ScreensClient) async -> String {
    if let url = try? await client.appDetail(serviceId: serviceId).app.url {
        return url
    }
    return "https://\(serviceId).\(Endpoints.dataApex)"
}

// P6 — Issue container. Owns the issue ViewModel; on success the
// InviteIssueScreen renders the share URL + share-sheet locally and
// the user can pop back to InviteManage manually.
struct InviteIssueContainer: View {
    let serviceId: String
    @Binding var path: [AppsRoute]
    @Environment(\.screensClient) private var client
    @Environment(\.inviteLabelBook) private var labelBook
    @State private var vm: InviteIssueViewModel?

    var body: some View {
        Group {
            if let vm {
                InviteIssueScreen(
                    vm: vm,
                    appLabel: appLabel(for: serviceId)
                )
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .task {
            if vm == nil {
                let appUrl = await resolveAppShareUrl(serviceId: serviceId, client: client)
                vm = InviteIssueViewModel(
                    serviceId: serviceId,
                    appUrl: appUrl,
                    client: client,
                    labelBook: labelBook
                )
            }
        }
    }

    private func appLabel(for serviceId: String) -> String {
        if let delim = serviceId.range(of: "--") {
            return String(serviceId[delim.upperBound...]).capitalized
        }
        return serviceId
    }
}
