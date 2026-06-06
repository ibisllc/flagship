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
    let pods: [PodInfo]
    let leaderPodId: String?
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
    var onOpenPod: (PodInfo) -> Void = { _ in }
    var onAddServer: () -> Void = {}
    var onSetLeader: (PodInfo) -> Void = { _ in }
    /// Cancel/delete a pending (in-flight) server straight from the list.
    var onCancelServer: (PodInfo) -> Void = { _ in }
    /// Decommission a registered-but-dead server (one that never came online)
    /// straight from the list — frees the name via the same release flow.
    var onDeleteDeadServer: (PodInfo) -> Void = { _ in }
    var onVibeCode: () -> Void = {}
    var onBrowseMarketplace: () -> Void = {}
    var onRefresh: () async -> Void = {}
    var onSetUpRecovery: () -> Void = {}
    var onDismissRecoveryNudge: () -> Void = {}
    var onDismissRecoveryBackupBanner: () -> Void = {}
    var onSignInAgain: () -> Void = {}

    /// Search text over the server list (name / description / fqdn). Bound to
    /// the native `.searchable` field so the large title collapses on scroll.
    @State private var search: String = ""
    /// Active status filter chip. `.all` shows every server; the others narrow
    /// the list by derived liveness. Pure presentation — the underlying pods
    /// (and every action on them) are untouched.
    @State private var statusFilter: HomeStatusFilter = .all

    public init(
        state: LoadingState<ServerDetailResponse>,
        username: String,
        pods: [PodInfo],
        leaderPodId: String?,
        showRecoveryNudge: Bool = false,
        showRecoveryBackupBanner: Bool = false,
        accountWasReset: Bool = false,
        deviceCapability: DeviceCapabilityBlock? = nil,
        awaitingApproval: Set<String> = [],
        awaitingEntitlement: Set<String> = [],
        onOpenPod: @escaping (PodInfo) -> Void = { _ in },
        onCancelServer: @escaping (PodInfo) -> Void = { _ in },
        onDeleteDeadServer: @escaping (PodInfo) -> Void = { _ in },
        onAddServer: @escaping () -> Void = {},
        onSetLeader: @escaping (PodInfo) -> Void = { _ in },
        onVibeCode: @escaping () -> Void = {},
        onBrowseMarketplace: @escaping () -> Void = {},
        onRefresh: @escaping () async -> Void = {},
        onSetUpRecovery: @escaping () -> Void = {},
        onDismissRecoveryNudge: @escaping () -> Void = {},
        onDismissRecoveryBackupBanner: @escaping () -> Void = {},
        onSignInAgain: @escaping () -> Void = {}
    ) {
        self.state = state
        self.username = username
        self.pods = pods
        self.leaderPodId = leaderPodId
        self.showRecoveryNudge = showRecoveryNudge
        self.showRecoveryBackupBanner = showRecoveryBackupBanner
        self.accountWasReset = accountWasReset
        self.deviceCapability = deviceCapability
        self.awaitingApproval = awaitingApproval
        self.awaitingEntitlement = awaitingEntitlement
        self.onOpenPod = onOpenPod
        self.onAddServer = onAddServer
        self.onSetLeader = onSetLeader
        self.onCancelServer = onCancelServer
        self.onDeleteDeadServer = onDeleteDeadServer
        self.onVibeCode = onVibeCode
        self.onBrowseMarketplace = onBrowseMarketplace
        self.onRefresh = onRefresh
        self.onSetUpRecovery = onSetUpRecovery
        self.onDismissRecoveryNudge = onDismissRecoveryNudge
        self.onDismissRecoveryBackupBanner = onDismissRecoveryBackupBanner
        self.onSignInAgain = onSignInAgain
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
                quickActions(c: c)
                serversSection(c: c)
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
                message: "If you lose this device, getting back in means a 3-day wait — and that same path lets anyone who knows your username try to claim your account. Set up recovery now (one minute) so you can restore instantly and privately.",
                ctaLabel: "Secure my account",
                onCta: onSetUpRecovery,
                onDismiss: onDismissRecoveryBackupBanner
            )
            .accessibilityIdentifier("recovery-backup-banner")
        } else if showRecoveryNudge {
            FSAnnouncementCard(
                icon: "key.horizontal.fill",
                title: "Set up recovery",
                message: "Right now, recovering this account without this device takes a 3-day wait that anyone who knows your username can start. Bank a passkey with Apple so you can recover instantly and privately instead.",
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

    /// Greeting line under the native large title + the optional restricted-
    /// device chip. The big "Home" lives in the navigation bar now (it
    /// collapses on scroll, WhatsApp-style); this keeps the personal
    /// "Welcome back, <user>." beat without a competing 34pt header.
    private func subheader(c: FSColors) -> some View {
        VStack(alignment: .leading, spacing: FS.space.s2) {
            Text(username.isEmpty ? "Welcome back." : "Welcome back, \(username).")
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
            Text("Device: \(cap.label) · \(summary)")
                .font(.system(size: 13, weight: .medium))
                .foregroundColor(c.textMuted)
        }
        .padding(.horizontal, FS.space.s3)
        .padding(.vertical, 4)
        .background(c.textMuted.opacity(0.08))
        .clipShape(RoundedRectangle(cornerRadius: FS.radius.sm))
        .accessibilityIdentifier("device-capability-chip")
        .accessibilityLabel("Device \(cap.label), \(summary).")
    }

    private func quickActions(c: FSColors) -> some View {
        // v2 — when a deviceCapability is installed, individual
        // actions disable themselves per their scope membership. A
        // nil capability (legacy single-IRK path) enables everything.
        let scopes = deviceCapability?.scopeSet
        let canVibeCode = scopes == nil || scopes!.contains(.vibeCode)
        let canInstall = scopes == nil || scopes!.contains(.installService)
        return LazyVGrid(columns: [GridItem(.adaptive(minimum: 280), spacing: FS.space.s3)], spacing: FS.space.s3) {
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
            actionRow(
                title: "Browse the marketplace",
                subtitle: "Deploy services your neighbours have published.",
                systemImage: "square.grid.2x2",
                accent: c.success,
                action: onBrowseMarketplace,
                enabled: canInstall,
                disabledReason: "This device cannot install services. Use a primary device.",
                accessibilityId: "quick-action-install-service",
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

    private func serversSection(c: FSColors) -> some View {
        VStack(alignment: .leading, spacing: FS.space.s3) {
            HStack {
                Text("YOUR SERVERS")
                    .font(.system(size: 12, weight: .semibold)).tracking(1).foregroundColor(c.textMuted)
                Spacer()
                Text("\(pods.count)")
                    .font(.system(size: 12, weight: .semibold)).foregroundColor(c.textMuted)
            }
            if pods.isEmpty {
                FSCard {
                    VStack(alignment: .leading, spacing: FS.space.s3) {
                        HStack(alignment: .top, spacing: FS.space.s3) {
                            Image(systemName: "checkmark.seal.fill")
                                .imageScale(.large)
                                .foregroundColor(c.success)
                            VStack(alignment: .leading, spacing: 4) {
                                Text("Your account is ready")
                                    .font(.system(size: 17, weight: .semibold))
                                    .foregroundColor(c.text)
                                Text("You don't have any servers yet. Add your first server to start running your own services — or come back to it whenever you like.")
                                    .font(FS.font.bodySm())
                                    .foregroundColor(c.textMuted)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                        }
                        FSPrimaryButton("Add your first server", block: true, action: onAddServer)
                            .accessibilityIdentifier("home-add-first-server")
                    }
                }
                .accessibilityIdentifier("home-empty-state")
            } else {
                // Filter chips (All / Online / Pending / Offline) over the
                // derived liveness — purely narrows what's rendered.
                FSChipRow(
                    items: HomeStatusFilter.allCases.map {
                        .init(value: $0, label: $0.label, count: filterCount($0))
                    },
                    selection: $statusFilter
                )
                let rows = visiblePods
                if rows.isEmpty {
                    FSCard {
                        Text("No servers match “\(search.isEmpty ? statusFilter.label.lowercased() : search)”.")
                            .font(FS.font.bodySm())
                            .foregroundColor(c.textMuted)
                    }
                } else {
                    LazyVStack(spacing: FS.space.s3) {
                        ForEach(rows) { pod in
                            serverRow(pod: pod, c: c)
                        }
                    }
                }
            }
            // The empty state already carries a primary "Add your first
            // server" CTA; only show the secondary dashed "Add a server"
            // affordance once at least one server exists.
            if !pods.isEmpty {
                Button(action: onAddServer) {
                    HStack(spacing: 8) {
                        Image(systemName: "plus.circle.fill").foregroundColor(c.primary)
                        Text("Add a server").font(.system(size: 15, weight: .semibold)).foregroundColor(c.primary)
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
            }
        }
    }

    /// A single server list row (FSListRow) with the leading status-tinted
    /// icon, a status/cert subtitle, a trailing status pill + optional Leader
    /// badge, and the full long-press context menu preserved verbatim.
    private func serverRow(pod: PodInfo, c: FSColors) -> some View {
        let liveness = pod.livenessState(
            hasLiveUnlockRequest: pod.awaitingUnlock || awaitingApproval.contains(pod.fqdn.lowercased()) || awaitingEntitlement.contains(pod.fqdn.lowercased())
        )
        let isLeader = pod.podId == leaderPodId
        return Button(action: { onOpenPod(pod) }) {
            FSListRow(
                leading: .icon("server.rack", color: PodStatusStyle.iconColor(liveness: liveness, status: pod.status, c: c)),
                title: pod.name,
                subtitle: serverSubtitle(pod: pod, liveness: liveness),
                below: {
                    // Status pill (+ Leader badge) stacks UNDER the text on its
                    // own line — a long label like "Never came online" would be
                    // crushed in the right-floated trailing slot against the name.
                    HStack(spacing: FS.space.s2) {
                        if isLeader && pod.cameOnline { LeaderBadge() }
                        FSPill(
                            PodStatusStyle.label(liveness: liveness, status: pod.status),
                            kind: PodStatusStyle.pillKind(liveness: liveness, status: pod.status)
                        )
                        .accessibilityIdentifier(PodStatusStyle.pillAccessibilityId(liveness: liveness, status: pod.status))
                    }
                }
            ) {
                // Navigation chevron stays right, vertically centered.
                Image(systemName: "chevron.right").foregroundColor(c.textMuted)
            }
        }
        .buttonStyle(.plain)
        .contextMenu {
            // Leader = the daemon the screens point at; only a
            // server that came online can be one.
            if pod.status != .pending && pod.cameOnline && pod.podId != leaderPodId {
                Button {
                    onSetLeader(pod)
                } label: {
                    // System contextMenu only renders SF Symbols for icons, so
                    // the custom LeaderFlag can't be used here — use the closest
                    // stock flag symbol instead of the retired crown.
                    Label("Make leader", systemImage: "flag.fill")
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
            } else if liveness == .dead {
                // GENUINELY dead: registered, no live unlock
                // request, no check-in, and past the grace
                // window. Decommission via the release flow
                // (frees the name) — NOT offered for a box that's
                // waiting for approval or still coming online.
                Button(role: .destructive) {
                    onDeleteDeadServer(pod)
                } label: {
                    Label("Delete server (free name)", systemImage: "trash")
                }
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
                        if isLeader && pod.cameOnline { LeaderBadge() }
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
        switch liveness {
        case .dead:               return .offline
        case .offline:            return .offline
        case .waitingForApproval: return .provisioning
        case .comingOnline:       return .provisioning
        case .online:
            switch status {
            case .online:  return .online
            case .offline: return .offline
            case .unknown: return .idle
            case .pending: return .provisioning
            }
        }
    }

    static func iconColor(liveness: PodInfo.LivenessState, status: PodInfo.Status, c: FSColors) -> Color {
        switch pillKind(liveness: liveness, status: status) {
        case .online:       return c.success
        case .renewing:     return c.warning
        case .offline:      return c.danger
        case .provisioning: return c.primary
        case .idle:         return c.textMuted
        }
    }

    static func pillAccessibilityId(liveness: PodInfo.LivenessState, status: PodInfo.Status) -> String {
        switch liveness {
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
            if liveness == .dead || liveness == .offline { return true }
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
    public init() {}
    public var body: some View {
        let c = FSColors.scheme(scheme)
        HStack(spacing: 6) {
            LeaderFlag(size: 11, tint: c.primary)
            Text("Leader").font(.system(size: 11, weight: .semibold))
        }
        .foregroundColor(c.primary)
        .padding(.horizontal, 10)
        .padding(.vertical, 2)
        .frame(minHeight: 22)
        .background(c.primary.opacity(0.12))
        .clipShape(Capsule())
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
