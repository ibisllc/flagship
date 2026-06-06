import SwiftUI
import Flagship
import FlagshipCore
import FlagshipAPI

/// Services tab: list → detail; marketplace; vibe-code launcher. Owns its
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
    }

    private func consume(_ link: DeepLink?) {
        guard let link else { return }
        switch link {
        case .appDetail(let id):
            if path.last != .appDetail(serviceId: id) {
                path.append(.appDetail(serviceId: id))
            }
            _ = linker.consume()
        case .marketplace:
            if !path.contains(.marketplace) {
                path.append(.marketplace)
            }
            _ = linker.consume()
        case .vibeCodeChat(let sessionId):
            if path.last != .vibeCodeChat(sessionId: sessionId) {
                path.append(.vibeCodeChat(sessionId: sessionId))
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
                        marketplaceCard(c: c)
                        Spacer().frame(height: FS.space.s12)
                    }
                    .padding(.horizontal, FS.space.s6)
                    .padding(.top, FS.space.s2)
                    .fsReadingColumn()
                }
                .navigationTitle("Services")
                .navigationBarTitleDisplayMode(sizeClass == .regular ? .inline : .large)
                .searchable(text: searchBinding(vm: vm), placement: .navigationBarDrawer(displayMode: .automatic), prompt: "Search services")
                .toolbar {
                    // V8 — server filter stays as the top-right PodSwitcher.
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
        case .marketplace:
            MarketplaceContainer(path: $path)
        case .marketplaceDetail(let creator, let slug):
            MarketplaceDetailContainer(creator: creator, slug: slug)
        case .buildSource:
            BuildSourceChooserContainer(path: $path)
        case .buildGit:
            BuildGitContainer(path: $path, holder: buildCred)
        case .buildMcp:
            BuildMcpContainer(path: $path)
        case .buildJournal(let buildId):
            BuildJournalContainer(buildId: buildId)
        case .buildKey(let purpose):
            BuildKeyContainer(purpose: purpose, path: $path, holder: buildCred)
        case .vibeCodeProviderPick:
            VibeCodeProviderPickScreen(
                onPickPromo: { path.append(.vibeCodeDescribe) },
                onPickBYOK: { path.append(.vibeCodeDescribe) }
            )
        case .vibeCodeDescribe:
            VibeCodeDescribeContainer(path: $path, holder: buildCred)
        case .vibeCodeGenerating(let sessionId):
            VibeCodeGeneratingContainer(sessionId: sessionId)
        case .vibeCodeChat(let sessionId):
            VibeCodeChatContainer(sessionId: sessionId)
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
        }
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
                        Text("Describe it in plain English. The AI writes it, the daemon runs it.")
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

    private func marketplaceCard(c: FSColors) -> some View {
        Button(action: { path.append(.marketplace) }) {
            FSCard {
                HStack(spacing: FS.space.s3) {
                    Image(systemName: "square.grid.2x2").foregroundColor(c.success)
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Marketplace").foregroundColor(c.text)
                        Text("Services your neighbours built").font(FS.font.caption()).foregroundColor(c.textMuted)
                    }
                    Spacer()
                    Image(systemName: "chevron.right").foregroundColor(c.textMuted)
                }
            }
        }.buttonStyle(.plain)
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
    @Environment(\.colorScheme) private var scheme
    @Environment(AppState.self) private var app
    @Environment(ToastCenter.self) private var toasts
    @State private var vm: ServiceDetailViewModel?

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
                    onRemove: { toasts.warning("Remove flow not wired yet.") },
                    onOpenBrowserTabs: { path.append(.browserTabs(serviceId: serviceId)) },
                    onOpenCollaborators: { path.append(.inviteManage(serviceId: serviceId)) }
                )
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Button {
                        // W10 — open the per-app env-var KV editor.
                        // serviceId = "<creator>-<slug>"; split at the
                        // first '-' (creator is hyphen-free).
                        if let dashIdx = serviceId.firstIndex(of: "-") {
                            let creator = String(serviceId[..<dashIdx])
                            let slug = String(serviceId[serviceId.index(after: dashIdx)...])
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
                    username: { [app] in app.currentUser }
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
}

// W10 — chat-surface container. Resolves the serverFqdn from AppState
// and wires a default signEnvelope closure that's a no-op stub for
// previews; production replaces this via an environment value.
struct VibeCodeChatContainer: View {
    let sessionId: String
    @Environment(\.screensClient) private var client
    @Environment(AppState.self) private var app
    @Environment(\.vibeCodeEnvelopeSigner) private var signer

    var body: some View {
        VibeCodeChatScreen(
            sessionId: sessionId,
            serverFqdn: app.leaderPod?.fqdn ?? app.pods.first?.fqdn ?? "unknown",
            username: app.currentUser ?? "user",
            client: client,
            signEnvelope: signer
        )
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
            serverFqdn: app.leaderPod?.fqdn ?? app.pods.first?.fqdn ?? "unknown",
            creator: creator,
            slug: slug,
            client: client,
            signEnvelope: signer
        )
    }
}

struct MarketplaceContainer: View {
    @Binding var path: [AppsRoute]
    @Environment(\.screensClient) private var client
    @Environment(\.colorScheme) private var scheme
    @Environment(AppState.self) private var app
    @State private var vm: MarketplaceViewModel?

    var body: some View {
        let c = FSColors.scheme(scheme)
        ScrollView {
            VStack(alignment: .leading, spacing: FS.space.s4) {
                Text("Marketplace").font(.system(size: 32, weight: .medium)).foregroundColor(c.text)
                Text("Services your neighbours built. One tap to install.")
                    .font(.system(size: 17)).foregroundColor(c.textMuted)
                if app.pods.isEmpty {
                    // The marketplace is a catalog, browsable before you
                    // own a server. Until the central catalog ships, show
                    // a friendly placeholder instead of a "not paired" error.
                    FSCard {
                        Text("The marketplace is coming soon.")
                            .foregroundColor(c.textMuted)
                    }
                } else if let vm {
                    @Bindable var bindable = vm
                    FSField(value: $bindable.searchQuery, label: "", placeholder: "Search marketplace")
                    switch vm.state {
                    case .idle, .loading:
                        VStack { ForEach(0..<3) { _ in ServerCardSkeleton() } }
                    case .failed(let msg):
                        ErrorCard(message: msg)
                    case .loaded:
                        LazyVGrid(columns: [GridItem(.adaptive(minimum: 280), spacing: FS.space.s3)], spacing: FS.space.s3) {
                            ForEach(vm.filtered, id: \.slug) { listing in
                                Button(action: { path.append(.marketplaceDetail(creator: listing.creator, slug: listing.slug)) }) {
                                    listingRow(listing: listing, c: c)
                                }.buttonStyle(.plain)
                            }
                        }
                    }
                }
            }
            .padding(FS.space.s6)
        }
        .background(c.bg.ignoresSafeArea())
        .navigationTitle("")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            guard !app.pods.isEmpty else { return }
            if vm == nil { vm = MarketplaceViewModel(client: client) }
            if case .idle = vm?.state { await vm?.load() }
        }
    }

    private func listingRow(listing: MarketplaceListing, c: FSColors) -> some View {
        FSCard {
            VStack(alignment: .leading, spacing: FS.space.s2) {
                Text(listing.title).font(.system(size: 17, weight: .semibold)).foregroundColor(c.text)
                Text("by \(listing.creator)").font(FS.font.caption()).foregroundColor(c.textMuted)
                Text(listing.summary).font(FS.font.bodySm()).foregroundColor(c.textMuted)
                HStack(spacing: FS.space.s2) {
                    FSPill("\(listing.installCount) deploys", kind: listing.installCount > 0 ? .online : .idle)
                    if listing.requiresLlmKey { FSPill("Needs LLM key", kind: .provisioning) }
                    if listing.alreadyInstalled { FSPill("Deployed", kind: .idle) }
                }
            }
        }
    }
}

struct MarketplaceDetailContainer: View {
    let creator: String
    let slug: String
    @Environment(\.screensClient) private var client
    @Environment(\.colorScheme) private var scheme
    @Environment(AppState.self) private var app
    @State private var listing: MarketplaceListing?
    @State private var installState: InstallState = .idle

    enum InstallState: Equatable {
        case idle
        case installing
        case succeeded(serviceId: String)
        case failed(message: String)
    }

    var body: some View {
        let c = FSColors.scheme(scheme)
        ScrollView {
            VStack(alignment: .leading, spacing: FS.space.s4) {
                if let l = listing {
                    Text(l.title).font(FS.font.h2()).foregroundColor(c.text)
                    Text("by \(l.creator)").foregroundColor(c.textMuted)
                    FSCard { Text(l.summary).foregroundColor(c.text) }
                    HStack {
                        FSPill("\(l.installCount) deploys", kind: .online)
                        if l.requiresLlmKey { FSPill("Needs LLM key", kind: .provisioning) }
                    }
                    installControls(listing: l, c: c)
                    FSGhostButton("View source", block: true) {}
                } else {
                    ServerCardSkeleton()
                }
            }
            .padding(FS.space.s6)
        }
        .background(c.bg.ignoresSafeArea())
        .navigationTitle("")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            let resp = (try? await client.marketplaceBrowse())?.listings ?? []
            listing = resp.first(where: { $0.creator == creator && $0.slug == slug })
        }
    }

    @ViewBuilder
    private func installControls(listing l: MarketplaceListing, c: FSColors) -> some View {
        switch installState {
        case .idle:
            FSPrimaryButton(
                l.alreadyInstalled ? "Already installed" : "Deploy",
                enabled: !l.alreadyInstalled,
                block: true,
                large: true
            ) {
                Task { await runInstall(creator: l.creator, slug: l.slug) }
            }
            .accessibilityIdentifier("marketplace-deploy-button")
        case .installing:
            FSPrimaryButton("Installing…", enabled: false, block: true, large: true) {}
                .accessibilityIdentifier("marketplace-deploy-installing")
            ProgressView().padding(.top, FS.space.s2)
        case .succeeded(let serviceId):
            FSCard {
                HStack(spacing: FS.space.s2) {
                    Image(systemName: "checkmark.circle.fill").foregroundColor(c.success)
                    Text("Installed as \(serviceId).")
                        .font(FS.font.bodySm())
                        .foregroundColor(c.text)
                }
            }
            .accessibilityIdentifier("marketplace-deploy-success")
        case .failed(let message):
            ErrorCard(message: "Install failed: \(message)")
                .accessibilityIdentifier("marketplace-deploy-error")
            FSGhostButton("Try again", block: true) {
                installState = .idle
            }
        }
    }

    private func runInstall(creator: String, slug: String) async {
        installState = .installing
        do {
            // Fetch the full listing (manifestJson lives only on the
            // single-listing endpoint; marketplaceBrowse returns metadata
            // only). Mirrors the webapp's two-step fetch in
            // `installFromMarketplace`.
            let detail = try await client.marketplaceFetchListing(creator: creator, slug: slug)
            guard let serverFqdn = app.currentPod?.fqdn else {
                installState = .failed(message: "no pod paired yet")
                return
            }
            let issuedAt = Int64(Date().timeIntervalSince1970 * 1000)
            let request = InstallServiceRequest(
                serverId: serverFqdn,
                creator: creator,
                slug: slug,
                manifestJson: detail.manifestJson,
                addOwnerToMembership: true,
                issuedAt: issuedAt
            )
            let irk = try await Keystore.deriveIRK(reason: "Install \(creator)/\(slug)")
            let sig = try irk.signature(for: installServiceCanonicalBytes(request))
            let envelope = InstallServiceEnvelope(
                request: request,
                signature: HexUtil.encode(sig)
            )
            let resp = try await client.installFromMarketplace(envelope)
            installState = .succeeded(serviceId: resp.serviceId)
        } catch let e as ScreensClientError {
            installState = .failed(message: e.errorDescription ?? "unknown error")
        } catch {
            installState = .failed(message: error.localizedDescription)
        }
    }
}

struct VibeCodeDescribeContainer: View {
    @Binding var path: [AppsRoute]
    let holder: BuildCredentialHolder
    @Environment(\.screensClient) private var client
    var body: some View {
        VibeCodeDescribeScreen(onBuild: { prompt in
            Task {
                do {
                    // Seed the box's model with the credential chosen at the
                    // AI-key step (kept on the holder so the describe screen
                    // could re-render without losing it).
                    let cred = holder.credential
                    let resp = try await client.vibeCodeStart(
                        VibeCodeStartRequest(prompt: prompt, model: nil, credential: cred)
                    )
                    if resp.needsCredential == true {
                        // The box still has no usable model — route BACK into
                        // the AI-key step to provide one, then retry.
                        path.append(.buildKey(purpose: .scratch))
                        return
                    }
                    path.append(.vibeCodeGenerating(sessionId: resp.sessionId))
                } catch {
                    // surface error toast later
                }
            }
        })
    }
}

struct VibeCodeGeneratingContainer: View {
    let sessionId: String
    @Environment(\.screensClient) private var client
    @Environment(ActiveOperationsCenter.self) private var operations
    @Environment(AppState.self) private var app
    @State private var vm: VibeCodeStreamViewModel?

    var body: some View {
        ZStack {
            FSColors.scheme(.light).bg.ignoresSafeArea()
            if let vm {
                VibeCodeGeneratingScreen(vm: vm)
            } else {
                ProgressView()
            }
        }
        .task {
            if vm == nil {
                // The build runs on the currently-selected box; surface it in
                // the global operations sliver as "building … on <server>".
                vm = VibeCodeStreamViewModel(
                    sessionId: sessionId,
                    client: client,
                    operations: operations,
                    serverLabel: app.currentPod?.name
                )
            }
        }
    }
}

// Build-a-service chooser container. The new create-a-service entry; fans
// into the build modes. Scratch reuses the existing vibe flow.
struct BuildSourceChooserContainer: View {
    @Binding var path: [AppsRoute]
    var body: some View {
        BuildSourceChooserScreen(
            onScratch: { path.append(.buildKey(purpose: .scratch)) },
            onGit: { path.append(.buildGit) },
            onMcp: { path.append(.buildMcp) },
            onPastBuilds: { path.append(.buildJournal(buildId: nil)) }
        )
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
                    }
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
        case .gitAdapt: return "Building this repo with AI"
        }
    }

    var body: some View {
        BuildKeyScreen(vm: vm, contextLabel: contextLabel) { cred in
            holder.credential = cred
            switch purpose {
            case .scratch:
                path.append(.vibeCodeDescribe)
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
        .task { if vm == nil { vm = BuildMcpViewModel(client: client) } }
    }
}

// Build-journal container. Opens the list, or a specific build's timeline
// when `buildId` is non-nil.
struct BuildJournalContainer: View {
    let buildId: String?
    @Environment(\.screensClient) private var client
    @State private var vm: BuildJournalViewModel?
    var body: some View {
        Group {
            if let vm {
                BuildJournalScreen(vm: vm)
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
        if let dashIdx = serviceId.firstIndex(of: "-") {
            return String(serviceId[serviceId.index(after: dashIdx)...]).capitalized
        }
        return serviceId
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
    return "https://\(serviceId).flagship.services"
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
        if let dashIdx = serviceId.firstIndex(of: "-") {
            return String(serviceId[serviceId.index(after: dashIdx)...]).capitalized
        }
        return serviceId
    }
}
