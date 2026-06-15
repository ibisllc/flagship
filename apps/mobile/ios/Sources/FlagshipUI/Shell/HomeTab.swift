import SwiftUI
import Flagship
import FlagshipCore
import FlagshipAPI

/// Home tab. Account-wide overview + drill-down into individual servers.
public struct HomeTab: View {
    @Environment(\.screensClient) private var client
    @Environment(\.flagshipServerClient) private var server
    @Environment(\.secretMailboxClient) private var mailbox
    @Environment(AppState.self) private var app
    @Environment(DeepLinker.self) private var linker
    @Environment(ToastCenter.self) private var toasts

    @State private var path: [HomeRoute] = []
    @State private var vm: HomeViewModel?
    /// #43 — guards the IRK-signed outstanding-orders reconcile to once per
    /// session on the cheap appearance path (it derives the biometric-gated
    /// IRK, so we don't fire it on every Home re-render). An explicit pull-
    /// to-refresh always re-runs it.
    @State private var didReconcileServerTruth = false
    /// Account-level "which boxes are waiting for my unlock approval?" poller.
    /// Populates `app.serversAwaitingApproval` so the list / detail / checklist
    /// can read a per-server waiting state from ONE fetch (no N pollers).
    @State private var approvalWatcher: BootApprovalWatcher?
    /// Persistent dismiss for the post-creation backup-reminder banner
    /// (mirror of webapp's flagship.recovery.banner.dismissed.v1). The
    /// store is observed so toggling `dismissed` from "Not now"
    /// re-renders Home and the banner disappears immediately.
    @State private var recoveryBannerStore = RecoveryBannerStore()
    /// The dead-registered pod awaiting a delete confirmation (set by the
    /// Home list's "Delete server (free name)" context action). Non-nil ⇒
    /// the destructive confirm dialog is shown.
    @State private var pendingDeleteDeadPod: PodInfo?

    public init() {}

    public var body: some View {
        NavigationStack(path: $path) {
            content
                .navigationDestination(for: HomeRoute.self) { route in
                    destination(for: route)
                }
        }
        .onChange(of: linker.pending) { _, link in consume(link) }
        .task(id: linker.pending) { consume(linker.pending) }
    }

    /// Pop or push onto the home stack when a DeepLink lands on this
    /// tab. RootShell already switches the tab to .home for these
    /// cases; we just resolve the route inside the stack.
    private func consume(_ link: DeepLink?) {
        guard let link else { return }
        switch link {
        case .serverDetail(let podId):
            // Only push if not already at this server's detail —
            // tapping the same push twice shouldn't stack pages.
            if path.last != .serverDetail(podId: podId) {
                path.append(.serverDetail(podId: podId))
            }
            _ = linker.consume()
        case .createServer:
            if !path.contains(.addServer) {
                path.append(.addServer)
            }
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
                HomeScreen(
                    state: vm.detail,
                    username: app.currentUser ?? "",
                    pods: app.pods,
                    leaderPodId: app.leaderPodId,
                    showRecoveryNudge: app.shouldShowRecoveryNudge,
                    showRecoveryBackupBanner: RecoveryBannerStore.shouldShow(
                        hasCloudRecovery: app.hasCloudRecovery,
                        dismissed: recoveryBannerStore.dismissed
                    ),
                    accountWasReset: app.accountWasReset,
                    deviceCapability: app.deviceCapability,
                    awaitingApproval: app.serversAwaitingApproval,
                    onOpenPod: { pod in path.append(.serverDetail(podId: pod.podId)) },
                    onCancelServer: { pod in
                        Task { await cancelPendingServer(pod: pod, server: server, app: app, toasts: toasts) }
                    },
                    onDeleteDeadServer: { pod in
                        // Confirm before decommissioning a registered-but-dead box.
                        // The IRK biometric fires when signing the release.
                        pendingDeleteDeadPod = pod
                    },
                    onAddServer: { path.append(.addServer) },
                    onSetLeader: { pod in app.setLeader(pod.podId) },
                    onVibeCode: {
                        // Building a service needs a server to build + run
                        // it. With none, nudge the user to add one. The
                        // full build flow lives on the Services tab.
                        if app.pods.isEmpty {
                            toasts.warning("Please add your first server.")
                        } else {
                            linker.pending = .startVibeCode
                        }
                    },
                    onBrowseMarketplace: { linker.pending = .marketplace },
                    onRefresh: {
                        // An explicit pull-to-refresh is a user-initiated
                        // moment — re-run the full server-truth reconcile
                        // (the biometric prompt is expected here) alongside
                        // the screen reload + a fresh approval poll (so a box
                        // that just started waiting surfaces its Approve card).
                        await reconcileServerTruth()
                        await approvalWatcher?.pollOnce()
                        await vm.load()
                    },
                    onSetUpRecovery: {
                        // Drop the user onto the Settings tab's Recovery
                        // route. We do that via DeepLinker so the tab
                        // switch + nav-stack push happens atomically.
                        linker.pending = .recoverySetup
                    },
                    onDismissRecoveryNudge: {
                        app.recoveryNudgeDismissedThisSession = true
                    },
                    onDismissRecoveryBackupBanner: {
                        recoveryBannerStore.dismissed = true
                    },
                    onSignInAgain: {
                        // E7 — drop everything and head back to Welcome.
                        // signOut() clears AppState; the recovery flow
                        // then pulls the user's cloud-stored UMK to
                        // re-pair on this device.
                        app.signOut()
                    }
                )
            } else {
                ProgressView()
            }
        }
        .task {
            if vm == nil {
                vm = HomeViewModel(client: client, podContext: app.currentPodId ?? app.leaderPodId)
            }
            // Surface any pending server we delivered in a prior session before
            // loading, so it's visible (and cancellable) immediately on launch.
            restorePendingServers()
            if case .idle = vm?.detail { await vm?.load() }
            // #43 — once per session, reconcile the pod list against server
            // truth (registered /pods + the IRK-signed outstanding-orders
            // endpoint): surface orders we have no local record of, drop dead
            // ghosts. Guarded so the biometric IRK derive doesn't fire on
            // every Home re-render; pull-to-refresh re-runs it on demand.
            if !didReconcileServerTruth {
                didReconcileServerTruth = true
                await reconcileServerTruth()
            }
            // Refresh cloud-recovery enrollment status when the tab
            // first appears. A failed lookup is silent — better to
            // suppress the nudge for one session than to surface a
            // network blip on the landing screen.
            await refreshRecoveryStatus()
            // Start the account-level approval poll so a box waiting for its
            // unlock surfaces an Approve affordance on the list/checklist
            // without waiting for a push or a per-card poller.
            if approvalWatcher == nil {
                let w = BootApprovalWatcher(app: app, pollAwaiting: pollAwaitingUnlock)
                approvalWatcher = w
                w.start()
            }
        }
        .onDisappear { approvalWatcher?.stop() }
        .onChange(of: app.currentPodId) { _, _ in
            Task { await vm?.load() }
        }
        .onChange(of: app.pods.contains(where: { $0.status == .online })) { _, hasOnline in
            // First time a pod transitions to online, re-check
            // recovery state — the nudge should appear right then,
            // not on the next launch.
            if hasOnline {
                Task { await refreshRecoveryStatus() }
            }
        }
        .alert(
            "Delete \(pendingDeleteDeadPod?.name ?? "server")?",
            isPresented: Binding(
                get: { pendingDeleteDeadPod != nil },
                set: { if !$0 { pendingDeleteDeadPod = nil } }
            ),
            presenting: pendingDeleteDeadPod
        ) { pod in
            Button("Delete", role: .destructive) {
                pendingDeleteDeadPod = nil
                Task { await cancelPendingServer(pod: pod, server: server, app: app, toasts: toasts) }
            }
            Button("Cancel", role: .cancel) { pendingDeleteDeadPod = nil }
        } message: { _ in
            Text("This frees the name for reuse and the box can no longer come online. This server never checked in.")
        }
    }

    /// Best-effort fetch of cloud-recovery presence + E7 account-reset
    /// detection. We fan out the two reads in parallel — the devices
    /// list doubles as our peer-detection signal: if our local push
    /// tokenId is absent, another device disconnected us.
    /// Any failure is silent so a transient blip doesn't flash a
    /// danger banner; the next successful round-trip will settle the
    /// state correctly.
    private func refreshRecoveryStatus() async {
        guard let user = app.currentUser, !user.isEmpty else { return }
        // hasCloudRecovery — drives B9 nudge.
        async let recoveryTask: Bool? = {
            do { return try await server.hasCloudRecovery(username: user) }
            catch { return nil }
        }()
        // listDevices — drives E7 account-reset detector.
        async let devicesTask: [TrustedDevice]? = {
            do { return try await server.listDevices(username: user).devices }
            catch { return nil }
        }()
        let (recovery, devices) = await (recoveryTask, devicesTask)
        if let recovery { app.hasCloudRecovery = recovery }
        if let devices {
            // We only flip accountWasReset when we have BOTH a
            // confirmed devices fetch AND a local tokenId — a fresh
            // install (no local token) shouldn't trigger E7.
            if let localToken = Keystore.pushTokenId(), !localToken.isEmpty {
                let present = devices.contains { $0.tokenId == localToken }
                if !present {
                    app.accountWasReset = true
                } else if app.accountWasReset {
                    // Recovered — the user must have re-registered.
                    // Clear the flag so the banner disappears.
                    app.accountWasReset = false
                }
            }
        }
    }

    @ViewBuilder
    private func destination(for route: HomeRoute) -> some View {
        switch route {
        case .serverDetail(let podId):
            // Pending pods get the placeholder detail page; online pods
            // get the full ServerDetail with monitoring + access. A demo
            // server still installing gets the install-progress detail
            // (bar + step list + device info + "Cancel this device").
            if let pod = app.pods.first(where: { $0.podId == podId }), pod.status == .pending {
                if pod.demoServer != nil {
                    DemoInstallProgressContainer(podId: podId) {
                        path.removeAll()
                    }
                } else {
                    PendingPodContainer(pod: pod) {
                        path.removeAll()
                    }
                }
            } else {
                ServerDetailContainer(podId: podId)
            }
        case .addServer:
            // In-app add-server only ever means "provision a new box."
            // Pairing an existing server is an onboarding-only path.
            CreateServerContainer(
                onDeliveredVisible: { serverDomain, serial, name, description in
                    // QR-relay delivered and the "boot disk is on the way"
                    // page is up. Surface the pod on Home RIGHT NOW (no
                    // navigation) — waiting for the "Done" tap left a
                    // just-created server invisible until a pull-down
                    // reconcile, which also stranded it serial-less.
                    addPendingPod(
                        name: name, description: description,
                        fqdn: serverDomain, serial: serial,
                        navigateHome: false
                    )
                },
                onDelivered: { serverDomain, serial, name, description in
                    // "Done" tapped — idempotent re-upsert, then head home.
                    addPendingPod(name: name, description: description, fqdn: serverDomain, serial: serial)
                },
                onCancel: {
                    // User backed out before delivering — drop any
                    // pending state and head home.
                    path.removeAll()
                }
            )
        case .installProgress(let serial, let name, let description):
            // Provisioning now renders the SINGLE canonical timeline
            // (PendingServerScreen → ProvisionTimelineViewModel → order-
            // status). Synthesize a pending pod keyed by the auth-code
            // serial; cancelling drops back home. (Same surface a tapped
            // pending pod card opens — there is no separate install screen.)
            PendingServerScreen(
                pod: PodInfo(
                    podId: "pending-\(serial)",
                    name: name,
                    description: description.isEmpty ? nil : description,
                    fqdn: "",
                    status: .pending,
                    pendingAuthCodeSerial: serial
                ),
                username: app.currentUser
            ) {
                path.removeAll()
            }
        }
    }


    private func addPendingPod(
        name: String,
        description: String,
        fqdn: String,
        serial: String,
        navigateHome: Bool = true
    ) {
        // Pod identity is unified on the fqdn so this freshly-delivered
        // pending pod and the registered `/pods` pod that arrives once the
        // box goes live collapse to ONE pod (the reconciler / watcher flip it
        // online in place) — no stuck-pending duplicate. The UPSERT also makes
        // this idempotent: it fires the moment the delivered page appears
        // (so the new server is on the Home list immediately, no pull-down
        // needed) and again on "Done", and it attaches the serial to a
        // serial-less twin the reconciler may have surfaced first.
        let podId = app.upsertPendingPod(
            name: name,
            description: description.isEmpty ? nil : description,
            fqdn: fqdn,
            serial: serial.isEmpty ? nil : serial
        )
        // Persist so the pending server survives an app restart — it isn't on
        // .com yet (the box hasn't registered), so without this it would vanish
        // from the list and the user couldn't see or cancel the in-flight install.
        if let user = app.currentUser, !user.isEmpty {
            PendingServerStore().add(username: user, .init(
                podId: podId,
                name: name,
                description: description,
                fqdn: fqdn,
                authCodeSerial: serial,
                createdAt: Date().timeIntervalSince1970
            ))
        }
        if navigateHome { path.removeAll() }
    }

    /// Account-level "which boxes are waiting to unlock?" poll for the watcher.
    /// Reads the cheap `awaitingUnlock` flag straight from the unauthenticated
    /// `/pods` directory — NO biometric. (The old path derived the IRK to read
    /// the mailbox, which fired Face ID every 5s on device.) Best-effort: a blip
    /// returns the prior set so the UI never thrashes.
    private func pollAwaitingUnlock() async -> Set<String> {
        guard let user = app.currentUser, !user.isEmpty,
              let dir = try? await mailbox.fetchPods(username: user)
        else { return app.serversAwaitingApproval }
        return Set(
            dir.pods
                .filter { $0.awaitingUnlock }
                .map { $0.serverDomain.lowercased() }
        )
    }

    /// #43 + #56 — reconcile the pod list against server truth from ONE
    /// unauthenticated `/pods` fetch (registered servers + active orders).
    /// Surfaces orders we have no local record of (fixes home2-invisible) and
    /// drops dead ghosts (fixes the home1 spinner). NO biometric prompt — a
    /// list refresh is a pure read; Face ID stays only on mutations
    /// (create-server / release / revoke). Best-effort; a failure leaves local
    /// state untouched.
    private func reconcileServerTruth() async {
        guard let user = app.currentUser, !user.isEmpty else { return }
        let mailbox = self.mailbox
        let reconciler = PendingServerReconciler(
            app: app,
            fetchPods: { username in
                // The merged `/pods` directory is the AUTHORITATIVE list:
                // registered boxes (online) + in-flight orders (pending).
                // Identity-plane fetch, no biometric; a failure returns nil so
                // the reconcile leaves state untouched on a blip.
                do {
                    return try await mailbox.fetchPods(username: username)
                } catch {
                    return nil
                }
            }
        )
        await reconciler.reconcile()
    }

    /// Re-add persisted pending servers on launch, and drop any that have since
    /// registered (they now arrive as real servers from .com). Idempotent —
    /// safe to call on every Home appearance.
    private func restorePendingServers() {
        guard let user = app.currentUser, !user.isEmpty else { return }
        let store = PendingServerStore()
        let liveFqdns = Set(app.pods.filter { $0.status != .pending }.map { $0.fqdn })
        store.reconcile(username: user, liveFqdns: liveFqdns)
        let existing = Set(app.pods.map { $0.fqdn.lowercased() })
        for rec in store.list(username: user) where !existing.contains(rec.fqdn.lowercased()) {
            app.addPod(PodInfo(
                podId: rec.podId,
                name: rec.name,
                description: rec.description.isEmpty ? nil : rec.description,
                fqdn: rec.fqdn,
                status: .pending,
                // A record surfaced from the unauthenticated directory on a
                // non-creating device has no serial (the /pods response only
                // carries opaque orderRefs) — restore it serial-less so the
                // watcher / cancel paths don't run with an empty capability.
                pendingAuthCodeSerial: rec.authCodeSerial.isEmpty ? nil : rec.authCodeSerial
            ))
        }
    }
}

struct CreateServerContainer: View {
    let onDeliveredVisible: (_ serverDomain: String, _ serial: String, _ name: String, _ description: String) -> Void
    let onDelivered: (_ serverDomain: String, _ serial: String, _ name: String, _ description: String) -> Void
    let onCancel: () -> Void
    @Environment(\.flagshipServerClient) private var serverClient
    @Environment(\.qrRelayClient) private var qrRelay
    @Environment(AppState.self) private var app
    @State private var vm: CreateServerViewModel?

    init(
        onDeliveredVisible: @escaping (_ serverDomain: String, _ serial: String, _ name: String, _ description: String) -> Void = { _, _, _, _ in },
        onDelivered: @escaping (_ serverDomain: String, _ serial: String, _ name: String, _ description: String) -> Void,
        onCancel: @escaping () -> Void = {}
    ) {
        self.onDeliveredVisible = onDeliveredVisible
        self.onDelivered = onDelivered
        self.onCancel = onCancel
    }

    var body: some View {
        ZStack {
            FSColors.scheme(.light).bg.ignoresSafeArea()
            if let vm {
                CreateServerStubScreen(
                    vm: vm,
                    onDeliveredVisible: { serverDomain, name, description in
                        let serial = vm.lastDeliveredSerial ?? ""
                        onDeliveredVisible(serverDomain, serial, name, description)
                    },
                    onDelivered: { serverDomain, name, description in
                        // The serial is recorded inside the VM after
                        // minting; pass it back so the new pod row
                        // knows which auth-code to cancel.
                        let serial = vm.lastDeliveredSerial ?? ""
                        onDelivered(serverDomain, serial, name, description)
                    },
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

/// Wraps PendingServerScreen so the Cancel-order tap reaches
/// flagshipserver.com (auth-code revoke) before dropping the pod
/// from AppState. The container surfaces success/failure as toasts.
struct PendingPodContainer: View {
    let pod: PodInfo
    let onAfterCancel: () -> Void
    @Environment(\.flagshipServerClient) private var serverClient
    @Environment(AppState.self) private var app
    @Environment(ToastCenter.self) private var toasts
    @State private var cancelling: Bool = false

    var body: some View {
        PendingServerScreen(pod: pod, username: app.currentUser) {
            Task { await cancelOrder() }
        }
    }

    /// Cancel the server. Mirrors webapp `cancelServer`: FIRST release
    /// the name (an IRK-signed `ReleaseServerName` → /api/server/release,
    /// which un-pins the routing record so the name can be re-used),
    /// THEN revoke the install auth-code (belt-and-braces, the release
    /// already revokes active codes server-side). If the release fails
    /// we surface the error and KEEP the pod — dropping it locally would
    /// strand the name as still-reserved.
    private func cancelOrder() async {
        guard !cancelling else { return }
        cancelling = true
        defer { cancelling = false }
        await cancelPendingServer(pod: pod, server: serverClient, app: app, toasts: toasts)
        // The shared helper removes the pod on success; if it's gone, dismiss.
        if !app.pods.contains(where: { $0.podId == pod.podId }) {
            onAfterCancel()
        }
    }
}

/// Cancel a pending server: release the reserved name (un-pin the routing
/// record so the name frees up), revoke the install auth-code, drop the local
/// pending record, and remove the pod. Shared by the pending-detail screen
/// (PendingPodContainer) and the Home list's "Cancel server" context action.
/// Mirrors webapp `cancelServer`. On a release failure the pod is KEPT (the
/// name is still reserved) with a warning toast.
@MainActor
func cancelPendingServer(
    pod: PodInfo,
    server: any FlagshipServerClient,
    app: AppState,
    toasts: ToastCenter
) async {
    guard let username = app.currentUser else {
        app.removePod(pod.podId)
        return
    }
    do {
        let irk = try await Keystore.deriveIRK(reason: "Cancel server \(pod.name)")
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        // 1. Release the name (the real free-the-name mechanism).
        let releaseBytes = ReleaseServerName.canonicalBytes(
            username: username, serverDomain: pod.fqdn, issuedAt: now
        )
        let releaseSig = try irk.signature(for: releaseBytes)
        try await server.releaseServerName(.init(
            request: .init(username: username, serverDomain: pod.fqdn, issuedAt: now),
            signature: HexUtil.encode(releaseSig)
        ))
        // 2. Belt-and-braces auth-code revoke (the release already revoked
        // active codes server-side; 403/404 is treated as success).
        if let serial = pod.pendingAuthCodeSerial {
            let revokeBytes = AuthCodeRevoke.canonicalBytes(serial: serial, username: username, issuedAt: now)
            let revokeSig = try irk.signature(for: revokeBytes)
            try? await server.revokeAuthCode(.init(
                request: .init(serial: serial, username: username, issuedAt: now),
                signature: HexUtil.encode(revokeSig)
            ))
        }
        toasts.success("Server \"\(pod.name)\" cancelled — the name is free again.")
        app.removePod(pod.podId)
        PendingServerStore().remove(username: username, podId: pod.podId)
    } catch {
        // Keep the pod: the name is still reserved, so dropping it locally
        // would just hide a name the user can't re-use.
        toasts.warning("Couldn't cancel — the name is still reserved. Check your connection and try again.")
    }
}

/// Install-progress detail for a demo server. Reads the live pod from
/// AppState (so it re-renders as the connect coordinator advances the
/// `demoServer.phase` each poll), and wires "Cancel this device" → the
/// public, demo-scoped cancel endpoint → return to the empty/list state.
struct DemoInstallProgressContainer: View {
    let podId: String
    let onAfterCancel: () -> Void
    @Environment(\.flagshipServerClient) private var server
    @Environment(AppState.self) private var app
    @Environment(ToastCenter.self) private var toasts
    @State private var coordinator: DemoConnectCoordinator?
    @State private var started = false
    @State private var cancelling = false

    private var pod: PodInfo? { app.pods.first(where: { $0.podId == podId }) }

    var body: some View {
        Group {
            if let pod {
                DemoInstallProgressScreen(pod: pod) {
                    Task { await runCancel() }
                }
            } else {
                // Pod vanished (cancelled) — bounce home.
                Color.clear.onAppear { onAfterCancel() }
            }
        }
        .task {
            if coordinator == nil {
                coordinator = DemoConnectCoordinator(
                    server: server,
                    demoConnect: LiveDemoConnectClient(server: server)
                )
            }
            // Drive connect+poll once so the bar advances live. If the
            // server is already up this is a fast no-op.
            if !started, let user = app.currentUser, let c = coordinator {
                started = true
                await c.connect(username: user, appState: app)
            }
        }
    }

    private func runCancel() async {
        guard !cancelling, let user = app.currentUser, let c = coordinator else { return }
        cancelling = true
        defer { cancelling = false }
        let ok = await c.cancel(username: user, appState: app)
        if ok {
            toasts.success("Device cancelled.")
            onAfterCancel()
        } else {
            toasts.warning("Couldn't cancel — try again in a moment.")
        }
    }
}

/// Drill-down server detail. Owns its own detail VM AND its metrics VM
/// (the latter polls every 15s while the screen is on stage).
struct ServerDetailContainer: View {
    let podId: String
    @Environment(\.screensClient) private var client
    @Environment(\.colorScheme) private var scheme
    @Environment(AppState.self) private var app
    @State private var detailVm: HomeViewModel?
    @State private var metricsVm: ServerMetricsViewModel?

    private var pod: PodInfo? { app.pods.first(where: { $0.podId == podId }) }

    var body: some View {
        let c = FSColors.scheme(scheme)
        ZStack {
            c.bg.ignoresSafeArea()
            if let detailVm, let metricsVm {
                ServerDetailScreen(
                    state: detailVm.detail,
                    metrics: metricsVm.state,
                    // The decommission/free-the-name card surfaces ONLY for a
                    // GENUINELY dead box (registered, no live unlock request, no
                    // check-in, past the grace window) — never for one that's
                    // waiting for approval or still coming online. Defaults to a
                    // live server when the pod is momentarily absent from AppState.
                    deadServer: pod.map { app.liveness(for: $0) == .dead } ?? false,
                    serverName: pod?.name,
                    deadServerFqdn: pod?.fqdn,
                    awaitingUnlock: pod?.awaitingUnlock ?? false,
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
            metricsVm?.startPolling(every: 15)
            // Retry the BFF detail load until it lands. A box that JUST came
            // online can take a few seconds before its daemon answers the
            // detail BFF; a single load() would otherwise leave the page stuck
            // on "Connecting to your server…" until the user manually pulled to
            // refresh (the bug). Backoff 2s→15s. The loop exits when the view
            // goes away (`.task` cancels) — so it doubles as the keep-alive
            // park that stops metrics polling on disappear.
            var delay: UInt64 = 2_000_000_000
            while !Task.isCancelled {
                await detailVm?.load()
                if let d = detailVm?.detail, case .loaded = d { break }
                try? await Task.sleep(nanoseconds: delay)
                delay = min(delay * 2, 15_000_000_000)
            }
            // Detail loaded — park so metrics polling continues until the view
            // is removed. The stream never yields; binding it to a local keeps
            // the build closure unambiguous (not confusable with the loop body).
            let parkUntilCancelled = AsyncStream<Never> { _ in }
            for await _ in parkUntilCancelled { }
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
    @Environment(\.flagshipServerClient) private var server
    @Environment(AppState.self) private var app
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
            if vm == nil {
                vm = SettingsViewModel(
                    client: client,
                    server: server,
                    username: { [app] in app.currentUser }
                )
            }
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
