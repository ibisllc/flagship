import SwiftUI
import UIKit
import CryptoKit
import Flagship
import FlagshipCore
import FlagshipAPI

/// Home tab. Account-wide overview + drill-down into individual servers.
public struct HomeTab: View {
    @Environment(\.screensClient) private var client
    @Environment(\.flagshipServerClient) private var server
    @Environment(\.secretMailboxClient) private var mailbox
    @Environment(\.leadsClient) private var leads
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
    /// Populates `app.boxRequestInbox` so the list / detail / checklist
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
            // A `createServer` deep-link and the Home "add server" button both go
            // straight to the create flow — there's no chooser.
            if !path.contains(.provisionServer) {
                path.append(.provisionServer)
            }
            _ = linker.consume()
        case .transferOffer(let offerJSON):
            // Slice C — a scanned / deep-linked (IRK-signed) transfer offer.
            // Push the take-over route with the offer pre-ingested; the screen
            // verifies the signature + expiry and gates the claim on a severe
            // type-to-confirm + biometric.
            let route = HomeRoute.transferAcquirer(offerText: offerJSON)
            if path.last != route {
                path.append(route)
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
                    accountDisplayName: app.activeProfile?.accountDisplayName,
                    deviceDisplayName: app.activeProfile?.deviceDisplayName,
                    pods: app.pods,
                    leaderPodId: app.leaderPodId,
                    showRecoveryNudge: app.shouldShowRecoveryNudge,
                    showRecoveryBackupBanner: RecoveryBannerStore.shouldShow(
                        hasCloudRecovery: app.hasCloudRecovery,
                        dismissed: recoveryBannerStore.dismissed
                    ),
                    accountWasReset: app.accountWasReset,
                    deviceCapability: app.deviceCapability,
                    awaitingApproval: app.serversAwaiting(.unlockKey),
                    awaitingEntitlement: app.serversAwaiting(.entitlement),
                    onOpenPod: { pod in path.append(.serverDetail(podId: pod.podId)) },
                    onCancelServer: { pod in
                        Task { await cancelPendingServer(pod: pod, server: server, app: app, toasts: toasts) }
                    },
                    onDeleteDeadServer: { pod in
                        // Confirm before decommissioning a registered-but-dead box.
                        // The IRK biometric fires when signing the release.
                        pendingDeleteDeadPod = pod
                    },
                    onAddServer: { path.append(.provisionServer) },
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
                    onRefresh: {
                        // An explicit pull-to-refresh is a user-initiated
                        // moment — re-run the full server-truth reconcile
                        // (the biometric prompt is expected here) alongside
                        // the screen reload + a fresh approval poll (so a box
                        // that just started waiting surfaces its Approve card).
                        await reconcileServerTruth()
                        // Prefer a fresher box-direct leadership read over the
                        // relay value the reconcile just applied (best-effort).
                        await preferDirectLeads()
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
                // Prefer a live box-direct leadership read over the relay value
                // the reconcile applied — best-effort, on-demand (no new poller).
                await preferDirectLeads()
            }
            // Refresh cloud-recovery enrollment status when the tab
            // first appears. A failed lookup is silent — better to
            // suppress the nudge for one session than to surface a
            // network blip on the landing screen.
            await refreshRecoveryStatus()
            // The account-level "which boxes are waiting for approval?" feed now
            // rides the app-scope LiveSync canal (the `/stream` long-poll feeds
            // `app.boxRequestInbox` directly), so HomeTab no longer starts the
            // BootApprovalWatcher's own 5s `/pods` timer — that would be a
            // redundant second poll of the same data. The watcher is still built
            // so pull-to-refresh (`onRefresh` below) can force ONE immediate
            // directory read via `pollOnce()`; it just doesn't run on a timer.
            if approvalWatcher == nil {
                approvalWatcher = BootApprovalWatcher(app: app, pollAwaiting: pollPendingApprovals)
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

    /// Best-effort fetch of cloud-recovery presence. Device membership is
    /// checked only through the signed account directory after unlock; the
    /// former username-only push-token roster was intentionally removed.
    /// Any failure is silent so a transient blip doesn't flash a
    /// danger banner; the next successful round-trip will settle the
    /// state correctly.
    private func refreshRecoveryStatus() async {
        guard let user = app.currentUser, !user.isEmpty else { return }
        let recovery: Bool? = try? await server.hasCloudRecovery(username: user)
        if let recovery { app.hasCloudRecovery = recovery }
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
                ServerDetailContainer(podId: podId, onDeleted: { path.removeAll() })
            }
        case .provisionServer:
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
        case .transferAcquirer(let offerText):
            TransferAcquirerContainer(offerText: offerText)
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

    /// Account-level "what is each box asking me to approve?" poll for the
    /// watcher — builds the unified Box Request Inbox (docs/box-request-inbox.md)
    /// from the cheap `pendingRequests` digest straight off the unauthenticated
    /// `/pods` directory — NO biometric. (The old path derived the IRK to read
    /// the mailbox, which fired Face ID every 5s on device.) Best-effort: a blip
    /// returns the prior inbox so the UI never thrashes. Unknown/future purposes
    /// a not-yet-updated client can't satisfy are dropped here (they need no
    /// affordance), so the inbox only ever holds requests this app can act on.
    private func pollPendingApprovals() async -> [String: [BoxRequest]] {
        guard let user = app.currentUser, !user.isEmpty,
              let dir = try? await mailbox.fetchPods(username: user)
        else {
            return app.boxRequestInbox
        }
        var inbox: [String: [BoxRequest]] = [:]
        for pod in dir.pods {
            let key = pod.serverDomain.lowercased()
            let reqs: [BoxRequest] = pod.pendingRequests.compactMap { r in
                guard let purpose = SecretPurpose(rawValue: r.type) else { return nil }
                return BoxRequest(
                    nonceHex: r.id,
                    serverDomain: pod.serverDomain,
                    type: purpose,
                    issuedAt: r.issuedAt,
                    expiresAt: r.expiresAt
                )
            }
            if !reqs.isEmpty { inbox[key] = reqs }
        }
        return inbox
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
        // Secret-free recipe: deposit the SWK once a box registered without it
        // embedded. The coordinator no-ops unless a deposit is owed (idempotent
        // via PendingSwkDepositStore), so this is safe on every reconcile.
        let swkDeposit = SwkDepositCoordinator(username: user, mailbox: mailbox)
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
            },
            onRegistered: { fqdn, identityPubKeyHex in
                await swkDeposit.depositIfNeeded(serverDomain: fqdn, identityPubKeyHex: identityPubKeyHex)
            }
        )
        await reconciler.reconcile()
    }

    /// PREFER a live, box-direct leadership read over the `.com` `/pods`
    /// `leadsServices` relay (which is ~5 min stale + `.com`-dependent). For
    /// each ONLINE box, fetch `GET /api/leads` over the box-pinned pipe; the
    /// FIRST box that answers gives a GLOBAL (slug → leaderFqdn) view of the
    /// whole account's leadership, so one successful read covers every pod.
    /// Invert it into the per-pod ("fqdn → slugs") model the badge renders and
    /// apply it, overriding the relay value for matched pods. Best-effort +
    /// on-demand (called from the appearance reconcile + pull-to-refresh, NOT a
    /// new always-on poller): any failure / 404 / gossip-off yields nil and the
    /// relay value stands — never a regression. Runs AFTER the relay reconcile
    /// so the direct view wins.
    private func preferDirectLeads() async {
        // Online boxes are the only ones reachable on their pinned pipe. Their
        // fqdns are also the match set for the inversion (we only badge a pod we
        // actually show).
        let onlineFqdns = app.pods.filter { $0.status == .online }.map { $0.fqdn }
        guard !onlineFqdns.isEmpty else { return }
        let knownFqdns = app.pods.map { $0.fqdn }
        for fqdn in onlineFqdns {
            guard let map = await leads.fetchLeads(podFqdn: fqdn) else { continue }
            // A successful read is a complete account-wide view — invert + apply
            // and we're done (no need to poll the other boxes this pass).
            let byFqdn = DirectLeadsInversion.invert(leads: map.leads, knownFqdns: knownFqdns)
            app.applyDirectLeads(byFqdn)
            return
        }
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

/// Slice C — mounts `TransferAcquirerScreen` with a transfer offer PRE-INGESTED
/// (from a scanned/deep-linked `flagship://transfer?o=` or universal link). The
/// VM verifies the giver-IRK signature + expiry on ingest; an invalid/expired
/// offer lands on the screen's `.failed` state (no confirm ever shown). The
/// claim itself rides a severe type-to-confirm + biometric inside the screen.
struct TransferAcquirerContainer: View {
    let offerText: String
    @Environment(\.serverTransferClient) private var transfer
    @Environment(AppState.self) private var app
    @State private var vm: TransferAcquirerViewModel?

    var body: some View {
        ZStack {
            FSColors.scheme(.light).bg.ignoresSafeArea()
            if let vm {
                TransferAcquirerScreen(vm: vm)
            } else {
                ProgressView()
            }
        }
        .task {
            if vm == nil {
                let model = TransferAcquirerViewModel(
                    client: transfer,
                    username: app.currentUser ?? ""
                )
                model.ingest(offerText)
                vm = model
            }
        }
    }
}

struct CreateServerContainer: View {
    let onDeliveredVisible: (_ serverDomain: String, _ serial: String, _ name: String, _ description: String) -> Void
    let onDelivered: (_ serverDomain: String, _ serial: String, _ name: String, _ description: String) -> Void
    let onCancel: () -> Void
    @Environment(\.flagshipServerClient) private var serverClient
    @Environment(\.qrRelayClient) private var qrRelay
    @Environment(\.secretMailboxClient) private var mailbox
    @Environment(\.sessionStore) private var sessionStore
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
                    relay: qrRelay,
                    mailbox: mailbox,
                    sessionStore: sessionStore
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
        PendingServerScreen(pod: pod, username: app.currentUser, awaitingUnlock: app.isAwaitingUnlock(pod)) {
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
@discardableResult
@MainActor
func cancelPendingServer(
    pod: PodInfo,
    server: any FlagshipServerClient,
    app: AppState,
    toasts: ToastCenter
) async -> Bool {
    guard let username = app.currentUser else {
        app.removePod(pod.podId)
        return true
    }
    do {
        // Slice D — release-server-name is a SENSITIVE order: sign with the admin
        // master root when this device holds one, else the legacy owner IRK.
        let orderKey = try await Keystore.sensitiveOrderSigningKey(reason: "Cancel server \(pod.name)")
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        // 1. Release the name (the real free-the-name mechanism).
        let releaseBytes = ReleaseServerName.canonicalBytes(
            username: username, serverDomain: pod.fqdn, issuedAt: now
        )
        let releaseSig = try orderKey.signature(for: releaseBytes)
        try await server.releaseServerName(.init(
            request: .init(username: username, serverDomain: pod.fqdn, issuedAt: now),
            signature: HexUtil.encode(releaseSig)
        ))
        // 2. Belt-and-braces auth-code revoke (the release already revoked
        // active codes server-side; 403/404 is treated as success). This is a
        // NON-sensitive owner-IRK op, so it must be IRK-signed: reuse orderKey
        // when it IS the IRK (no admin root), else derive the IRK.
        if let serial = pod.pendingAuthCodeSerial {
            let revokeKey = Keystore.hasAdminRoot
                ? ((try? await Keystore.deriveIRK(reason: "Cancel server \(pod.name)")) ?? orderKey)
                : orderKey
            let revokeBytes = AuthCodeRevoke.canonicalBytes(serial: serial, username: username, issuedAt: now)
            let revokeSig = try revokeKey.signature(for: revokeBytes)
            try? await server.revokeAuthCode(.init(
                request: .init(serial: serial, username: username, issuedAt: now),
                signature: HexUtil.encode(revokeSig)
            ))
        }
        toasts.success("Server \"\(pod.name)\" cancelled — the name is free again.")
        app.removePod(pod.podId)
        PendingServerStore().remove(username: username, podId: pod.podId)
        return true
    } catch {
        // Keep the pod: the name is still reserved, so dropping it locally
        // would just hide a name the user can't re-use.
        toasts.warning("Couldn't cancel — the name is still reserved. Check your connection and try again.")
        return false
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
    /// Pop the nav stack back to Home — fired after the decommission/free-the-name
    /// action succeeds (the pod is gone, so this page now points at nothing).
    var onDeleted: () -> Void = {}
    @Environment(\.screensClient) private var client
    @Environment(\.secretMailboxClient) private var mailbox
    @Environment(\.lockPowerClient) private var lockPower
    @Environment(\.flagshipServerClient) private var server
    @Environment(\.sessionStore) private var sessionStore
    @Environment(\.colorScheme) private var scheme
    @Environment(AppState.self) private var app
    @Environment(ToastCenter.self) private var toasts
    @State private var detailVm: HomeViewModel?
    @State private var metricsVm: ServerMetricsViewModel?
    @State private var pairVm: PodPairViewModel?
    @State private var demoPairing = false

    private var pod: PodInfo? { app.pods.first(where: { $0.podId == podId }) }

    /// FQDN to pair against — the current pod's. The session store's base URL
    /// is already pointed here by `PodSessionSync`; the pairing order's
    /// `serverId` must equal the box's FQDN (the daemon enforces it).
    private var pairFqdn: String? {
        guard let fqdn = pod?.fqdn, !fqdn.isEmpty else { return nil }
        return fqdn
    }

    private var isPairing: Bool {
        if demoPairing { return true }
        if case .signing = pairVm?.phase { return true }
        if case .posting = pairVm?.phase { return true }
        return false
    }

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
                    // Use the LIVE awaiting-unlock signal (per-pod flag OR the
                    // 5s watcher set), not the per-pod flag alone — otherwise a
                    // box that starts waiting AFTER the last /pods reconcile shows
                    // "waiting for approval" on Home but no Approve card here.
                    awaitingUnlock: pod.map { app.isAwaitingUnlock($0) } ?? false,
                    awaitingEntitlement: pod.map { app.isAwaitingEntitlement($0) } ?? false,
                    // No local token OR a 401-rejected stale token → this
                    // device isn't paired with the box.
                    // Surface the one-tap pairing affordance (but only for a box
                    // that's actually reachable — a dead box never paired and
                    // never will, so it stays on the decommission path).
                    notPaired: detailVm.needsPairing && pairFqdn != nil,
                    // HONEST LIVENESS (Fix B) — surface the box's real reachability
                    // rather than a catch-all "Connecting…". `.offline` =
                    // server-authoritative unreachable (was live, now stale);
                    // `.comingOnline` for a non-pending box = `never` (awaiting
                    // first heartbeat). Pending pods are handled by their own route.
                    offline: pod.map { app.liveness(for: $0) == .offline } ?? false,
                    lastSeen: pod?.humanizedLastSeen(),
                    comingUp: pod.map { app.liveness(for: $0) == .comingOnline && $0.status != .pending } ?? false,
                    pairing: isPairing,
                    verifiedCertStatus: pod.flatMap {
                        CertPinRegistry.shared.verifiedReport(for: $0.fqdn)
                    },
                    onRefresh: {
                        await refreshDirectoryAndRepairAppKey(allowAuthentication: true)
                        async let a: Void = detailVm.load()
                        async let b: Void = metricsVm.load()
                        _ = await (a, b)
                    },
                    onPair: { Task { await pairThenReload(detailVm: detailVm) } },
                    onDeleted: onDeleted
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
            // Point the box session at THIS pod so per-pod detail targets the
            // tapped pod — not the global leader/sessionPod. Without this,
            // opening pod B while pod A is the session anchor loads A's data.
            // Sync for any registered (non-pending) pod with an fqdn — including
            // an offline/coming-up one — so its honest state renders from a real
            // load attempt against ITS base URL + ITS per-pod token (Fix B),
            // never the global anchor's.
            if let p = pod, p.status != .pending, !p.fqdn.isEmpty {
                await PodSessionSync.sync(currentPod: p, store: sessionStore)
            }
            if detailVm == nil {
                detailVm = HomeViewModel(client: client, podContext: podId)
            }
            if metricsVm == nil {
                metricsVm = ServerMetricsViewModel(podId: podId, client: client)
            }
            await refreshDirectoryAndRepairAppKey(allowAuthentication: false)
            metricsVm?.startPolling(every: 15)
            // Retry the BFF detail load until it lands. A box that JUST came
            // online can take a few seconds before its daemon answers the
            // detail BFF; a single load() would otherwise leave the page stuck
            // on "Connecting to your server…" until the user manually pulled to
            // refresh (the bug). Backoff 2s→15s. The loop exits when the view
            // goes away (`.task` cancels) — so it doubles as the keep-alive
            // park that stops metrics polling on disappear. It ALSO stops once
            // the BFF reports "not paired": retrying that never helps (it needs
            // the owner to tap Pair), so we park and let the pairing card drive.
            // A server-authoritatively offline / coming-up box (HONEST LIVENESS,
            // Fix B) won't answer its BFF — don't hammer it. One attempt, then
            // park and let the honest placeholder + pull-to-refresh drive.
            let livenessState = pod.map { app.liveness(for: $0) }
            let wontAnswer = livenessState == .offline
                || (livenessState == .comingOnline && pod?.status != .pending)
            var delay: UInt64 = 2_000_000_000
            while !Task.isCancelled {
                await detailVm?.load()
                if let d = detailVm?.detail, case .loaded = d { break }
                if detailVm?.needsPairing == true { break }
                if wontAnswer { break }
                try? await Task.sleep(nanoseconds: delay)
                delay = min(delay * 2, 15_000_000_000)
            }
            // Detail loaded — park so metrics polling continues until the view
            // is removed. The stream never yields; binding it to a local keeps
            // the build closure unambiguous (not confusable with the loop body).
            let parkUntilCancelled = AsyncStream<Never> { _ in }
            for await _ in parkUntilCancelled { }
        }
        .onDisappear {
            metricsVm?.stopPolling()
            // Revert the box session to the global live anchor when leaving the
            // per-pod detail, so Home/Services talk to a live pod again.
            let store = sessionStore
            let anchor = app.sessionPod
            Task { await PodSessionSync.sync(currentPod: anchor, store: store) }
        }
    }

    @MainActor
    private func refreshDirectoryAndRepairAppKey(allowAuthentication: Bool) async {
        guard let username = app.currentUser, !username.isEmpty else { return }
        guard let directory = try? await mailbox.fetchPods(username: username) else { return }
        // A reinstall/profile restore can preserve the account UMK while losing
        // this app-local cache of each box's derived STK public key. A seedless
        // /pods refresh can then fetch a perfectly valid signed daemon report
        // but has no local authority with which to verify it, leaving the TLS
        // card stuck on "No certificate yet" forever. Rebuild the public-key
        // cache whenever the owner explicitly refreshes, or silently when the
        // current unlocked session already holds the UMK. Background refreshes
        // with a cold session remain biometric-free.
        if allowAuthentication || Keystore.hasSessionKey(),
           let umk = try? await Keystore.currentUMK(reason: "Verify your servers") {
            let seed = umk.withUnsafeBytes { Data($0) }
            CertPinRegistry.shared.update(pods: directory.pods, umkSeed: seed)
        } else {
            CertPinRegistry.shared.update(pods: directory.pods)
        }

        guard let fqdn = pod?.fqdn, !fqdn.isEmpty else { return }
        let store = PendingSwkDepositStore()
        guard store.isPending(for: fqdn),
              let identityPubKeyHex = directory.identityPubKey(forServerDomain: fqdn)
        else { return }

        let coordinator = SwkDepositCoordinator(
            username: username,
            mailbox: mailbox,
            store: store
        )
        await coordinator.depositIfNeeded(
            serverDomain: fqdn,
            identityPubKeyHex: identityPubKeyHex,
            allowAuthentication: allowAuthentication
        )
    }

    /// One pairing attempt (Face ID → sign `add-paired-session` → POST →
    /// persist token), then reload the BFF so the page fills in. Fired once per
    /// tap from the "Pair this server" button — never auto-fired. Idempotent in
    /// the VM (a present token no-ops without a biometric).
    @MainActor
    private func pairThenReload(detailVm: HomeViewModel) async {
        guard let fqdn = pairFqdn else { return }
        guard !isPairing else { return }
        if let demo = pod?.demoServer, let username = app.currentUser {
            demoPairing = true
            defer { demoPairing = false }
            do {
                try await DemoSessionPairer.ensurePaired(
                    username: username,
                    server: demo,
                    client: server,
                    store: sessionStore,
                    replacingExistingToken: true
                )
                await detailVm.load()
            } catch {
                toasts.error("The demo server is online, but this device couldn't create a paired session. Try again.")
            }
            return
        }
        let vm = PodPairViewModel(
            client: lockPower,
            store: sessionStore,
            serverDomain: fqdn
        )
        pairVm = vm
        // This affordance is shown only after the detail BFF proved the current
        // token absent or rejected. Replace a stale per-pod token instead of
        // letting PodPairViewModel's normal idempotency guard no-op on it.
        await vm.pair(replacingExistingToken: true)
        switch vm.phase {
        case .paired, .alreadyPaired:
            await detailVm.load()
        case .failed(let msg):
            toasts.error(msg)
        default:
            break
        }
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
                    Text("Session \(session.tokenPrefix)").foregroundColor(c.text)
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
