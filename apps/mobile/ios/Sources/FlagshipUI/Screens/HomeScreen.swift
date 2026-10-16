import SwiftUI
import FlagshipAPI
import FlagshipCore

/// Home / landing screen. Account-wide overview: greeting, quick
/// actions, list of all servers (with Add server), and the recent
/// activity timeline. Per-server detail lives behind ServerDetail.
public struct HomeScreen: View {
    @Environment(\.colorScheme) private var scheme
    /// iPad/regular panes already carry the destination name in the sidebar,
    /// so the giant in-content large title is redundant there — degrade it to
    /// an inline title. iPhone (compact) keeps the WhatsApp-style collapsing
    /// large title.
    @Environment(\.horizontalSizeClass) private var sizeClass
    let state: LoadingState<ServerDetailResponse>
    let username: String
    /// Locally-decrypted account name. Nil while locked or not yet set, in
    /// which case the routing handle stands in.
    let accountDisplayName: String?
    /// Locally-decrypted name THIS device chose for itself.
    let deviceDisplayName: String?
    let pods: [PodInfo]
    let leaderPodId: String?
    /// `issuedAt` of the order on screen (0 when the owner never ordered).
    let serverOrderIssuedAt: Int64
    /// Per pod id, the `issuedAt` of the order that box reports holding
    /// (docs/server-order.md "Acknowledgement"). The Leader badge stays gray
    /// until the leader holds the order on screen.
    let serverOrderAcks: [String: Int64]
    /// When true, render the recovery-setup nudge banner above quick
    /// actions. Source-of-truth lives on AppState.shouldShowRecoveryNudge
    /// — HomeTab passes the resolved value rather than the app object
    /// so HomeScreen stays previewable in isolation.
    let showRecoveryNudge: Bool
    /// Mirror of the webapp's persistent post-creation backup-reminder
    /// banner (apps/web/public/webapp/views/home.js). True when
    /// !hasCloudRecovery AND the user hasn't persistently dismissed.
    /// Distinct from `showRecoveryNudge`: the nudge above quick-actions
    /// gates on at-least-one-online-pod + session-only dismiss; this
    /// banner gates on neither, so it surfaces immediately after
    /// account creation and stays hidden across launches once dismissed.
    let showRecoveryBackupBanner: Bool
    /// E7 — when true, render the danger banner that says "your
    /// account was reset on another device" + a "Sign in again" CTA
    /// that drops the user to Welcome.
    let accountWasReset: Bool
    /// v2 device-addressing — when non-nil AND not fully-scoped, the
    /// header renders a "Device: <label> · browse-only" chip below
    /// the username, and the quick-action buttons disable themselves
    /// when their scope is absent. Nil ⇒ legacy single-IRK path; no
    /// chip, all actions enabled. Source: AppState.deviceCapability.
    let deviceCapability: DeviceCapabilityBlock?
    /// Lowercased fqdns of servers with a LIVE pending boot-unlock request
    /// (the box is waiting for the owner's approval). Drives the per-card
    /// liveness classification — a waiting box reads "Waiting for approval",
    /// never "Never came online". Source: AppState.serversAwaiting(.unlockKey).
    let awaitingApproval: Set<String>
    /// The entitlement (serve-auth) waiting set — same role as `awaitingApproval`
    /// for the other inbox lane, so a box waiting on entitlement reads "Waiting
    /// for approval" on Home, not "Never came online".
    let awaitingEntitlement: Set<String>
    /// `.com` refuses this device's status reads until the next unlock
    /// (docs/account-read-token.md); the list shows the last state.
    let statusPaused: Bool
    /// `.com` refused the server list and nothing is cached: say it's locked
    /// and offer to unlock, never "no servers yet".
    let serverListLocked: Bool
    /// Only an admin device of the account sees "Add/Import a server", in the
    /// list and on the empty state ([showsAddServer]).
    let canAddServers: Bool
    var onOpenPod: (PodInfo) -> Void = { _ in }
    var onAddServer: () -> Void = {}
    /// "Import a backup" in the Add/Import chooser.
    var onImportBackup: () -> Void = {}
    /// "Co-manage a running server": accept a server another account shares
    /// (docs/share-a-server.md), from the Add/Import chooser.
    var onCoManage: () -> Void = {}
    @State private var showAddOrImport = false
    /// Servers created to restore a backup that still wait for it (lowercased
    /// fqdn → state), and the action that sends it (docs/server-backup-and-clone.md).
    var awaitingBackup: [String: AwaitingBackupWire] = [:]
    var onSendBackup: (PodInfo) -> Void = { _ in }
    /// Move a server to the top of the owner's order (docs/server-order.md).
    var onMakeLeader: (PodInfo) -> Void = { _ in }
    /// The owner dropped a server elsewhere in the list: the new order, by pod id.
    var onReorder: ([String]) -> Void = { _ in }
    /// Unlock the account key (one prompt) and load the server list.
    var onShowMyServers: () async -> Void = {}
    /// Cancel/delete a pending (in-flight) server straight from the list.
    var onCancelServer: (PodInfo) -> Void = { _ in }
    /// Delete a registered server straight from the list (opens the
    /// typed-name confirmation sheet).
    var onDeleteServer: (PodInfo) -> Void = { _ in }
    var onVibeCode: () -> Void = {}
    var onRefresh: () async -> Void = {}
    var onSetUpRecovery: () -> Void = {}
    var onDismissRecoveryNudge: () -> Void = {}
    var onDismissRecoveryBackupBanner: () -> Void = {}
    var onSignInAgain: () -> Void = {}
    /// Servers other accounts shared with this one (docs/share-a-server.md §8).
    var sharedServers: [SharedServerRow] = []
    var onOpenShared: (String) -> Void = { _ in }

    /// Search text over the server list (name / description / fqdn). Bound to
    /// the native `.searchable` field so the large title collapses on scroll.
    @State private var search: String = ""
    /// Active status filter chip. `.all` shows every server; the others narrow
    /// the list by derived liveness. Pure presentation — the underlying pods
    /// (and every action on them) are untouched.
    @State private var statusFilter: HomeStatusFilter = .all
    /// The order on screen while a row is dragged (and until `pods` takes
    /// it), by pod id; nil otherwise.
    @State private var draftOrder: [String]?
    @State private var draggingPodId: String?
    @State private var rowFrames: [String: CGRect] = [:]
    /// The finger's y in the list, and where on the row it grabbed.
    @State private var dragY: CGFloat = 0
    @State private var grabOffset: CGFloat = 0
    @GestureState private var handleHeld = false
    @State private var unlocking = false

    public init(
        state: LoadingState<ServerDetailResponse>,
        username: String,
        accountDisplayName: String? = nil,
        deviceDisplayName: String? = nil,
        pods: [PodInfo],
        leaderPodId: String?,
        serverOrderIssuedAt: Int64 = 0,
        serverOrderAcks: [String: Int64] = [:],
        showRecoveryNudge: Bool = false,
        showRecoveryBackupBanner: Bool = false,
        accountWasReset: Bool = false,
        deviceCapability: DeviceCapabilityBlock? = nil,
        awaitingApproval: Set<String> = [],
        awaitingEntitlement: Set<String> = [],
        statusPaused: Bool = false,
        serverListLocked: Bool = false,
        canAddServers: Bool = true,
        onOpenPod: @escaping (PodInfo) -> Void = { _ in },
        onCancelServer: @escaping (PodInfo) -> Void = { _ in },
        onDeleteServer: @escaping (PodInfo) -> Void = { _ in },
        onAddServer: @escaping () -> Void = {},
        onImportBackup: @escaping () -> Void = {},
        onCoManage: @escaping () -> Void = {},
        onMakeLeader: @escaping (PodInfo) -> Void = { _ in },
        onReorder: @escaping ([String]) -> Void = { _ in },
        onShowMyServers: @escaping () async -> Void = {},
        onVibeCode: @escaping () -> Void = {},
        onRefresh: @escaping () async -> Void = {},
        onSetUpRecovery: @escaping () -> Void = {},
        onDismissRecoveryNudge: @escaping () -> Void = {},
        onDismissRecoveryBackupBanner: @escaping () -> Void = {},
        onSignInAgain: @escaping () -> Void = {},
        sharedServers: [SharedServerRow] = [],
        onOpenShared: @escaping (String) -> Void = { _ in }
    ) {
        self.state = state
        self.username = username
        self.accountDisplayName = accountDisplayName
        self.deviceDisplayName = deviceDisplayName
        self.pods = pods
        self.leaderPodId = leaderPodId
        self.serverOrderIssuedAt = serverOrderIssuedAt
        self.serverOrderAcks = serverOrderAcks
        self.showRecoveryNudge = showRecoveryNudge
        self.showRecoveryBackupBanner = showRecoveryBackupBanner
        self.accountWasReset = accountWasReset
        self.deviceCapability = deviceCapability
        self.awaitingApproval = awaitingApproval
        self.awaitingEntitlement = awaitingEntitlement
        self.statusPaused = statusPaused
        self.serverListLocked = serverListLocked
        self.canAddServers = canAddServers
        self.onOpenPod = onOpenPod
        self.onAddServer = onAddServer
        self.onImportBackup = onImportBackup
        self.onCoManage = onCoManage
        self.onMakeLeader = onMakeLeader
        self.onReorder = onReorder
        self.onShowMyServers = onShowMyServers
        self.onCancelServer = onCancelServer
        self.onDeleteServer = onDeleteServer
        self.onVibeCode = onVibeCode
        self.onRefresh = onRefresh
        self.onSetUpRecovery = onSetUpRecovery
        self.onDismissRecoveryNudge = onDismissRecoveryNudge
        self.onDismissRecoveryBackupBanner = onDismissRecoveryBackupBanner
        self.onSignInAgain = onSignInAgain
        self.sharedServers = sharedServers
        self.onOpenShared = onOpenShared
    }

    /// Only an admin device of the account adds servers to it
    /// (docs/service-access-gating.md "Account members"): the device that holds
    /// the account's admin root. Every account is opened with one, so an
    /// account never lacks an admin device. A demo account's device stands in
    /// for its owner (it holds no keys; the operator runs the account).
    public static func showsAddServer(holdsAdminRoot: Bool, isDemoAccount: Bool) -> Bool {
        holdsAdminRoot || isDemoAccount
    }

    static let addServersAdminOnly = "Only an admin device of this account can add servers."

    /// What the empty Home says, and whether it carries Add/Import a server.
    struct EmptyState: Equatable {
        let headline: String
        let hint: String
        let showsAddServer: Bool
    }

    static func emptyState(canAddServers: Bool) -> EmptyState {
        canAddServers
            ? EmptyState(headline: "Your account is ready",
                         hint: "Add your first server to start running your own services.",
                         showsAddServer: true)
            : EmptyState(headline: "No servers yet", hint: addServersAdminOnly, showsAddServer: false)
    }

    /// The Home dashboard NEVER renders a "couldn't load" card. When there's
    /// no server the Home screen already shows a create-server invite, and the
    /// server list itself conveys per-server state — so a load failure on the
    /// account-wide recent-activity feed has no card to show: the recent-
    /// activity section is simply absent. (Historically this gated the card on
    /// having an online server; the card is now gone entirely.) Kept as a pure
    /// function so the suppression is unit-testable; it always returns false.
    static func shouldShowLoadError(pods: [PodInfo]) -> Bool {
        false
    }

    public var body: some View {
        let c = FSColors.scheme(scheme)
        ScrollView {
            VStack(alignment: .leading, spacing: FS.space.s6) {
                subheader(c: c)
                // One announcement at a time, highest priority first: an
                // account-reset (danger) suppresses everything; otherwise the
                // backup banner, then the recovery nudge.
                topAnnouncement(c: c)
                if statusPaused && !pods.isEmpty {
                    HStack(spacing: FS.space.s2) {
                        Label("Status paused", systemImage: "pause.circle")
                            .font(FS.font.caption())
                            .foregroundColor(c.textMuted)
                        Spacer()
                        Button(unlocking ? "Unlocking…" : "Unlock") { showMyServers() }
                            .font(FS.font.caption())
                            .disabled(unlocking)
                            .accessibilityIdentifier("status-paused-unlock")
                    }
                    .accessibilityIdentifier("status-paused")
                }
                if !pods.isEmpty {
                    quickActions(c: c)
                }
                serversSection(c: c)
                SharedWithMeSection(rows: sharedServers, onOpen: onOpenShared)
                switch state {
                case .loaded(let d):
                    recentActivity(events: d.recentInstallEvents, c: c)
                default:
                    // No "couldn't load" card on Home — EVER. A load failure on
                    // the account-wide recent-activity feed just drops the
                    // section; the create-server invite + the server list (with
                    // each server's own status pill) already convey state, and a
                    // "not paired to a server" card would be wrong for a user who
                    // has a server or simply hasn't created one yet.
                    EmptyView()
                }
                Spacer().frame(height: FS.space.s12)
            }
            .padding(.horizontal, FS.space.s6)
            .padding(.top, FS.space.s2)
            .fsReadingColumn()
        }
        .background(c.bg.ignoresSafeArea())
        .navigationTitle("Home")
        .navigationBarTitleDisplayMode(sizeClass == .regular ? .inline : .large)
        .searchable(text: $search, placement: .navigationBarDrawer(displayMode: .automatic), prompt: "Search servers")
        .refreshable { await onRefresh() }
    }

    /// The single highest-priority announcement card. Folds the three stacked
    /// banners (account-reset / backup / recovery-nudge) into one `FSAnnouncementCard`.
    @ViewBuilder
    private func topAnnouncement(c: FSColors) -> some View {
        if accountWasReset {
            FSAnnouncementCard(
                icon: "exclamationmark.shield.fill",
                title: "This device was removed from your account",
                message: "Another device on this account ran Disconnect, Replace, or Wipe. Sign in again with your recovery passkey to get back in.",
                ctaLabel: "Sign in again",
                tint: c.danger,
                onCta: onSignInAgain
            )
            .accessibilityIdentifier("account-reset-banner")
        } else if showRecoveryBackupBanner {
            FSAnnouncementCard(
                icon: "key.horizontal.fill",
                title: "Your account isn't backed up yet",
                message: "If you lose access to this device, you may lose access to your Flagship cloud",
                ctaLabel: "Secure my account",
                onCta: onSetUpRecovery,
                onDismiss: onDismissRecoveryBackupBanner
            )
            .accessibilityIdentifier("recovery-backup-banner")
        } else if showRecoveryNudge {
            FSAnnouncementCard(
                icon: "key.horizontal.fill",
                title: "Set up recovery",
                message: "Save a passkey so you can recover your account if you get a new device.",
                ctaLabel: "Set it up",
                onCta: onSetUpRecovery,
                onDismiss: onDismissRecoveryNudge
            )
            .accessibilityIdentifier("recovery-nudge-card")
        }
    }

    /// Pods filtered by the active status chip AND the search query. Pure
    /// presentation — never mutates `pods`.
    private var visiblePods: [PodInfo] {
        let q = search.trimmingCharacters(in: .whitespaces).lowercased()
        return pods.filter { pod in
            let liveness = pod.livenessState(
                hasLiveUnlockRequest: pod.awaitingUnlock || awaitingApproval.contains(pod.fqdn.lowercased()) || awaitingEntitlement.contains(pod.fqdn.lowercased())
            )
            let matchesFilter = statusFilter.matches(pod: pod, liveness: liveness)
            let matchesSearch = q.isEmpty
                || pod.name.lowercased().contains(q)
                || pod.fqdn.lowercased().contains(q)
                || (pod.description?.lowercased().contains(q) ?? false)
            return matchesFilter && matchesSearch
        }
    }

    /// Per-filter counts off the full pod set (search-independent) so the chip
    /// badges read the account-wide totals.
    private func filterCount(_ f: HomeStatusFilter) -> Int {
        pods.filter { pod in
            let liveness = pod.livenessState(
                hasLiveUnlockRequest: pod.awaitingUnlock || awaitingApproval.contains(pod.fqdn.lowercased()) || awaitingEntitlement.contains(pod.fqdn.lowercased())
            )
            return f.matches(pod: pod, liveness: liveness)
        }.count
    }

    /// Compact account > device identity breadcrumb. Both display names are
    /// decrypted locally; the routing handle is the account fallback.
    public static func welcomeLine(accountDisplayName: String?, username: String, deviceDisplayName: String? = nil) -> String {
        let account = accountDisplayName.flatMap { $0.isEmpty ? nil : $0 } ?? username
        guard let device = deviceDisplayName, !device.isEmpty else { return account }
        return "\(account) > \(device)"
    }

    private var welcomeLine: String {
        Self.welcomeLine(accountDisplayName: accountDisplayName, username: username, deviceDisplayName: deviceDisplayName)
    }

    private func subheader(c: FSColors) -> some View {
        VStack(alignment: .leading, spacing: FS.space.s2) {
            // The ACCOUNT's chosen name leads — that is what the user named
            // this cloud. The routing handle is only the fallback for a locked
            // or not-yet-named account, since its name is ciphertext we may
            // not be able to read yet.
            Text(welcomeLine)
                .font(.system(size: 17))
                .foregroundColor(c.textMuted)
            if let cap = deviceCapability, !cap.isFullyScoped {
                deviceChip(cap, c: c)
            }
        }
    }

    /// v2 device-addressing — "Device: <label> · browse-only" chip
    /// surfaced below the username when the active session is a
    /// restricted sub-identity. Tap target is informational only; the
    /// detailed scope breakdown lives behind Settings → About this
    /// device (out-of-scope for this commit). When the device holds
    /// more than `browse` we show a count summary; reviewers (the
    /// canonical `[browse]` case) see the explicit phrase so the
    /// surface reads naturally for the demo flow.
    private func deviceChip(_ cap: DeviceCapabilityBlock, c: FSColors) -> some View {
        let summary = (cap.scopes == [.browse])
            ? "browse-only"
            : "\(cap.scopes.count) scopes"
        return HStack(spacing: FS.space.s2) {
            Image(systemName: "lock.shield")
                .foregroundColor(c.textMuted)
                .font(.system(size: 12, weight: .semibold))
            Text("Restricted device · \(summary)")
                .font(.system(size: 13, weight: .medium))
                .foregroundColor(c.textMuted)
        }
        .padding(.horizontal, FS.space.s3)
        .padding(.vertical, 4)
        .background(c.textMuted.opacity(0.08))
        .clipShape(RoundedRectangle(cornerRadius: FS.radius.sm))
        .accessibilityIdentifier("device-capability-chip")
        .accessibilityLabel("Restricted device, \(summary).")
    }

    private func quickActions(c: FSColors) -> some View {
        // v2 — when a deviceCapability is installed, individual
        // actions disable themselves per their scope membership. A
        // nil capability (legacy single-IRK path) enables everything.
        let scopes = deviceCapability?.scopeSet
        let canVibeCode = scopes == nil || scopes!.contains(.vibeCode)
        // A single action: a stack, not an adaptive grid — the grid split
        // regular-width screens into 280pt columns and left this card in one.
        return VStack(spacing: FS.space.s3) {
            actionRow(
                title: "Build a service",
                subtitle: "Describe it in plain English. Your server builds and runs it.",
                systemImage: "sparkles",
                accent: c.primary,
                action: onVibeCode,
                enabled: canVibeCode,
                disabledReason: "This device cannot build new services. Use a primary device.",
                accessibilityId: "quick-action-vibe-code",
                c: c
            )
        }
    }

    private func actionRow(
        title: String,
        subtitle: String,
        systemImage: String,
        accent: Color,
        action: @escaping () -> Void,
        enabled: Bool = true,
        disabledReason: String? = nil,
        accessibilityId: String? = nil,
        c: FSColors
    ) -> some View {
        Button(action: action) {
            FSCard {
                HStack(alignment: .top, spacing: FS.space.s3) {
                    ZStack {
                        RoundedRectangle(cornerRadius: FS.radius.sm)
                            .fill(accent.opacity(enabled ? 0.12 : 0.06))
                        Image(systemName: systemImage)
                            .foregroundColor(enabled ? accent : c.textMuted)
                            .font(.system(size: 17, weight: .semibold))
                    }
                    .frame(width: 36, height: 36)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(title)
                            .font(.system(size: 16, weight: .semibold))
                            .foregroundColor(enabled ? c.text : c.textMuted)
                        Text(enabled ? subtitle : (disabledReason ?? subtitle))
                            .font(FS.font.bodySm())
                            .foregroundColor(c.textMuted)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    Spacer()
                    Image(systemName: enabled ? "chevron.right" : "lock")
                        .foregroundColor(c.textMuted)
                }
            }
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
        .opacity(enabled ? 1.0 : 0.6)
        .accessibilityHint(enabled ? "" : (disabledReason ?? ""))
        .modifier(OptionalAccessibilityId(id: accessibilityId))
    }

    private func showMyServers() {
        guard !unlocking else { return }
        unlocking = true
        Task {
            await onShowMyServers()
            unlocking = false
        }
    }

    private func lockedCard(c: FSColors) -> some View {
        FSCard {
            VStack(alignment: .leading, spacing: FS.space.s3) {
                HStack(alignment: .top, spacing: FS.space.s3) {
                    Image(systemName: "lock.fill")
                        .imageScale(.large)
                        .foregroundColor(c.textMuted)
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Your server list is locked")
                            .font(.system(size: 17, weight: .semibold))
                            .foregroundColor(c.text)
                        Text("Flagship only shows your servers to your own devices. Unlock once on this phone to show them.")
                            .font(FS.font.bodySm())
                            .foregroundColor(c.textMuted)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                FSPrimaryButton(unlocking ? "Unlocking…" : "Show my servers", enabled: !unlocking, block: true) {
                    showMyServers()
                }
                .accessibilityIdentifier("home-show-my-servers")
            }
        }
        .accessibilityIdentifier("home-locked-state")
    }

    /// The rows in the order the list shows them: the drag's draft while
    /// one is in progress, else `pods` (already in the owner's order).
    private func ordered(_ rows: [PodInfo]) -> [PodInfo] {
        guard let draft = draftOrder else { return rows }
        let byId = Dictionary(rows.map { ($0.podId, $0) }, uniquingKeysWith: { a, _ in a })
        return draft.compactMap { byId[$0] } + rows.filter { !draft.contains($0.podId) }
    }

    /// Reordering only makes sense over the whole list.
    private var canReorder: Bool {
        statusFilter == .all && search.trimmingCharacters(in: .whitespaces).isEmpty
            && pods.filter({ $0.status != .pending && !$0.isRevoked }).count > 1
    }

    private func move(_ podId: String, by offset: Int) {
        var ids = pods.map(\.podId)
        guard let i = ids.firstIndex(of: podId) else { return }
        let j = i + offset
        guard ids.indices.contains(j) else { return }
        ids.swapAt(i, j)
        onReorder(ids)
    }

    private func serversSection(c: FSColors) -> some View {
        VStack(alignment: .leading, spacing: FS.space.s3) {
            if serverListLocked {
                lockedCard(c: c)
            } else if pods.isEmpty {
                let empty = Self.emptyState(canAddServers: canAddServers)
                FSCard {
                    VStack(alignment: .leading, spacing: FS.space.s3) {
                        HStack(alignment: .top, spacing: FS.space.s3) {
                            Image(systemName: empty.showsAddServer ? "checkmark.seal.fill" : "server.rack")
                                .imageScale(.large)
                                .foregroundColor(empty.showsAddServer ? c.success : c.textMuted)
                            VStack(alignment: .leading, spacing: 4) {
                                Text(empty.headline)
                                    .font(.system(size: 17, weight: .semibold))
                                    .foregroundColor(c.text)
                                Text(empty.hint)
                                    .font(FS.font.bodySm())
                                    .foregroundColor(c.textMuted)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                        }
                        // The same button and menu as a populated list.
                        if empty.showsAddServer { addServerButton(c: c) }
                    }
                }
                // .contain keeps the id on the card: otherwise it overrides
                // the children's own ids (home-add-server).
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("home-empty-state")
            } else {
                HStack {
                    Text("YOUR SERVERS")
                        .font(.system(size: 12, weight: .semibold)).tracking(1).foregroundColor(c.textMuted)
                    Spacer()
                    Text("\(pods.count)")
                        .font(.system(size: 12, weight: .semibold)).foregroundColor(c.textMuted)
                }
                if canAddServers { addServerButton(c: c) }
                // Filter chips (All / Online / Pending / Offline) over the
                // derived liveness — purely narrows what's rendered.
                FSChipRow(
                    items: HomeStatusFilter.allCases.map {
                        .init(value: $0, label: $0.label, count: filterCount($0))
                    },
                    selection: $statusFilter
                )
                let rows = ordered(visiblePods)
                let leader = Self.leaderLabel(pods: ordered(pods))
                let leaderConfirmed = draftOrder == nil
                    && (serverOrderIssuedAt == 0 || (serverOrderAcks[leader?.podId ?? ""] ?? 0) >= serverOrderIssuedAt)
                if rows.isEmpty {
                    FSCard {
                        Text("No servers match “\(search.isEmpty ? statusFilter.label.lowercased() : search)”.")
                            .font(FS.font.bodySm())
                            .foregroundColor(c.textMuted)
                    }
                } else {
                    VStack(spacing: FS.space.s3) {
                        ForEach(rows) { pod in
                            serverRow(
                                pod: pod,
                                leader: leader?.podId == pod.podId ? leader : nil,
                                leaderConfirmed: leaderConfirmed,
                                c: c
                            )
                            .background(GeometryReader { g in
                                Color.clear.preference(
                                    key: ServerRowFramesKey.self,
                                    value: [pod.podId: g.frame(in: .named(Self.listSpace))]
                                )
                            })
                            .scaleEffect(draggingPodId == pod.podId ? 1.02 : 1)
                            .shadow(color: .black.opacity(draggingPodId == pod.podId ? 0.18 : 0), radius: 8, y: 3)
                            .offset(y: dragOffset(for: pod.podId))
                            .zIndex(draggingPodId == pod.podId ? 1 : 0)
                        }
                    }
                    .coordinateSpace(name: Self.listSpace)
                    .onPreferenceChange(ServerRowFramesKey.self) { rowFrames = $0 }
                    .sensoryFeedback(.selection, trigger: draftOrder) { old, new in old != nil && new != nil }
                    .onChange(of: handleHeld) { _, held in if !held { endDrag() } }
                    .onChange(of: pods.map(\.podId)) { _, _ in
                        if draggingPodId == nil { draftOrder = nil }
                    }
                    // A drop whose save never reorders `pods` (nothing changed,
                    // or the save was refused) must not leave the draft on screen.
                    .task(id: draftOrder) {
                        guard draftOrder != nil, draggingPodId == nil else { return }
                        try? await Task.sleep(for: .seconds(3))
                        if draggingPodId == nil { draftOrder = nil }
                    }
                }
            }
        }
    }

    /// "Add/Import a server": the one way to bring a server in (Create /
    /// Co-manage / Import), above the list or on the empty state.
    @ViewBuilder
    private func addServerButton(c: FSColors) -> some View {
        Button(action: { showAddOrImport = true }) {
            HStack(spacing: 8) {
                Image(systemName: "plus.circle.fill").foregroundColor(c.primary)
                Text("Add/Import a server").font(.system(size: 15, weight: .semibold)).foregroundColor(c.primary)
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
        }
        .accessibilityIdentifier("home-add-server")
        .confirmationDialog("Add/Import a server", isPresented: $showAddOrImport, titleVisibility: .visible) {
            Button("Create a new server") { onAddServer() }
                .accessibilityIdentifier("home-add-new-server")
            Button("Co-manage a running server") { onCoManage() }
                .accessibilityIdentifier("home-co-manage")
            Button("Import a backup") { onImportBackup() }
                .accessibilityIdentifier("home-import-backup")
            Button("Cancel", role: .cancel) {}
        }
    }

    static let listSpace = "home-server-list"

    /// Where the dragged row is drawn: under the finger, relative to the
    /// slot the draft order gives it.
    private func dragOffset(for podId: String) -> CGFloat {
        guard draggingPodId == podId, let slot = rowFrames[podId] else { return 0 }
        return dragY - grabOffset - slot.midY
    }

    private var orderableIds: Set<String> {
        Set(pods.filter { $0.status != .pending && !$0.isRevoked }.map(\.podId))
    }

    /// The handle's drag, in list coordinates. Lifting the finger ends it;
    /// so does the system cancelling it (`handleHeld` drops back to false).
    private func handleDrag(_ podId: String) -> some Gesture {
        DragGesture(minimumDistance: 0, coordinateSpace: .named(Self.listSpace))
            .updating($handleHeld) { _, held, _ in held = true }
            .onChanged { moveDrag(podId, y: $0.location.y) }
            .onEnded { _ in endDrag() }
    }

    private func moveDrag(_ podId: String, y: CGFloat) {
        if draggingPodId != podId {
            draggingPodId = podId
            draftOrder = draftOrder ?? pods.map(\.podId)
            grabOffset = y - (rowFrames[podId]?.midY ?? y)
        }
        dragY = y
        let center = y - grabOffset
        let ids = draftOrder ?? pods.map(\.podId)
        let movable = orderableIds
        var others = ids.filter { movable.contains($0) && $0 != podId }
        let slot = others.filter { other in rowFrames[other].map { center > $0.midY } ?? false }.count
        others.insert(podId, at: min(slot, others.count))
        let next = others + ids.filter { !movable.contains($0) }
        if next != ids {
            withAnimation(.easeInOut(duration: 0.15)) { draftOrder = next }
        }
    }

    /// The list has settled: save the order if it moved. The draft stays on
    /// screen until `pods` takes the new order (or the save puts it back).
    private func endDrag() {
        guard draggingPodId != nil else { return }
        withAnimation(.easeInOut(duration: 0.15)) { draggingPodId = nil }
        if let ids = draftOrder, ids != pods.map(\.podId) {
            onReorder(ids)
        } else {
            draftOrder = nil
        }
    }

    /// Home with the servers waiting for their backup marked, and the action that sends it.
    public func backupWaits(_ waits: [String: AwaitingBackupWire], onSend: @escaping (PodInfo) -> Void) -> HomeScreen {
        var s = self
        s.awaitingBackup = waits
        s.onSendBackup = onSend
        return s
    }

    /// A server row: a drag handle on the left while the list can be
    /// reordered, the name behind a small server glyph, the status pill
    /// (and Leader badge) under it, and the long-press context menu.
    private func serverRow(pod: PodInfo, leader: LeaderLabel?, leaderConfirmed: Bool, c: FSColors) -> some View {
        let liveness = pod.livenessState(
            hasLiveUnlockRequest: pod.awaitingUnlock || awaitingApproval.contains(pod.fqdn.lowercased()) || awaitingEntitlement.contains(pod.fqdn.lowercased())
        )
        let backupWait = liveness == .online ? awaitingBackup[pod.fqdn.lowercased()] : nil
        let reorderable = canReorder
        let draggable = reorderable && orderableIds.contains(pod.podId)
        return HStack(spacing: 0) {
            if reorderable {
                Image(systemName: "line.3.horizontal")
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundColor(draggable ? c.textMuted : .clear)
                    .frame(width: 44)
                    .frame(maxHeight: .infinity)
                    .contentShape(Rectangle())
                    .gesture(handleDrag(pod.podId), including: draggable ? .all : .none)
                    .accessibilityHidden(true)
                    .accessibilityIdentifier("home-server-handle")
            }
            Button(action: { backupWait?.state == "waiting" ? onSendBackup(pod) : onOpenPod(pod) }) {
                HStack(alignment: .center, spacing: FS.space.s3) {
                    VStack(alignment: .leading, spacing: 2) {
                        HStack(spacing: 6) {
                            Image(systemName: "server.rack")
                                .font(.system(size: 12, weight: .semibold))
                                .foregroundColor(c.textMuted)
                                .accessibilityHidden(true)
                            Text(pod.name)
                                .font(.system(size: 16, weight: .semibold))
                                .foregroundColor(c.text)
                                .lineLimit(1)
                                .truncationMode(.tail)
                        }
                        Text(serverSubtitle(pod: pod, liveness: liveness))
                            .font(FS.font.bodySm())
                            .foregroundColor(c.textMuted)
                            .lineLimit(1)
                            .truncationMode(.tail)
                        // Status pill (+ Leader badge) on its own line: a long
                        // label like "Never came online" would be crushed
                        // against the name.
                        HStack(spacing: FS.space.s2) {
                            if let leader {
                                LeaderBadge(confirmed: leaderConfirmed)
                                if let standingInFor = leader.standingInFor {
                                    Text("Standing in for \(standingInFor)")
                                        .font(FS.font.caption())
                                        .foregroundColor(c.textMuted)
                                        .accessibilityIdentifier("home-standing-in")
                                }
                            }
                            if let backupWait {
                                FSPill(backupWait.state == "restoring" ? "Restoring its backup" : "Waiting for its backup", kind: .provisioning)
                                    .accessibilityIdentifier("pod-card-awaiting-backup")
                            } else {
                                FSPill(
                                    PodStatusStyle.label(liveness: liveness, status: pod.status),
                                    kind: PodStatusStyle.pillKind(liveness: liveness, status: pod.status)
                                )
                                .accessibilityIdentifier(PodStatusStyle.pillAccessibilityId(liveness: liveness, status: pod.status))
                            }
                        }
                        .padding(.top, 2)
                    }
                    Spacer(minLength: FS.space.s2)
                    Image(systemName: "chevron.right").foregroundColor(c.textMuted)
                }
                .padding(.vertical, FS.space.s4)
                .padding(.trailing, FS.space.s4)
                .padding(.leading, reorderable ? 0 : FS.space.s4)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityActions {
                if draggable {
                    Button("Move up") { move(pod.podId, by: -1) }
                    Button("Move down") { move(pod.podId, by: 1) }
                }
            }
            .contextMenu { serverMenu(pod: pod) }
        }
        .fixedSize(horizontal: false, vertical: true)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(c.surface)
        .overlay(RoundedRectangle(cornerRadius: FS.radius.md).stroke(c.border, lineWidth: 1))
        .clipShape(RoundedRectangle(cornerRadius: FS.radius.md))
    }

    @ViewBuilder
    private func serverMenu(pod: PodInfo) -> some View {
        // Leader = the daemon the screens point at; only a
        // server that came online can be one.
        if pod.status != .pending && !pod.isRevoked && pods.first(where: { $0.status != .pending && !$0.isRevoked })?.podId != pod.podId {
            Button {
                onMakeLeader(pod)
            } label: {
                // System contextMenu only renders SF Symbols for icons, so
                // the custom LeaderFlag can't be used here — use the closest
                // stock flag symbol instead of the retired crown.
                Label("Make leader", systemImage: "flag.fill")
            }
        }
        if awaitingBackup[pod.fqdn.lowercased()]?.state == "waiting" {
            Button {
                onSendBackup(pod)
            } label: {
                Label("Send the backup", systemImage: "arrow.up.doc")
            }
        }
        Button {
            onOpenPod(pod)
        } label: {
            Label("Open", systemImage: "arrow.up.right.square")
        }
        // A pending (in-flight) server can be cancelled
        // straight from the list — frees the name + revokes
        // the install code.
        if pod.status == .pending {
            Button(role: .destructive) {
                onCancelServer(pod)
            } label: {
                Label("Cancel server", systemImage: "xmark.circle")
            }
        } else if !pod.fqdn.isEmpty {
            // Any registered server, live or not: the sheet asks for its
            // name before anything is signed.
            Button(role: .destructive) {
                onDeleteServer(pod)
            } label: {
                Label("Delete server…", systemImage: "trash")
            }
        }
    }

    /// Status / cert subtitle line for a server row. Prefers the user-set
    /// description when present (that's what the user named it for), else a
    /// short technical hint (the fqdn).
    private func serverSubtitle(pod: PodInfo, liveness: PodInfo.LivenessState) -> String {
        if let d = pod.description, !d.isEmpty { return d }
        if !pod.fqdn.isEmpty { return pod.fqdn }
        return PodStatusStyle.label(liveness: liveness, status: pod.status)
    }

    private func recentActivity(events: [RecentInstallEvent], c: FSColors) -> some View {
        VStack(alignment: .leading, spacing: FS.space.s3) {
            Text("RECENT ACTIVITY")
                .font(.system(size: 12, weight: .semibold))
                .tracking(1)
                .foregroundColor(c.textMuted)
            if events.isEmpty {
                FSCard { Text("No recent activity.").foregroundColor(c.textMuted) }
            } else {
                FSCard {
                    VStack(spacing: FS.space.s3) {
                        ForEach(events.indices, id: \.self) { idx in
                            let e = events[idx]
                            HStack(alignment: .top) {
                                Image(systemName: icon(for: e.kind))
                                    .foregroundColor(color(for: e.kind, c: c))
                                    .frame(width: 22)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text("\(verb(for: e.kind)) \(e.serviceId)")
                                        .font(FS.font.body())
                                        .foregroundColor(c.text)
                                    if let detail = e.detail {
                                        Text(detail).font(FS.font.bodySm()).foregroundColor(c.textMuted)
                                    }
                                }
                                Spacer()
                                Text(relative(ms: e.at)).font(FS.font.caption()).foregroundColor(c.textMuted)
                            }
                            if idx < events.count - 1 {
                                Divider().background(c.border)
                            }
                        }
                    }
                }
            }
        }
    }

    private func icon(for kind: String) -> String {
        switch kind {
        case "installed":     return "arrow.down.app.fill"
        case "uninstalled":   return "trash"
        case "deploy":        return "arrow.triangle.2.circlepath"
        case "update-pulled": return "arrow.triangle.pull"
        default:              return "circle.fill"
        }
    }
    private func color(for kind: String, c: FSColors) -> Color {
        switch kind {
        case "installed":   return c.success
        case "uninstalled": return c.danger
        case "deploy":      return c.primary
        default:            return c.textMuted
        }
    }
    private func verb(for kind: String) -> String {
        switch kind {
        case "installed":     return "Deployed"
        case "uninstalled":   return "Removed"
        case "deploy":        return "Redeployed"
        case "update-pulled": return "Updated"
        default:              return "Event:"
        }
    }
    private func relative(ms: Int64) -> String {
        Date.flagshipFormatted(epochMs: ms)
    }
}

/// Reusable compact server card — used in Home grid + Settings list.
/// Renders the user-facing name + (optional) one-line description and
/// status; the FQDN is technical and only surfaced in ServerDetail.
/// A "Leader" badge appears when `isLeader` is true.
public struct PodCard: View {
    @Environment(\.colorScheme) private var scheme
    public let pod: PodInfo
    public let isLeader: Bool
    /// Derived per-server liveness. Defaults to deriving from the pod alone
    /// (no live unlock request known) so existing callers / previews keep their
    /// behaviour; the Home list supplies the account-level waiting signal.
    public let liveness: PodInfo.LivenessState

    public init(pod: PodInfo, isLeader: Bool = false, liveness: PodInfo.LivenessState? = nil) {
        self.pod = pod
        self.isLeader = isLeader
        self.liveness = liveness ?? pod.livenessState(hasLiveUnlockRequest: false)
    }

    public var body: some View {
        let c = FSColors.scheme(scheme)
        FSCard {
            HStack(alignment: .top, spacing: FS.space.s3) {
                ZStack {
                    RoundedRectangle(cornerRadius: FS.radius.sm)
                        .fill(c.primary.opacity(0.12))
                    Image(systemName: "server.rack")
                        .foregroundColor(c.primary)
                }
                .frame(width: 40, height: 40)
                VStack(alignment: .leading, spacing: 6) {
                    HStack(spacing: FS.space.s2) {
                        Text(pod.name)
                            .font(.system(size: 17, weight: .semibold))
                            .foregroundColor(c.text)
                            .lineLimit(1)
                            .truncationMode(.tail)
                        Spacer(minLength: 0)
                        Image(systemName: "chevron.right").foregroundColor(c.textMuted)
                    }
                    HStack(spacing: FS.space.s2) {
                        // Liveness-driven pill: a box waiting for unlock approval
                        // reads "Waiting for approval", a recently-registered box
                        // "Coming online…", and only a genuinely-stale box
                        // "Never came online" (with the deletable framing).
                        FSPill(statusLabel, kind: statusKind)
                            .accessibilityIdentifier(pillAccessibilityId)
                        // Leader only makes sense for a server that actually
                        // came online (the leader is the daemon the screens
                        // point at) — never badge a dead box as Leader.
                        if isLeader && pod.cameOnline && pod.status != .pending { LeaderBadge() }
                        // Per-service leadership (Phase 6): the services this box
                        // currently leads (from /pods `leadsServices`). Tolerant
                        // of absence — renders nothing when empty.
                        if pod.cameOnline && !pod.leadsServices.isEmpty {
                            LeadServicesBadge(services: pod.leadsServices)
                        }
                        Spacer(minLength: 0)
                    }
                    // "Your server is being installed" — a thin
                    // determinate bar on a demo server still pre-`ready`.
                    if let demo = pod.demoServer,
                       ProvisionProgress.shouldShowProgressBar(phase: demo.phase, status: demo.status) {
                        DemoProgressBar(
                            fraction: ProvisionProgress.fraction(demo.phase),
                            failed: demo.phase == "failed"
                        )
                        .accessibilityIdentifier("pod-card-install-progress")
                    }
                    if let desc = pod.description, !desc.isEmpty {
                        Text(desc)
                            .font(FS.font.bodySm())
                            .foregroundColor(c.textMuted)
                            .lineLimit(2)
                            .truncationMode(.tail)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
        }
    }
    private var pillAccessibilityId: String {
        PodStatusStyle.pillAccessibilityId(liveness: liveness, status: pod.status)
    }
    private var statusLabel: String {
        PodStatusStyle.label(liveness: liveness, status: pod.status)
    }
    private var statusKind: FSPillKind {
        PodStatusStyle.pillKind(liveness: liveness, status: pod.status)
    }
}

/// Single source of truth for how a pod's derived liveness + raw status maps
/// to a user-facing label, an `FSPillKind`, a leading-icon color, and the
/// pill accessibility id. Shared by `PodCard` (legacy grid card, still used in
/// previews / detail) and the Home `FSListRow` server rows so the two never
/// drift.
public enum PodStatusStyle {
    public static func label(liveness: PodInfo.LivenessState, status: PodInfo.Status) -> String {
        switch liveness {
        case .revoked:            return "Revoked"
        case .dead:               return "Never came online"
        case .offline:            return "Offline"
        case .waitingForApproval: return "Waiting for approval"
        case .comingOnline:
            return status == .pending ? "Pending" : "Coming online…"
        case .online:
            switch status {
            case .online:  return "Online"
            case .offline: return "Offline"
            case .unknown: return "Checking"
            case .pending: return "Pending"
            }
        }
    }

    public static func pillKind(liveness: PodInfo.LivenessState, status: PodInfo.Status) -> FSPillKind {
        if status == .pending { return .pending }
        switch liveness {
        case .revoked:            return .offline
        case .dead:               return .offline
        case .offline:            return .offline
        case .waitingForApproval: return .provisioning
        case .comingOnline:       return .provisioning
        case .online:
            switch status {
            case .online:  return .online
            case .offline: return .offline
            case .unknown: return .idle
            case .pending: return .pending
            }
        }
    }

    static func iconColor(liveness: PodInfo.LivenessState, status: PodInfo.Status, c: FSColors) -> Color {
        switch pillKind(liveness: liveness, status: status) {
        case .online:       return c.success
        case .renewing:     return c.warning
        case .offline:      return c.danger
        case .provisioning: return c.primary
        case .pending:      return c.warning
        case .idle:         return c.textMuted
        }
    }

    static func pillAccessibilityId(liveness: PodInfo.LivenessState, status: PodInfo.Status) -> String {
        switch liveness {
        case .revoked:            return "pod-card-revoked"
        case .dead:               return "pod-card-never-online"
        case .offline:            return "pod-card-offline"
        case .waitingForApproval: return "pod-card-waiting-approval"
        case .comingOnline where status != .pending: return "pod-card-coming-online"
        default:                  return "pod-card-status"
        }
    }
}

/// Home server-list status filter (the chip row). `.all` shows everything;
/// the others narrow by derived liveness. Pure presentation.
public enum HomeStatusFilter: CaseIterable, Hashable {
    case all, online, pending, offline

    var label: String {
        switch self {
        case .all:     return "All"
        case .online:  return "Online"
        case .pending: return "Pending"
        case .offline: return "Offline"
        }
    }

    /// Whether a pod (given its derived liveness) belongs in this filter.
    /// "Pending" buckets anything provisioning/waiting/coming-online; "Offline"
    /// buckets a genuinely-dead or offline box; "Online" is strictly live.
    func matches(pod: PodInfo, liveness: PodInfo.LivenessState) -> Bool {
        switch self {
        case .all:
            return true
        case .online:
            return liveness == .online && pod.status == .online
        case .pending:
            switch liveness {
            case .waitingForApproval, .comingOnline: return true
            case .online: return pod.status == .pending || pod.status == .unknown
            default: return false
            }
        case .offline:
            if liveness == .dead || liveness == .offline || liveness == .revoked { return true }
            return liveness == .online && pod.status == .offline
        }
    }
}

/// View modifier that only stamps an accessibility identifier when
/// the caller actually supplied one — keeps the v2 device-restricted
/// buttons addressable from XCUITest / XCTest snapshot helpers, and
/// keeps the legacy callsites a no-op so the diff against the
/// previous identifier policy is minimal.
private struct OptionalAccessibilityId: ViewModifier {
    let id: String?
    func body(content: Content) -> some View {
        if let id { content.accessibilityIdentifier(id) } else { content }
    }
}

/// Small badge marking the leader pod. Leader = default holder of the
/// short canonical domain for apps (e.g. `<app>.<user>.flagship.services`
/// resolves to the leader unless an app overrides it).
public struct LeaderBadge: View {
    @Environment(\.colorScheme) private var scheme
    /// False while the leader hasn't yet confirmed it holds the newest
    /// server order: the badge is drawn gray.
    let confirmed: Bool
    public init(confirmed: Bool = true) { self.confirmed = confirmed }
    public var body: some View {
        let c = FSColors.scheme(scheme)
        let tint = confirmed ? c.primary : c.textMuted
        HStack(spacing: 6) {
            LeaderFlag(size: 11, tint: tint)
            Text("Leader").font(.system(size: 11, weight: .semibold))
        }
        .foregroundColor(tint)
        .padding(.horizontal, 10)
        .padding(.vertical, 2)
        .frame(minHeight: 22)
        .background(tint.opacity(0.12))
        .clipShape(Capsule())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(confirmed ? "Leader" : "Leader, waiting for the server to confirm")
        .accessibilityIdentifier(confirmed ? "leader-badge" : "leader-badge-pending")
    }
}

/// Per-service leadership (Phase 6) — a small "leads N" indicator for a box that
/// is the current lead for one or more services (`PodInfo.leadsServices` from
/// `/pods`). Tolerant of absence: renders nothing when the list is empty.
public struct LeadServicesBadge: View {
    @Environment(\.colorScheme) private var scheme
    public let services: [String]
    public init(services: [String]) { self.services = services }
    public var body: some View {
        let c = FSColors.scheme(scheme)
        if !services.isEmpty {
            let label = services.count == 1
                ? "Leads \(services[0])"
                : "Leads \(services.count) services"
            HStack(spacing: 6) {
                Image(systemName: "crown.fill").font(.system(size: 10, weight: .semibold))
                Text(label).font(.system(size: 11, weight: .semibold)).lineLimit(1)
            }
            .foregroundColor(c.primary)
            .padding(.horizontal, 10)
            .padding(.vertical, 2)
            .frame(minHeight: 22)
            .background(c.primary.opacity(0.12))
            .clipShape(Capsule())
            .accessibilityIdentifier("pod-leads-badge")
        }
    }
}

extension HomeScreen {
    /// The one badge in the server list: the leader, which is the first
    /// server in the shown order that is up, naming the higher servers it
    /// stands in for while they are down. Order is read from position alone.
    struct LeaderLabel: Equatable {
        let podId: String
        let standingInFor: String?
    }

    static func leaderLabel(pods: [PodInfo]) -> LeaderLabel? {
        let ranked = pods.filter { $0.status != .pending && !$0.isRevoked }
        guard let i = ranked.firstIndex(where: { $0.status == .online }) else { return nil }
        let above = ranked.prefix(i).map(\.name)
        return LeaderLabel(podId: ranked[i].podId, standingInFor: above.isEmpty ? nil : above.joined(separator: ", "))
    }
}

/// Every server row's frame in the list, for the handle drag.
private struct ServerRowFramesKey: PreferenceKey {
    static let defaultValue: [String: CGRect] = [:]
    static func reduce(value: inout [String: CGRect], nextValue: () -> [String: CGRect]) {
        value.merge(nextValue(), uniquingKeysWith: { _, new in new })
    }
}
