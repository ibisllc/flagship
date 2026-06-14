import SwiftUI
import CryptoKit
import FlagshipAPI
import FlagshipCore
import Flagship

/// Drill-down view of a single server: TLS cert, uptime, version, SANs,
/// live monitoring (CPU / memory / disk / I/O), paired sessions count,
/// recent install timeline.
public struct ServerDetailScreen: View {
    @Environment(\.colorScheme) private var scheme
    let state: LoadingState<ServerDetailResponse>
    let metrics: LoadingState<ServerMetricsResponse>
    /// True for a registered box whose daemon never checked in (the install
    /// reserved + registered, but it never came online). Surfaces the
    /// decommission/free-the-name card and a "Never came online" framing in
    /// place of the transient "Connecting…" state, since this box will never
    /// connect. Distinct from the lost/stolen Revoke danger zone.
    let deadServer: Bool
    /// Display name for the decommission card / its toast. Falls back to the FQDN.
    let serverName: String?
    /// FQDN to sign the release for, sourced from the pod (the failed-load path
    /// has no `ServerDetailResponse.serverFqdn`). The loaded path prefers the
    /// response's own FQDN.
    let deadServerFqdn: String?
    /// The directory's cheap `awaitingUnlock` flag for this box. When true the
    /// box is definitely waiting for a boot-unlock approval, so the approval
    /// card must be offered REGARDLESS of whether the daemon BFF detail loaded.
    let awaitingUnlock: Bool
    var onOpenSessions: () -> Void = {}
    var onOpenTier: () -> Void = {}
    var onRefresh: () async -> Void = {}

    public init(
        state: LoadingState<ServerDetailResponse>,
        metrics: LoadingState<ServerMetricsResponse>,
        deadServer: Bool = false,
        serverName: String? = nil,
        deadServerFqdn: String? = nil,
        awaitingUnlock: Bool = false,
        onOpenSessions: @escaping () -> Void = {},
        onOpenTier: @escaping () -> Void = {},
        onRefresh: @escaping () async -> Void = {}
    ) {
        self.state = state
        self.metrics = metrics
        self.deadServer = deadServer
        self.serverName = serverName
        self.deadServerFqdn = deadServerFqdn
        self.awaitingUnlock = awaitingUnlock
        self.onOpenSessions = onOpenSessions
        self.onOpenTier = onOpenTier
        self.onRefresh = onRefresh
    }

    /// FQDN for the boot-unlock approval card: the loaded detail's own FQDN,
    /// else the pod FQDN the container always passes (available even when the
    /// daemon BFF load fails — a locked box never answers its BFF).
    private var approvalFqdn: String? {
        if case .loaded(let d) = state, !d.serverFqdn.isEmpty { return d.serverFqdn }
        return deadServerFqdn
    }

    private var isLoaded: Bool {
        if case .loaded = state { return true }
        return false
    }

    public var body: some View {
        let c = FSColors.scheme(scheme)
        ScrollView {
            VStack(alignment: .leading, spacing: FS.space.s6) {
                // Boot-unlock approval — hoisted to the TOP and OUTSIDE the state
                // switch so a box waiting for the owner to release its disk key is
                // always actionable here, even when the daemon BFF can't load (a
                // locked box is unreachable — that's the whole point). The card
                // polls the boot relay (not the box) and renders nothing until a
                // request is actually waiting.
                if let fqdn = approvalFqdn, !fqdn.isEmpty {
                    // The directory's cheap `awaitingUnlock` flag (no biometric)
                    // is the authoritative "this box is waiting" signal — a
                    // locked-and-waiting box always sets it when it posts the
                    // request. The card surfaces Approve/Deny directly when it's
                    // set, and renders nothing otherwise.
                    BootUnlockApprovalCard(
                        serverDomain: fqdn,
                        awaitingUnlock: awaitingUnlock
                    )
                }
                switch state {
                case .idle, .loading:
                    ServerCardSkeleton()
                case .failed:
                    if deadServer {
                        // This box registered during install but never came
                        // online; its daemon BFF will never answer. Show the
                        // dead-server explanation + the decommission card
                        // instead of the transient "Connecting…" placeholder.
                        neverCameOnline(c: c)
                        DecommissionDeadServerCard(serverDomain: deadServerFqdn ?? "", displayName: serverName)
                    } else {
                        // A BFF load failure here is transient (the box is online —
                        // that's why we opened its page — but its daemon hasn't
                        // answered this request yet, or the network blipped). Show a
                        // graceful "connecting" state, NEVER the words "not paired to
                        // a server": the server IS paired; we just don't have its
                        // detail this instant. Pull-to-refresh retries. (The
                        // boot-unlock approval card is hoisted to the top of the
                        // page, so a locked box waiting for approval stays
                        // actionable here even though this BFF load failed.)
                        connecting(c: c)
                    }
                case .loaded(let d):
                    overview(d: d, c: c)
                    MetricsSection(state: metrics)
                    cert(d: d, c: c)
                    deviceRow(d: d, c: c)
                    BootUnlockCard(serverDomain: d.serverFqdn)
                    FrontPageCard(serverDomain: d.serverFqdn)
                    LockPowerCard(serverDomain: d.serverFqdn)
                    DeadManCard(serverDomain: d.serverFqdn, serverName: serverName ?? d.serverFqdn)
                    timeline(d: d, c: c)
                    if deadServer {
                        // Registered but never came online: offer the
                        // decommission/free-the-name action with its FQDN
                        // (the release path) ALONGSIDE the lost/stolen Revoke.
                        DecommissionDeadServerCard(serverDomain: d.serverFqdn.isEmpty ? (deadServerFqdn ?? "") : d.serverFqdn, displayName: serverName)
                    }
                    DangerZoneCard(serverDomain: d.serverFqdn)
                }
                Spacer().frame(height: FS.space.s12)
            }
            .padding(.horizontal, FS.space.s6)
            .padding(.top, FS.space.s4)
        }
        .background(c.bg.ignoresSafeArea())
        .navigationTitle("Server")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await onRefresh() }
    }

    /// Graceful placeholder shown when the daemon BFF load fails. The server
    /// is online (we wouldn't be on its detail page otherwise) — this is a
    /// transient "reaching the box" state, deliberately worded so it never
    /// reads as "not paired". Pull-to-refresh re-attempts the load.
    private func connecting(c: FSColors) -> some View {
        FSCard {
            VStack(alignment: .leading, spacing: FS.space.s3) {
                HStack(alignment: .top, spacing: FS.space.s3) {
                    ProgressView()
                        .padding(.top, 2)
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Connecting to your server…")
                            .font(.system(size: 17, weight: .semibold))
                            .foregroundColor(c.text)
                        Text("Your server is online. We're fetching its details — this can take a moment right after it comes up. Pull down to refresh.")
                            .font(FS.font.bodySm())
                            .foregroundColor(c.textMuted)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
        }
        .accessibilityIdentifier("server-detail-connecting")
    }

    /// Shown for a registered box that never came online. Unlike `connecting`,
    /// this is a terminal state — the box will never answer — so it explains
    /// the situation and points at the decommission card below it.
    private func neverCameOnline(c: FSColors) -> some View {
        FSCard {
            VStack(alignment: .leading, spacing: FS.space.s3) {
                HStack(alignment: .top, spacing: FS.space.s3) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .imageScale(.large)
                        .foregroundColor(c.danger)
                    VStack(alignment: .leading, spacing: 4) {
                        Text("This server never came online")
                            .font(.system(size: 17, weight: .semibold))
                            .foregroundColor(c.text)
                        Text("The install reserved this name and registered the box, but its software never checked in. If the install failed, you can decommission it below — that frees the name so you can try again.")
                            .font(FS.font.bodySm())
                            .foregroundColor(c.textMuted)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
        }
        .accessibilityIdentifier("server-detail-never-online")
    }

    private func overview(d: ServerDetailResponse, c: FSColors) -> some View {
        FSCard {
            VStack(alignment: .leading, spacing: FS.space.s2) {
                FSPill("Online", kind: .online)
                Text(d.serverFqdn)
                    .font(FS.font.mono())
                    .foregroundColor(c.text)
                HStack(spacing: FS.space.s4) {
                    stat("Apps", "\(d.serviceCount)", c: c)
                    stat("Sessions", "\(d.pairedSessionCount)", c: c)
                    stat("Daemon", d.daemonVersion, c: c)
                }
                Text("Up for \(uptime(ms: d.uptimeMs))")
                    .font(FS.font.bodySm())
                    .foregroundColor(c.textMuted)
            }
        }
    }

    private func cert(d: ServerDetailResponse, c: FSColors) -> some View {
        sectionWrap("TLS CERTIFICATE", c: c) {
            FSCard {
                if let after = d.certNotAfter, let before = d.certNotBefore {
                    VStack(alignment: .leading, spacing: FS.space.s2) {
                        labeled("Renews", relative(ms: after), c: c)
                        labeled("Issued", relative(ms: before), c: c)
                        if let sans = d.certSans, !sans.isEmpty {
                            Text("SANS").font(FS.font.caption()).foregroundColor(c.textMuted).padding(.top, FS.space.s2)
                            VStack(alignment: .leading, spacing: FS.space.s1) {
                                ForEach(sans, id: \.self) { san in
                                    Text(san).font(FS.font.mono()).foregroundColor(c.text)
                                }
                            }
                        }
                    }
                } else {
                    Text("No cert yet — provisioning…")
                        .foregroundColor(c.textMuted)
                }
            }
        }
    }

    private func deviceRow(d: ServerDetailResponse, c: FSColors) -> some View {
        sectionWrap("ACCESS", c: c) {
            VStack(spacing: FS.space.s3) {
                Button(action: onOpenSessions) {
                    FSCard {
                        HStack {
                            Image(systemName: "iphone.gen3").foregroundColor(c.primary)
                            Text("Paired devices")
                            Spacer()
                            Text("\(d.pairedSessionCount)").foregroundColor(c.textMuted)
                            Image(systemName: "chevron.right").foregroundColor(c.textMuted)
                        }
                    }
                }.buttonStyle(.plain)
                Button(action: onOpenTier) {
                    FSCard {
                        HStack {
                            Image(systemName: "creditcard").foregroundColor(c.primary)
                            Text("Tier & usage")
                            Spacer()
                            Image(systemName: "chevron.right").foregroundColor(c.textMuted)
                        }
                    }
                }.buttonStyle(.plain)
            }
        }
    }

    private func timeline(d: ServerDetailResponse, c: FSColors) -> some View {
        sectionWrap("TIMELINE", c: c) {
            if d.recentInstallEvents.isEmpty {
                FSCard { Text("Nothing yet.").foregroundColor(c.textMuted) }
            } else {
                FSCard {
                    VStack(spacing: FS.space.s3) {
                        ForEach(d.recentInstallEvents.indices, id: \.self) { i in
                            let e = d.recentInstallEvents[i]
                            HStack(alignment: .top) {
                                Circle().fill(c.primary).frame(width: 6, height: 6).padding(.top, 6)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text("\(verb(e.kind)) \(e.serviceId)").foregroundColor(c.text)
                                    if let detail = e.detail {
                                        Text(detail).font(FS.font.bodySm()).foregroundColor(c.textMuted)
                                    }
                                }
                                Spacer()
                                Text(relative(ms: e.at)).font(FS.font.caption()).foregroundColor(c.textMuted)
                            }
                            if i < d.recentInstallEvents.count - 1 {
                                Divider().background(c.border)
                            }
                        }
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func sectionWrap<C: View>(_ label: String, c: FSColors, @ViewBuilder content: () -> C) -> some View {
        VStack(alignment: .leading, spacing: FS.space.s3) {
            Text(label)
                .font(.system(size: 12, weight: .semibold))
                .tracking(1)
                .foregroundColor(c.textMuted)
            content()
        }
    }

    private func stat(_ label: String, _ value: String, c: FSColors) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(value).font(.system(size: 17, weight: .semibold)).foregroundColor(c.text)
            Text(label).font(.system(size: 11)).foregroundColor(c.textMuted)
        }
    }

    private func labeled(_ label: String, _ value: String, c: FSColors) -> some View {
        HStack {
            Text(label).font(FS.font.caption()).foregroundColor(c.textMuted)
            Spacer()
            Text(value).font(FS.font.body()).foregroundColor(c.text)
        }
    }

    private func uptime(ms: Int64) -> String {
        let seconds = Int(ms / 1000)
        let days = seconds / 86400
        let hours = (seconds % 86400) / 3600
        if days > 0 { return "\(days) days" }
        if hours > 0 { return "\(hours) hours" }
        return "\((seconds % 3600) / 60) minutes"
    }

    private func relative(ms: Int64) -> String {
        let date = Date(timeIntervalSince1970: TimeInterval(ms) / 1000)
        let fmt = RelativeDateTimeFormatter()
        fmt.unitsStyle = .full
        return fmt.localizedString(for: date, relativeTo: Date())
    }

    private func verb(_ kind: String) -> String {
        switch kind {
        case "installed":     return "Deployed"
        case "uninstalled":   return "Removed"
        case "deploy":        return "Redeployed"
        case "update-pulled": return "Updated"
        default:              return kind
        }
    }
}

/// Boot-unlock status + kill switch for one server. Self-contained: reads the
/// per-server choice + lease from `BootUnlockStore` and, for an "auto" server
/// with a deposited lease, offers the revoke (downgrade to phone-gated, not a
/// brick). Reads its dependencies from the environment so the parent
/// `ServerDetailScreen` stays a dumb state+callbacks view.
struct BootUnlockCard: View {
    @Environment(\.colorScheme) private var scheme
    @Environment(\.secretMailboxClient) private var mailbox
    @Environment(AppState.self) private var app
    @Environment(ToastCenter.self) private var toasts

    let serverDomain: String

    private let store = BootUnlockStore()
    @State private var mode: BootUnlockStore.Mode = .auto
    @State private var leaseId: String?
    @State private var revoking = false

    var body: some View {
        let c = FSColors.scheme(scheme)
        VStack(alignment: .leading, spacing: FS.space.s3) {
            Text("BOOT UNLOCK")
                .font(.system(size: 12, weight: .semibold))
                .tracking(1)
                .foregroundColor(c.textMuted)
            FSCard {
                VStack(alignment: .leading, spacing: FS.space.s2) {
                    switch mode {
                    case .auto:
                        Label("Reboots on its own", systemImage: "bolt.fill")
                            .font(FS.font.body())
                            .foregroundColor(c.text)
                        if leaseId != nil {
                            Text("This box self-unlocks its encrypted disk after a reboot — no phone needed. flagshipserver.com only ever holds a key it can't read.")
                                .font(FS.font.caption())
                                .foregroundColor(c.textMuted)
                            FSDangerButton(
                                revoking ? "Disabling…" : "Require my phone each boot",
                                block: true
                            ) {
                                Task { await revoke() }
                            }
                            .accessibilityIdentifier("sd-revoke-autounlock")
                        } else {
                            Text("After you approve its first boot, this box will self-unlock on future reboots. Nothing to do until then.")
                                .font(FS.font.caption())
                                .foregroundColor(c.textMuted)
                        }
                    case .approve:
                        Label("Authorize each boot", systemImage: "faceid")
                            .font(FS.font.body())
                            .foregroundColor(c.text)
                        Text("This box asks your phone for approval on every reboot — the most theft-resistant mode.")
                            .font(FS.font.caption())
                            .foregroundColor(c.textMuted)
                    }
                }
            }
        }
        .onAppear { reload() }
    }

    private func reload() {
        mode = store.effectiveMode(for: serverDomain)
        leaseId = store.leaseId(for: serverDomain)
    }

    private func revoke() async {
        guard !revoking, let leaseId, let username = app.currentUser else { return }
        revoking = true
        defer { revoking = false }
        let coord = SecretRequestCoordinator(
            mailbox: mailbox,
            username: username,
            irkProvider: { try await Keystore.deriveIRK(reason: "Disable auto-unlock for \(serverDomain)") },
            // revoke never unseals — no candidate seeds needed.
            unsealSeedProvider: { _ in [] }
        )
        do {
            try await coord.revokeAutoUnlockLease(serverDomain: serverDomain, leaseId: leaseId)
            store.setLeaseId(nil, for: serverDomain)
            self.leaseId = nil
            toasts.success("Auto-unlock disabled. This box will ask your phone on its next reboot.")
        } catch {
            toasts.error("Couldn't disable auto-unlock: \(error.localizedDescription)")
        }
    }
}

/// Surfaces a box's pending boot-unlock request right on the server page so
/// the owner can approve it WITHOUT a push. A headless box at boot posts its
/// unlock request to the identity-plane mailbox; push normally wakes the
/// phone to approve, but push is unreliable. This card auto-polls the
/// mailbox, so push is just an accelerator: when a box is waiting, the owner
/// sees it here and can approve in one tap (the biometric/IRK prompt fires
/// inside `confirmAndRespond`). A box that's up & unlocked has no pending
/// request — the card sits idle and renders nothing.
///
/// Self-contained like `BootUnlockCard`: builds its coordinator from the
/// environment (mailbox + active account + Keystore-derived keys) exactly as
/// `SecretRequestsContainer` does, so the parent screen stays dumb.
struct BootUnlockApprovalCard: View {
    @Environment(\.colorScheme) private var scheme
    @Environment(\.secretMailboxClient) private var mailbox
    @Environment(AppState.self) private var app

    let serverDomain: String
    /// The pod's cheap `awaitingUnlock` flag from the unauthenticated `/pods`
    /// directory — NO biometric to read. When true the box has posted a
    /// boot-unlock request, so the card surfaces the Approve/Deny prompt
    /// directly (no "check for unlock request" tap, no Face ID just to look).
    /// The directory poll refreshes it on a timer + on foreground, so the
    /// prompt appears on its own the moment a box starts waiting.
    var awaitingUnlock: Bool = false

    @State private var vm: BootUnlockApprovalViewModel?

    var body: some View {
        let c = FSColors.scheme(scheme)
        // Build the VM synchronously on the first body eval (a zero-size view's
        // onAppear can fail to fire inside a ScrollView). It holds no side
        // effects — detection is driven by the `awaitingUnlock` flag below, and
        // Face ID fires only when the owner taps Approve.
        let model = vm ?? BootUnlockApprovalViewModel(
            serverDomain: serverDomain,
            makeCoordinator: makeCoordinator
        )
        return content(vm: model, c: c)
            .onAppear {
                if vm == nil { vm = model }
                model.setAwaitingUnlock(awaitingUnlock)
            }
            .onChange(of: awaitingUnlock) { _, now in
                model.setAwaitingUnlock(now)
            }
            .onDisappear { vm?.stop() }
    }

    @ViewBuilder
    private func content(vm: BootUnlockApprovalViewModel, c: FSColors) -> some View {
        switch vm.state {
        case .idle:
            EmptyView()
        case .requestPending:
            requestCard(vm: vm, c: c)
        case .approving:
            statusCard(c: c) {
                HStack(spacing: FS.space.s2) {
                    ProgressView()
                    Text("Sending approval…").foregroundColor(c.text)
                }
            }
        case .approved:
            statusCard(c: c) {
                Label("Unlock approved — your box should come online shortly.", systemImage: "checkmark.seal.fill")
                    .font(FS.font.body())
                    .foregroundColor(c.text)
            }
        case .failed(let msg):
            statusCard(c: c) {
                VStack(alignment: .leading, spacing: FS.space.s2) {
                    Text(msg).font(FS.font.caption()).foregroundColor(c.danger)
                    FSGhostButton("Retry", block: true) { vm.retry() }
                        .accessibilityIdentifier("sd-approve-unlock-retry")
                }
            }
        }
    }

    /// The directory says this box is waiting — ask the owner to Approve or
    /// Deny DIRECTLY. No biometric has fired; Face ID fires once, only when
    /// they tap Approve (and covers the whole ceremony via memoized keys).
    private func requestCard(vm: BootUnlockApprovalViewModel, c: FSColors) -> some View {
        sectionWrap("BOX WAITING", c: c) {
            FSCard {
                VStack(alignment: .leading, spacing: FS.space.s2) {
                    Text("Your box is waiting for your approval to unlock")
                        .font(.system(size: 17, weight: .semibold))
                        .foregroundColor(c.text)
                    Text("If you just powered it on, release its disk key to bring it online. Your phone will ask for Face ID once to approve.")
                        .font(FS.font.caption())
                        .foregroundColor(c.textMuted)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.top, FS.space.s1)
                    FSPrimaryButton("Approve unlock", block: true, large: true) {
                        Task { await vm.approve() }
                    }
                    .accessibilityIdentifier("sd-approve-unlock")
                    .padding(.top, FS.space.s2)
                    FSGhostButton("Deny", block: true) { vm.deny() }
                        .accessibilityIdentifier("sd-deny-unlock")
                }
            }
        }
    }

    private func statusCard<C: View>(c: FSColors, @ViewBuilder content: @escaping () -> C) -> some View {
        sectionWrap("BOOT UNLOCK", c: c) {
            FSCard { content() }
        }
    }

    @ViewBuilder
    private func sectionWrap<C: View>(_ label: String, c: FSColors, @ViewBuilder content: () -> C) -> some View {
        VStack(alignment: .leading, spacing: FS.space.s3) {
            Text(label)
                .font(.system(size: 12, weight: .semibold))
                .tracking(1)
                .foregroundColor(c.textMuted)
            content()
        }
    }

    private func makeCoordinator() -> ApprovalSource? {
        guard let username = app.currentUser else { return nil }
        // Derive the IRK + this server's BAK in ONE biometric, memoized so the
        // whole approve ceremony (mailbox-auth fetch → unseal → response →
        // lease) reuses them instead of re-prompting Face ID 3-4 times.
        let keys = ApprovalKeyCache(serverDomain: serverDomain)
        return SecretRequestCoordinator(
            mailbox: mailbox,
            username: username,
            irkProvider: { try await keys.irk() },
            unsealSeedProvider: { _ in try await keys.unsealSeeds() },
            watchDelegateKeyProvider: { Keystore.watchDelegateKey() }
        )
    }
}

/// Memoizes the boot-unlock approval keys so the multi-step approve ceremony
/// runs under a SINGLE Face ID. `Keystore.deriveApprovalKeys` unwraps the UMK
/// once (one biometric) and yields the account IRK + the server BAK; every
/// provider the coordinator calls (mailbox-auth IRK, unseal seeds, response
/// header, lease) then resolves from this cache without re-prompting.
private actor ApprovalKeyCache {
    private let serverDomain: String
    private var cached: (irk: Curve25519.Signing.PrivateKey, bak: Curve25519.Signing.PrivateKey)?
    init(serverDomain: String) { self.serverDomain = serverDomain }
    private func keys() async throws -> (irk: Curve25519.Signing.PrivateKey, bak: Curve25519.Signing.PrivateKey) {
        if let cached { return cached }
        let k = try await Keystore.deriveApprovalKeys(
            serverId: serverDomain,
            reason: "Approve your box's boot unlock"
        )
        cached = k
        return k
    }
    func irk() async throws -> Curve25519.Signing.PrivateKey { try await keys().irk }
    func unsealSeeds() async throws -> [Data] {
        let k = try await keys()
        return [k.bak.rawRepresentation, k.irk.rawRepresentation]
    }
}

/// Decommission a registered-but-dead server (one that never came online).
/// Frees the name via the owner-IRK-signed `ReleaseServerName` release flow —
/// the SAME path the pending-cancel uses — so a failed install can be cleaned
/// up + the name reused. Distinct from `DangerZoneCard`'s lost/stolen Revoke:
/// this is for a box that never checked in (no risk of bricking a live box),
/// frees the name for reuse, and uses the shared `cancelPendingServer` helper
/// which keeps the pod on a release failure (so the name never strands
/// half-deleted) and removes it on success.
struct DecommissionDeadServerCard: View {
    @Environment(\.colorScheme) private var scheme
    @Environment(\.flagshipServerClient) private var server
    @Environment(AppState.self) private var app
    @Environment(ToastCenter.self) private var toasts

    let serverDomain: String
    let displayName: String?

    @State private var confirming = false
    @State private var working = false

    var body: some View {
        let c = FSColors.scheme(scheme)
        VStack(alignment: .leading, spacing: FS.space.s3) {
            Text("DECOMMISSION")
                .font(.system(size: 12, weight: .semibold))
                .tracking(1)
                .foregroundColor(c.textMuted)
            FSCard {
                VStack(alignment: .leading, spacing: FS.space.s2) {
                    Text("This server never came online. Delete it to free the name for reuse — the box can no longer come online afterward.")
                        .font(FS.font.caption())
                        .foregroundColor(c.textMuted)
                    FSDangerButton(working ? "Deleting…" : "Delete this server (free the name)", block: true) {
                        confirming = true
                    }
                    .disabled(working)
                    .accessibilityIdentifier("sd-decommission-dead-server")
                }
            }
        }
        .alert("Delete \(displayName ?? "this server")?", isPresented: $confirming) {
            Button("Cancel", role: .cancel) {}
            Button("Delete", role: .destructive) { Task { await fire() } }
        } message: {
            Text("This frees the name for reuse and the box can no longer come online. This server never checked in.")
        }
    }

    @MainActor
    private func fire() async {
        guard !working else { return }
        working = true
        defer { working = false }
        // Build a pod shaped for the shared release helper. The fqdn is what
        // the release signs over; the podId is fqdn-derived so a success removal
        // hits the same pod AppState holds.
        let pod = PodInfo(
            podId: PodInfo.podId(forFqdn: serverDomain),
            name: displayName ?? PendingServerReconciler.serverNameFromFqdn(serverDomain),
            fqdn: serverDomain,
            status: .online,
            cameOnline: false
        )
        await cancelPendingServer(pod: pod, server: server, app: app, toasts: toasts)
    }
}

/// P13 — per-server danger zone. Exposes a single "Revoke this server"
/// button that opens a sheet with a reason picker + a hold-to-confirm
/// primary. Pure presentation; the signing+POST live in
/// `RevokeServerViewModel`.
struct DangerZoneCard: View {
    @Environment(\.colorScheme) private var scheme
    @Environment(\.flagshipServerClient) private var server
    @Environment(AppState.self) private var app
    @Environment(ToastCenter.self) private var toasts

    let serverDomain: String

    @State private var showSheet = false

    var body: some View {
        let c = FSColors.scheme(scheme)
        VStack(alignment: .leading, spacing: FS.space.s3) {
            Text("DANGER ZONE")
                .font(.system(size: 12, weight: .semibold))
                .tracking(1)
                .foregroundColor(c.textMuted)
            FSCard {
                VStack(alignment: .leading, spacing: FS.space.s2) {
                    Text("Revoke this server when the box is lost, stolen, or being decommissioned. The box will refuse to boot — this cannot be undone.")
                        .font(FS.font.caption())
                        .foregroundColor(c.textMuted)
                    FSDangerButton("Revoke this server", block: true) {
                        showSheet = true
                    }
                    .accessibilityIdentifier("sd-revoke-server")
                }
            }
        }
        .sheet(isPresented: $showSheet) {
            RevokeServerSheet(
                serverDomain: serverDomain,
                username: { app.currentUser },
                server: server,
                onCompleted: { toasts.success("Server revoked. It will refuse to boot next time.") },
                onFailed: { msg in toasts.error("Revoke failed: \(msg)") }
            )
        }
    }
}

/// Sheet body for P13. Reason picker + hold-to-confirm primary
/// (1.5s long-press, per docs/revocation-ui.md). The visible button
/// label tracks press progress so the user gets a clear "Hold to
/// confirm" affordance.
struct RevokeServerSheet: View {
    @Environment(\.colorScheme) private var scheme
    @Environment(\.dismiss) private var dismiss

    let serverDomain: String
    let username: () -> String?
    let server: any FlagshipServerClient
    let onCompleted: () -> Void
    let onFailed: (String) -> Void

    @State private var reason: RevokeServerViewModel.Reason = .stolen
    @State private var vm: RevokeServerViewModel?
    @State private var holding = false

    /// Long-press duration. Pinned to docs/revocation-ui.md (1.5s).
    static let holdSeconds: Double = 1.5

    var body: some View {
        let c = FSColors.scheme(scheme)
        NavigationStack {
            VStack(alignment: .leading, spacing: FS.space.s4) {
                Text("Revoke this server?")
                    .font(.system(size: 22, weight: .semibold))
                    .foregroundColor(c.text)
                Text("Bricks the box on next boot — this cannot be undone. \(serverDomain) will refuse to start. Other servers on your account stay running.")
                    .font(FS.font.body())
                    .foregroundColor(c.textMuted)

                Text("REASON")
                    .font(.system(size: 12, weight: .semibold))
                    .tracking(1)
                    .foregroundColor(c.textMuted)
                    .padding(.top, FS.space.s2)

                Picker("Reason", selection: $reason) {
                    ForEach(RevokeServerViewModel.Reason.allCases, id: \.self) { r in
                        Text(r.label).tag(r)
                    }
                }
                .pickerStyle(.segmented)
                .accessibilityIdentifier("revoke-reason-picker")

                Spacer()

                if let vm, case .failed(let msg) = vm.phase {
                    Text(msg).font(FS.font.caption()).foregroundColor(c.danger)
                }

                // Primary: a long-press button. Tap-and-hold for 1.5s
                // to confirm. A short tap does nothing destructive.
                Button(action: {}) {
                    Text(buttonLabel)
                        .font(.system(size: 16, weight: .semibold))
                        .frame(maxWidth: .infinity)
                        .frame(height: 48)
                        .foregroundColor(c.danger)
                        .overlay(
                            RoundedRectangle(cornerRadius: FS.radius.md)
                                .stroke(c.danger, lineWidth: 1)
                        )
                }
                .accessibilityIdentifier("revoke-confirm-hold")
                .simultaneousGesture(
                    LongPressGesture(minimumDuration: Self.holdSeconds)
                        .onChanged { _ in holding = true }
                        .onEnded { _ in
                            holding = false
                            Task { await fire() }
                        }
                )
                .simultaneousGesture(
                    DragGesture(minimumDistance: 0)
                        .onEnded { _ in holding = false }
                )
                .disabled(isPosting)

                FSGhostButton("Cancel", block: true) { dismiss() }
                    .padding(.bottom, FS.space.s2)
            }
            .padding(FS.space.s4)
        }
    }

    private var isPosting: Bool {
        if let p = vm?.phase, case .posting = p { return true }
        if let p = vm?.phase, case .signing = p { return true }
        return false
    }

    private var buttonLabel: String {
        if isPosting { return "Revoking…" }
        if holding { return "Hold to confirm…" }
        return "Hold to revoke"
    }

    @MainActor
    private func fire() async {
        let m = vm ?? RevokeServerViewModel(
            server: server,
            serverDomain: serverDomain,
            username: username
        )
        vm = m
        await m.run(reason: reason)
        switch m.phase {
        case .completed:
            onCompleted()
            dismiss()
        case .failed(let msg):
            onFailed(msg)
        default:
            break
        }
    }
}
