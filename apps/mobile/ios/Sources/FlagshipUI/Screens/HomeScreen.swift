import SwiftUI
import FlagshipAPI
import FlagshipCore

/// Home / landing screen. Account-wide overview: greeting, quick
/// actions, list of all servers (with Add server), and the recent
/// activity timeline. Per-server detail lives behind ServerDetail.
public struct HomeScreen: View {
    @Environment(\.colorScheme) private var scheme
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
    var onOpenPod: (PodInfo) -> Void = { _ in }
    var onAddServer: () -> Void = {}
    var onSetLeader: (PodInfo) -> Void = { _ in }
    /// Cancel/delete a pending (in-flight) server straight from the list.
    var onCancelServer: (PodInfo) -> Void = { _ in }
    var onVibeCode: () -> Void = {}
    var onRefresh: () async -> Void = {}
    var onSetUpRecovery: () -> Void = {}
    var onDismissRecoveryNudge: () -> Void = {}
    var onDismissRecoveryBackupBanner: () -> Void = {}
    var onSignInAgain: () -> Void = {}

    public init(
        state: LoadingState<ServerDetailResponse>,
        username: String,
        pods: [PodInfo],
        leaderPodId: String?,
        showRecoveryNudge: Bool = false,
        showRecoveryBackupBanner: Bool = false,
        accountWasReset: Bool = false,
        deviceCapability: DeviceCapabilityBlock? = nil,
        onOpenPod: @escaping (PodInfo) -> Void = { _ in },
        onCancelServer: @escaping (PodInfo) -> Void = { _ in },
        onAddServer: @escaping () -> Void = {},
        onSetLeader: @escaping (PodInfo) -> Void = { _ in },
        onVibeCode: @escaping () -> Void = {},
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
        self.onOpenPod = onOpenPod
        self.onAddServer = onAddServer
        self.onSetLeader = onSetLeader
        self.onCancelServer = onCancelServer
        self.onVibeCode = onVibeCode
        self.onRefresh = onRefresh
        self.onSetUpRecovery = onSetUpRecovery
        self.onDismissRecoveryNudge = onDismissRecoveryNudge
        self.onDismissRecoveryBackupBanner = onDismissRecoveryBackupBanner
        self.onSignInAgain = onSignInAgain
    }

    public var body: some View {
        let c = FSColors.scheme(scheme)
        ScrollView {
            VStack(alignment: .leading, spacing: FS.space.s6) {
                header(c: c)
                if accountWasReset {
                    accountResetBanner(c: c)
                }
                if showRecoveryBackupBanner && !accountWasReset {
                    recoveryBackupBanner(c: c)
                }
                if showRecoveryNudge && !accountWasReset {
                    recoveryNudge(c: c)
                }
                quickActions(c: c)
                serversSection(c: c)
                switch state {
                case .loaded(let d):
                    recentActivity(events: d.recentInstallEvents, c: c)
                case .failed(let msg):
                    // With no server there's nothing to load — a
                    // "couldn't load" card is misleading. Leave the
                    // space empty until the user adds their first server.
                    if pods.isEmpty {
                        EmptyView()
                    } else {
                        ErrorCard(message: msg)
                    }
                default:
                    EmptyView()
                }
                Spacer().frame(height: FS.space.s12)
            }
            .padding(.horizontal, FS.space.s6)
        }
        .background(c.bg.ignoresSafeArea())
        .refreshable { await onRefresh() }
    }

    /// E7 — "your account was reset on another device" danger banner.
    /// Renders above everything else (including the recovery nudge,
    /// which is suppressed while accountWasReset is true). Tapping
    /// Sign-in-again drops the user back to Welcome via app.signOut.
    private func accountResetBanner(c: FSColors) -> some View {
        FSCard {
            VStack(alignment: .leading, spacing: FS.space.s3) {
                HStack(alignment: .top, spacing: FS.space.s3) {
                    Image(systemName: "exclamationmark.shield.fill")
                        .imageScale(.large)
                        .foregroundColor(c.danger)
                    VStack(alignment: .leading, spacing: 4) {
                        Text("This device was removed from your account")
                            .font(.system(size: 17, weight: .semibold))
                            .foregroundColor(c.text)
                        Text("Another device on this account ran Disconnect, Replace, or Wipe. Sign in again with your recovery passkey to get back in.")
                            .font(FS.font.bodySm())
                            .foregroundColor(c.textMuted)
                    }
                }
                FSPrimaryButton("Sign in again", block: true, action: onSignInAgain)
            }
        }
        .accessibilityIdentifier("account-reset-banner")
    }

    /// Persistent post-creation backup-reminder banner. Mirrors the
    /// webapp banner in apps/web/public/webapp/views/home.js — surfaces
    /// the moment the user lands on Home without a cloud-recovery
    /// envelope (no online-pod gate), and stays hidden across launches
    /// once "Not now" is tapped. Tapping "Secure my account" routes
    /// into the existing recovery flow on the Settings tab.
    private func recoveryBackupBanner(c: FSColors) -> some View {
        FSCard {
            VStack(alignment: .leading, spacing: FS.space.s3) {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Your account isn't backed up yet")
                        .font(.system(size: 17, weight: .semibold))
                        .foregroundColor(c.text)
                    Text("If you lose this device, there's no way back in. Set up recovery now (one minute) so you can restore your account.")
                        .font(FS.font.bodySm())
                        .foregroundColor(c.textMuted)
                }
                HStack(spacing: FS.space.s2) {
                    FSPrimaryButton("Secure my account", block: false, action: onSetUpRecovery)
                    FSGhostButton("Not now", block: false, action: onDismissRecoveryBackupBanner)
                }
            }
        }
        .accessibilityIdentifier("recovery-backup-banner")
    }

    /// "Your phone is the only key" warning. Surfaces after the user
    /// has at least one online pod (so they're past day-0 and have
    /// real state worth losing). Tap "Set it up" routes to the
    /// RecoveryScreen on the Settings tab. The Not-now button toggles
    /// session-scoped dismissal — banner re-appears next launch
    /// because recovery is important enough to re-nudge.
    private func recoveryNudge(c: FSColors) -> some View {
        FSCard {
            VStack(alignment: .leading, spacing: FS.space.s3) {
                HStack(alignment: .top, spacing: FS.space.s3) {
                    Image(systemName: "key.horizontal.fill")
                        .imageScale(.large)
                        .foregroundColor(c.primary)
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Set up recovery")
                            .font(.system(size: 17, weight: .semibold))
                            .foregroundColor(c.text)
                        Text("Right now this device is the only way back into your account. Bank a passkey with Apple so you can recover if you lose it.")
                            .font(FS.font.bodySm())
                            .foregroundColor(c.textMuted)
                    }
                }
                HStack(spacing: FS.space.s2) {
                    FSPrimaryButton("Set it up", block: false, action: onSetUpRecovery)
                    FSGhostButton("Not now", block: false, action: onDismissRecoveryNudge)
                }
            }
        }
        .accessibilityIdentifier("recovery-nudge-card")
    }

    private func header(c: FSColors) -> some View {
        VStack(alignment: .leading, spacing: FS.space.s2) {
            Text("Welcome back,")
                .font(.system(size: 17))
                .foregroundColor(c.textMuted)
            Text(username + ".")
                .font(.system(size: 34, weight: .medium))
                .foregroundColor(c.text)
            if let cap = deviceCapability, !cap.isFullyScoped {
                deviceChip(cap, c: c)
            }
        }
        .padding(.top, FS.space.s10)
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
                                Text("You don't have any servers yet. Add your first server to start running your own apps — or come back to it whenever you like.")
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
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 280), spacing: FS.space.s3)], spacing: FS.space.s3) {
                    ForEach(pods) { pod in
                        Button(action: { onOpenPod(pod) }) {
                            PodCard(pod: pod, isLeader: pod.podId == leaderPodId)
                        }
                        .buttonStyle(.plain)
                        .contextMenu {
                            if pod.status != .pending && pod.podId != leaderPodId {
                                Button {
                                    onSetLeader(pod)
                                } label: {
                                    Label("Make leader", systemImage: "crown.fill")
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
                            }
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
        let date = Date(timeIntervalSince1970: TimeInterval(ms) / 1000)
        let fmt = RelativeDateTimeFormatter()
        fmt.unitsStyle = .abbreviated
        return fmt.localizedString(for: date, relativeTo: Date())
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

    public init(pod: PodInfo, isLeader: Bool = false) {
        self.pod = pod
        self.isLeader = isLeader
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
                        FSPill(statusLabel, kind: statusKind)
                        if isLeader { LeaderBadge() }
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
    private var statusLabel: String {
        switch pod.status {
        case .online:  return "Online"
        case .offline: return "Offline"
        case .unknown: return "Checking"
        case .pending: return "Pending"
        }
    }
    private var statusKind: FSPillKind {
        switch pod.status {
        case .online:  return .online
        case .offline: return .offline
        case .unknown: return .idle
        case .pending: return .provisioning
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
        HStack(spacing: 4) {
            Image(systemName: "crown.fill").font(.system(size: 9))
            Text("Leader").font(.system(size: 11, weight: .semibold))
        }
        .foregroundColor(c.primary)
        .padding(.horizontal, 8)
        .padding(.vertical, 2)
        .background(c.primary.opacity(0.12))
        .clipShape(Capsule())
    }
}
