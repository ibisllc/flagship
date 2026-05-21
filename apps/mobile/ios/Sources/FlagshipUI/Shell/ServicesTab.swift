import SwiftUI
import FlagshipCore
import FlagshipAPI

/// Services tab: list → detail; marketplace; vibe-code launcher. Owns its
/// own NavigationStack with AppsRoute as the path element type. Surfaces
/// as "Apps" in the UI for user-facing familiarity.
public struct ServicesTab: View {
    @Environment(\.screensClient) private var client
    @Environment(\.flagshipServerClient) private var server
    @Environment(\.colorScheme) private var scheme
    @Environment(AppState.self) private var app
    @Environment(DeepLinker.self) private var linker

    @State private var path: [AppsRoute] = []
    @State private var vm: ServicesListViewModel?

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
                        header(c: c, vm: vm)
                        searchBar(vm: vm)
                        emptyOrList(vm: vm, c: c)
                        marketplaceCard(c: c)
                        Spacer().frame(height: FS.space.s12)
                    }
                    .padding(.horizontal, FS.space.s6)
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
        case .vibeCodeProviderPick:
            VibeCodeProviderPickScreen(
                onPickPromo: { path.append(.vibeCodeDescribe) },
                onPickBYOK: { path.append(.vibeCodeDescribe) }
            )
        case .vibeCodeDescribe:
            VibeCodeDescribeContainer(path: $path)
        case .vibeCodeGenerating(let sessionId):
            VibeCodeGeneratingContainer(sessionId: sessionId)
        case .vibeCodeChat(let sessionId):
            VibeCodeChatContainer(sessionId: sessionId)
        case .serviceEnv(let appId, let creator, let slug):
            ServiceEnvContainer(appId: appId, creator: creator, slug: slug)
        }
    }

    @ViewBuilder
    private func header(c: FSColors, vm: ServicesListViewModel) -> some View {
        VStack(alignment: .leading, spacing: FS.space.s2) {
            HStack {
                Text("Apps")
                    .font(.system(size: 32, weight: .medium))
                    .foregroundColor(c.text)
                Spacer()
                // V8 — repurpose the existing top-right PodSwitcher on
                // the Apps tab as the server filter. `currentPodId`
                // tracks vm.serverFilter (nil = "All servers"); picking
                // a pod sets the filter rather than mutating the
                // global AppState pod context. The "All servers" entry
                // sits at the top of the menu.
                if app.pods.count > 1 {
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
            Text(headerSubtitle)
                .font(.system(size: 17))
                .foregroundColor(c.textMuted)
        }
        .padding(.top, FS.space.s10)
    }

    private var headerSubtitle: String {
        guard let apps = vm?.state.value else { return " " }
        return apps.isEmpty ? "Nothing installed yet." : "\(apps.count) installed"
    }

    @ViewBuilder
    private func searchBar(vm: ServicesListViewModel) -> some View {
        @Bindable var bindable = vm
        FSField(value: $bindable.searchQuery, label: "", placeholder: "Search apps")
    }

    @ViewBuilder
    private func emptyOrList(vm: ServicesListViewModel, c: FSColors) -> some View {
        switch vm.state {
        case .idle, .loading:
            VStack(spacing: FS.space.s3) {
                ForEach(0..<3) { _ in ServerCardSkeleton() }
            }
        case .failed(let msg):
            ErrorCard(message: msg)
        case .loaded:
            if vm.filteredApps.isEmpty {
                FSCard {
                    VStack(alignment: .leading, spacing: FS.space.s3) {
                        Text("Build your first app").font(FS.font.h3()).foregroundColor(c.text)
                        Text("Describe it in plain English. The AI writes it, the daemon runs it.")
                            .font(FS.font.body()).foregroundColor(c.textMuted)
                        FSPrimaryButton("Vibe-code an app", block: true) {
                            path.append(.vibeCodeProviderPick)
                        }
                    }
                }
            } else {
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 280), spacing: FS.space.s3)], spacing: FS.space.s3) {
                    ForEach(vm.filteredApps, id: \.serviceId) { appItem in
                        Button(action: { path.append(.appDetail(serviceId: appItem.serviceId)) }) {
                            AppRow(app: appItem, links: vm.linksByServiceId[appItem.serviceId])
                        }
                        .buttonStyle(.plain)
                    }
                }
                Button(action: { path.append(.vibeCodeProviderPick) }) {
                    FSCard {
                        HStack(spacing: FS.space.s3) {
                            Image(systemName: "sparkles").foregroundColor(c.primary)
                            Text("Build another app").foregroundColor(c.text)
                            Spacer()
                            Image(systemName: "plus.circle.fill").foregroundColor(c.primary)
                        }
                    }
                }.buttonStyle(.plain)
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
                        Text("Apps your neighbours built").font(FS.font.caption()).foregroundColor(c.textMuted)
                    }
                    Spacer()
                    Image(systemName: "chevron.right").foregroundColor(c.textMuted)
                }
            }
        }.buttonStyle(.plain)
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

    var body: some View {
        let c = FSColors.scheme(scheme)
        FSCard {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: FS.space.s2) {
                    // Name (semibold).
                    Text(app.slug.capitalized)
                        .font(.system(size: 17, weight: .semibold))
                        .foregroundColor(c.text)
                    // Short description (if any). Muted, two lines max.
                    if let summary = app.summary {
                        Text(summary)
                            .font(FS.font.bodySm())
                            .foregroundColor(c.textMuted)
                            .lineLimit(2)
                    }
                    // Status pills.
                    HStack(spacing: FS.space.s2) {
                        FSPill(
                            app.status == "running" ? "Running" : "Stopped",
                            kind: app.status == "running" ? .online : .idle
                        )
                        if let v = app.version { FSPill("v\(v)", kind: .idle) }
                    }
                    // URLs row: short URL (bold, with copy) + canonical
                    // (muted, truncated). Short is what people share;
                    // canonical is there for power-user verification.
                    urlRow(c: c)
                }
                Spacer(minLength: FS.space.s2)
                Image(systemName: "chevron.right").foregroundColor(c.textMuted)
            }
        }
    }

    @ViewBuilder
    private func urlRow(c: FSColors) -> some View {
        // V7 — short link on top (single line + copy), canonical
        // BELOW it on its own line. Canonical takes the full width
        // of the row + truncates with middle-ellipsis on overflow.
        // No icons either side; the section header tells us what
        // group each URL belongs to.
        // A custom domain takes the short link's slot ONLY once .com
        // has confirmed it — that swap is the subtle "it's live" cue.
        let confirmedCustom = (links?.customDomainConfirmed == true)
            ? links?.customDomain.map { "https://\($0)" }
            : nil
        let short = confirmedCustom ?? links?.shortUrl
        let canonical = links?.canonicalUrl ?? "https://\(app.urlLabel)…"
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: FS.space.s2) {
                if let short, !short.isEmpty {
                    Text(stripScheme(short))
                        .font(.system(size: 13, weight: .semibold, design: .monospaced))
                        .foregroundColor(c.text)
                        .lineLimit(1)
                    Button {
                        #if canImport(UIKit)
                        UIPasteboard.general.string = short
                        #endif
                    } label: {
                        Image(systemName: "doc.on.doc")
                            .foregroundColor(c.textMuted)
                            .imageScale(.small)
                    }
                    .buttonStyle(.plain)
                } else {
                    // Fallback that should never actually render in
                    // production — the Worker lazy-mints on first
                    // /links call, and the Mock returns a populated
                    // shortUrl. Kept so a transient network blip
                    // doesn't show a blank row.
                    Text("voi.ci/…")
                        .font(.system(size: 13, design: .monospaced))
                        .foregroundColor(c.textMuted)
                }
                Spacer()
            }
            // Canonical on a line of its own, full-width, middle-
            // ellipsis on overflow. Single line is fine here — the
            // user knows the rough shape; full URL lives on the
            // detail screen.
            Text(stripScheme(canonical))
                .font(.system(size: 11, design: .monospaced))
                .foregroundColor(c.textMuted)
                .lineLimit(1)
                .truncationMode(.middle)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
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
                    onRemove: { toasts.warning("Remove flow not wired yet.") }
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
            toasts.error("Save failed: \(error.localizedDescription)")
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
    @State private var vm: MarketplaceViewModel?

    var body: some View {
        let c = FSColors.scheme(scheme)
        ScrollView {
            VStack(alignment: .leading, spacing: FS.space.s4) {
                Text("Marketplace").font(.system(size: 32, weight: .medium)).foregroundColor(c.text)
                Text("Apps your neighbours built. One tap to install.")
                    .font(.system(size: 17)).foregroundColor(c.textMuted)
                if let vm {
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
    @State private var listing: MarketplaceListing?

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
                    FSPrimaryButton("Deploy", block: true, large: true) {}
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
}

struct VibeCodeDescribeContainer: View {
    @Binding var path: [AppsRoute]
    @Environment(\.screensClient) private var client
    var body: some View {
        VibeCodeDescribeScreen(onBuild: { prompt in
            Task {
                do {
                    let resp = try await client.vibeCodeStart(VibeCodeStartRequest(prompt: prompt, model: nil))
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
            if vm == nil { vm = VibeCodeStreamViewModel(sessionId: sessionId, client: client) }
        }
    }
}
