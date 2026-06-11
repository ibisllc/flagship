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
        case .vibeCodeChat(let sessionId):
            if path.last != .vibeCodeChat(sessionId: sessionId) {
                path.append(.vibeCodeChat(sessionId: sessionId))
            }
            _ = linker.consume()
        case .startVibeCode:
            if path.last != .vibeCodeProviderPick {
                path.append(.vibeCodeProviderPick)
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
                .navigationTitle("Apps")
                .navigationBarTitleDisplayMode(sizeClass == .regular ? .inline : .large)
                .searchable(text: searchBinding(vm: vm), placement: .navigationBarDrawer(displayMode: .automatic), prompt: "Search apps")
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
                    Text("Apps run on your own server. Add one to start building.")
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
                        Text("Build your first app").font(FS.font.h3()).foregroundColor(c.text)
                        Text("Describe it in plain English. The AI writes it, the daemon runs it.")
                            .font(FS.font.body()).foregroundColor(c.textMuted)
                        FSPrimaryButton("Build an app", block: true) {
                            path.append(.vibeCodeProviderPick)
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
                Button(action: { path.append(.vibeCodeProviderPick) }) {
                    HStack(spacing: 8) {
                        Image(systemName: "sparkles").foregroundColor(c.primary)
                        Text("Build another app").font(.system(size: 15, weight: .semibold)).foregroundColor(c.primary)
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
