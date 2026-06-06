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
                        header(c: c, vm: vm)
                        searchBar(vm: vm)
                        emptyOrList(vm: vm, c: c)
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

    @ViewBuilder
    private func header(c: FSColors, vm: ServicesListViewModel) -> some View {
        VStack(alignment: .leading, spacing: FS.space.s2) {
            HStack {
                Text("Services")
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
        FSField(value: $bindable.searchQuery, label: "", placeholder: "Search services")
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
            if vm.filteredApps.isEmpty {
                FSCard {
                    VStack(alignment: .leading, spacing: FS.space.s3) {
                        Text("Build your first service").font(FS.font.h3()).foregroundColor(c.text)
                        Text("Describe it in plain English. The AI writes it, the daemon runs it.")
                            .font(FS.font.body()).foregroundColor(c.textMuted)
                        FSPrimaryButton("Build a service", block: true) {
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
                            Text("Build another service").foregroundColor(c.text)
                            Spacer()
                            Image(systemName: "plus.circle.fill").foregroundColor(c.primary)
                        }
                    }
                }.buttonStyle(.plain)
            }
            }
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

    var body: some View {
        Group {
            if let vm {
                InviteManageScreen(
                    vm: vm,
                    appLabel: appLabel(for: serviceId),
                    appUrlForShare: appShareUrl(for: serviceId),
                    onIssueTapped: { path.append(.inviteIssue(serviceId: serviceId)) }
                )
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .task {
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

    /// Best-effort share-URL root. The real value lands via app-detail
    /// when wired; for the issuance screen we synthesize a canonical
    /// "<slug>.<creator>.flagship.services" form so the share URL is
    /// well-formed in dev — production replaces it via the app-detail
    /// response.
    private func appShareUrl(for serviceId: String) -> String {
        if let dashIdx = serviceId.firstIndex(of: "-") {
            let creator = String(serviceId[..<dashIdx])
            let slug = String(serviceId[serviceId.index(after: dashIdx)...])
            return "https://\(slug).\(creator).flagship.services"
        }
        return "https://\(serviceId).flagship.services"
    }
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
                vm = InviteIssueViewModel(
                    serviceId: serviceId,
                    appUrl: appShareUrl(for: serviceId),
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

    private func appShareUrl(for serviceId: String) -> String {
        if let dashIdx = serviceId.firstIndex(of: "-") {
            let creator = String(serviceId[..<dashIdx])
            let slug = String(serviceId[serviceId.index(after: dashIdx)...])
            return "https://\(slug).\(creator).flagship.services"
        }
        return "https://\(serviceId).flagship.services"
    }
}
