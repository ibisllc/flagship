import SwiftUI
import CryptoKit
import FlagshipAPI
import FlagshipCore
import Flagship

/// Drill-down view of a single server: TLS cert, uptime, version, SANs,
/// live monitoring (CPU / memory / disk / I/O), paired sessions count,
/// Danger zone (transfer, revoke, delete).
public struct ServerDetailScreen: View {
    @Environment(\.colorScheme) private var scheme
    let state: LoadingState<ServerDetailResponse>
    let metrics: LoadingState<ServerMetricsResponse>
    /// True for a registered box whose daemon never checked in (the install
    /// reserved + registered, but it never came online). Shows a "Never came
    /// online" framing in place of the transient "Connecting…" state, since
    /// this box will never connect.
    let deadServer: Bool
    /// Display name for the delete confirmation / its toast. Falls back to the
    /// FQDN's server label.
    let serverName: String?
    /// FQDN to sign the danger-zone orders for, sourced from the pod (the failed-load path
    /// has no `ServerDetailResponse.serverFqdn`). The loaded path prefers the
    /// response's own FQDN.
    let deadServerFqdn: String?
    /// The directory's cheap `awaitingUnlock` flag for this box. When true the
    /// box is definitely waiting for a boot-unlock approval, so the approval
    /// card must be offered REGARDLESS of whether the daemon BFF detail loaded.
    let awaitingUnlock: Bool
    /// The directory's cheap `awaitingEntitlement` flag — the box has posted an
    /// entitlement (serve-auth) request and is waiting for the owner to authorize
    /// it to serve. Surfaces a second approval card, same as `awaitingUnlock`.
    let awaitingEntitlement: Bool
    /// True when the BFF load failed specifically because this device has no
    /// paired-session token. Distinct from the transient "Connecting…" failure:
    /// retrying never helps until the owner pairs, so the failed state shows the
    /// one-tap "Pair this server" affordance instead.
    let notPaired: Bool
    /// HONEST LIVENESS (Fix B) — the box is `unreachable`: it checked in before
    /// but its heartbeat is now stale. Distinct from a transient connect failure
    /// and from `deadServer` (never came online). Renders "offline — last seen
    /// <…>" instead of a perpetual "Connecting…".
    let offline: Bool
    /// Humanized "last seen <…>" for the offline state, from the pod's
    /// `lastSeenMsAgo`. nil ⇒ unknown age.
    let lastSeen: String?
    /// HONEST LIVENESS (Fix B) — the box is `never`: registered but awaiting its
    /// first heartbeat. Renders "still coming up" rather than "Connecting…" or
    /// the decommission path. NOT terminal (unlike `deadServer`).
    let comingUp: Bool
    /// True while a pairing attempt is in flight (Face ID → sign → POST), so the
    /// button shows progress and can't be double-fired.
    let pairing: Bool
    /// Last STK-verified daemon-status report from `/pods`. Older daemons leave
    /// their server-detail cert seam empty even while serving HTTPS; this is the
    /// authenticated fallback for expiry, issuer, and SANs.
    let verifiedCertStatus: DaemonStatusReport?
    /// The box's latest signed health report from `/pods`, nil before the box
    /// runs the reporter.
    let health: BoxHealth?
    /// The owner revoked this box (lost / stolen / decommissioned). It can't
    /// connect, so its BFF never answers; the page offers Un-revoke instead.
    let revoked: Bool
    /// The box's registered STK from `/pods`, which binds the erase order the
    /// delete flow sends. Empty when unknown.
    let identityPubKeyHex: String
    /// The apps installed on this server (and any being copied in). Nil hides
    /// the section.
    let apps: ServerAppsController?
    /// Open an app's page, bound to this server.
    var onOpenApp: (String) -> Void = { _ in }
    /// "Create app here": the creation flow pinned to this server.
    var onCreateApp: () -> Void = {}
    var onOpenSessions: () -> Void = {}
    var onOpenTier: () -> Void = {}
    var onRefresh: () async -> Void = {}
    /// Reloads server-detail alone (no directory or metrics round-trip), for
    /// the update card's light poll while an order is pending.
    var onRefreshDetail: () async -> Void = {}
    /// Run once per tap from the "Pair this server" button. NEVER fired
    /// automatically on appearance — a biometric must be user-initiated.
    var onPair: () -> Void = {}
    /// Fired after a delete (or a replace) succeeds, so the
    /// container can pop the nav stack (this page now points at a server
    /// that no longer exists).
    var onDeleted: () -> Void = {}

    public init(
        state: LoadingState<ServerDetailResponse>,
        metrics: LoadingState<ServerMetricsResponse>,
        deadServer: Bool = false,
        serverName: String? = nil,
        deadServerFqdn: String? = nil,
        awaitingUnlock: Bool = false,
        awaitingEntitlement: Bool = false,
        notPaired: Bool = false,
        offline: Bool = false,
        lastSeen: String? = nil,
        comingUp: Bool = false,
        pairing: Bool = false,
        verifiedCertStatus: DaemonStatusReport? = nil,
        health: BoxHealth? = nil,
        revoked: Bool = false,
        identityPubKeyHex: String = "",
        apps: ServerAppsController? = nil,
        onOpenApp: @escaping (String) -> Void = { _ in },
        onCreateApp: @escaping () -> Void = {},
        onOpenSessions: @escaping () -> Void = {},
        onOpenTier: @escaping () -> Void = {},
        onRefresh: @escaping () async -> Void = {},
        onRefreshDetail: @escaping () async -> Void = {},
        onPair: @escaping () -> Void = {},
        onDeleted: @escaping () -> Void = {}
    ) {
        self.state = state
        self.metrics = metrics
        self.deadServer = deadServer
        self.serverName = serverName
        self.deadServerFqdn = deadServerFqdn
        self.awaitingUnlock = awaitingUnlock
        self.awaitingEntitlement = awaitingEntitlement
        self.notPaired = notPaired
        self.offline = offline
        self.lastSeen = lastSeen
        self.comingUp = comingUp
        self.pairing = pairing
        self.verifiedCertStatus = verifiedCertStatus
        self.health = health
        self.revoked = revoked
        self.identityPubKeyHex = identityPubKeyHex
        self.apps = apps
        self.onOpenApp = onOpenApp
        self.onCreateApp = onCreateApp
        self.onOpenSessions = onOpenSessions
        self.onOpenTier = onOpenTier
        self.onRefresh = onRefresh
        self.onRefreshDetail = onRefreshDetail
        self.onPair = onPair
        self.onDeleted = onDeleted
    }

    /// FQDN for the boot-unlock approval card: the loaded detail's own FQDN,
    /// else the pod FQDN the container always passes (available even when the
    /// daemon BFF load fails — a locked box never answers its BFF).
    private var approvalFqdn: String? {
        if case .loaded(let d) = state, !d.serverFqdn.isEmpty { return d.serverFqdn }
        return deadServerFqdn
    }

    private var title: String {
        if let n = serverName, !n.isEmpty { return n }
        if let f = approvalFqdn, !f.isEmpty { return DeleteServerViewModel.serverLabel(forFqdn: f) }
        return "Server"
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
                    // The Box Request Inbox's serve-authorization lane: a box that
                    // posted an entitlement request (no deposit, or an unencrypted
                    // box) is now actionable here too, not silently stuck.
                    BootUnlockApprovalCard(
                        serverDomain: fqdn,
                        awaitingUnlock: awaitingEntitlement,
                        purpose: .entitlement
                    )
                }
                switch state {
                case .idle, .loading:
                    // HONEST LIVENESS (Fix B) — an unreachable/coming-up box won't
                    // answer its BFF, so show its honest state straight away rather
                    // than a skeleton that resolves into "Connecting…".
                    if revoked {
                        revokedPlaceholder(c: c)
                    } else if offline || comingUp {
                        livenessPlaceholder(c: c)
                    } else {
                        ServerCardSkeleton()
                    }
                case .failed:
                    if revoked {
                        revokedPlaceholder(c: c)
                    } else if deadServer {
                        // This box registered during install but never came
                        // online; its daemon BFF will never answer. Explain that
                        // instead of the transient "Connecting…" placeholder.
                        neverCameOnline(c: c)
                    } else if offline || comingUp {
                        // The box is server-authoritatively unreachable (`offline`)
                        // or hasn't sent its first heartbeat (`comingUp`). Honest
                        // copy — NOT a perpetual "Connecting…".
                        livenessPlaceholder(c: c)
                    } else if notPaired {
                        // The box IS reachable, but this device never minted a
                        // paired-session token for it (its per-pod token slot is
                        // empty), so the BFF 401s. Retrying won't help — offer the
                        // one-tap pairing affordance (Face ID fires only on the tap).
                        notPairedCard(c: c)
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
                    if let dbg = d.debugAccess, dbg.on, let until = dbg.expiresAt,
                       until > Int64(Date().timeIntervalSince1970 * 1000) {
                        DebugAccessBanner(expiresAt: until)
                    }
                    overview(d: d, c: c)
                    if let apps {
                        if let n = d.appSandbox?.notice {
                            Text(n.text)
                                .font(FS.font.bodySm())
                                .foregroundColor(n.danger ? c.danger : c.textMuted)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .accessibilityIdentifier("sd-app-sandbox-notice")
                        }
                        ServerAppsSection(controller: apps, onOpenApp: onOpenApp, onCreate: onCreateApp)
                    }
                    MonitoringPane(health: health, metrics: metrics, cert: certificate(d))
                    deviceRow(d: d, c: c)
                    BootUnlockCard(serverDomain: d.serverFqdn)
                    ServerOrderCard(serverDomain: d.serverFqdn)
                    ShareServerCard(serverDomain: d.serverFqdn)
                    FrontPageCard(serverDomain: d.serverFqdn)
                    LockPowerCard(serverDomain: d.serverFqdn)
                    DeadManCard(serverDomain: d.serverFqdn, serverName: serverName ?? d.serverFqdn)
                    JournalCard(serverDomain: d.serverFqdn)
                    BackupMigrateCard(serverDomain: d.serverFqdn)
                    UpdateServerCard(serverDomain: d.serverFqdn, currentCommit: d.currentCommit, lastUpdate: d.lastUpdate, onRefreshDetail: onRefreshDetail)
                    // An older box doesn't report debug access and can't take a grant.
                    if d.debugAccess != nil {
                        DebugAccessCard(serverDomain: d.serverFqdn, view: d.debugAccess, onChanged: onRefreshDetail)
                    }
                }
                // The health report comes from the directory, not the box, so
                // it still shows when the box's own detail can't load.
                if !isLoaded, health != nil {
                    MonitoringPane(health: health, metrics: nil, cert: nil)
                }
                // Outside the state switch: none of these need the box, so an
                // offline, never-online or revoked server can still be revoked,
                // un-revoked or deleted.
                if let fqdn = approvalFqdn, !fqdn.isEmpty {
                    DangerZoneCard(
                        serverDomain: fqdn,
                        displayName: serverName,
                        identityPubKeyHex: identityPubKeyHex,
                        revoked: revoked,
                        canTransfer: isLoaded,
                        onDeleted: onDeleted
                    )
                }
                Spacer().frame(height: FS.space.s12)
            }
            .padding(.horizontal, FS.space.s6)
            .padding(.top, FS.space.s4)
            .fsReadingColumn()
            // Pin the content to the scroll view's width: one view that won't
            // shrink otherwise widens the scrollable area and the whole page
            // drifts sideways and bounces back.
            .containerRelativeFrame(.horizontal)
        }
        .scrollBounceBehavior(.basedOnSize, axes: .horizontal)
        .background(c.bg.ignoresSafeArea())
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await onRefresh() }
    }

    /// Shown when the BFF load failed because this device has no paired-session
    /// token. The box is online; it just doesn't trust this device yet. One tap
    /// signs an `add-paired-session` order (Face ID) and reloads. The biometric
    /// fires ONLY on the tap — never on appearance.
    private func notPairedCard(c: FSColors) -> some View {
        FSCard {
            VStack(alignment: .leading, spacing: FS.space.s3) {
                HStack(alignment: .top, spacing: FS.space.s3) {
                    Image(systemName: "link.badge.plus")
                        .imageScale(.large)
                        .foregroundColor(c.primary)
                    VStack(alignment: .leading, spacing: 4) {
                        Text("This server isn't paired with this device yet")
                            .font(.system(size: 17, weight: .semibold))
                            .foregroundColor(c.text)
                        Text("Pair it to manage this server here. Your phone will ask you to unlock once to approve.")
                            .font(FS.font.bodySm())
                            .foregroundColor(c.textMuted)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                FSPrimaryButton(pairing ? "Pairing…" : "Pair this server", block: true, large: true) {
                    onPair()
                }
                .disabled(pairing)
                .accessibilityIdentifier("sd-pair-server")
            }
        }
        .accessibilityIdentifier("server-detail-not-paired")
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
                        Text("The install reserved this name and registered the box, but its software never checked in. If the install failed, you can delete it below — that frees the name so you can try again.")
                            .font(FS.font.bodySm())
                            .foregroundColor(c.textMuted)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
        }
        .accessibilityIdentifier("server-detail-never-online")
    }

    /// A revoked box is locked out on purpose; it isn't connecting or offline.
    private func revokedPlaceholder(c: FSColors) -> some View {
        FSCard {
            VStack(alignment: .leading, spacing: FS.space.s3) {
                HStack(alignment: .top, spacing: FS.space.s3) {
                    Image(systemName: "xmark.shield.fill")
                        .imageScale(.large)
                        .foregroundColor(c.danger)
                    VStack(alignment: .leading, spacing: 4) {
                        Text("This server is revoked")
                            .font(.system(size: 17, weight: .semibold))
                            .foregroundColor(c.text)
                        Text("It can't connect or unlock until you un-revoke it. Its name stays reserved. Un-revoke it below if you got the box back, or delete it to free the name.")
                            .font(FS.font.bodySm())
                            .foregroundColor(c.textMuted)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
        }
        .accessibilityIdentifier("server-detail-revoked")
    }

    /// HONEST LIVENESS (Fix B) — the honest copy for an `offline` (was live,
    /// now stale) or `comingUp` (registered, awaiting first heartbeat) box.
    /// Neither is the transient "Connecting…" nor the terminal "never came
    /// online" decommission path. Pull-to-refresh re-checks.
    @ViewBuilder
    private func livenessPlaceholder(c: FSColors) -> some View {
        if offline {
            FSCard {
                VStack(alignment: .leading, spacing: FS.space.s3) {
                    HStack(alignment: .top, spacing: FS.space.s3) {
                        Image(systemName: "wifi.slash")
                            .imageScale(.large)
                            .foregroundColor(c.textMuted)
                        VStack(alignment: .leading, spacing: 4) {
                            Text(lastSeen.map { "Offline — last seen \($0)" } ?? "Offline")
                                .font(.system(size: 17, weight: .semibold))
                                .foregroundColor(c.text)
                            Text("This server has gone offline — its software isn't checking in right now. Its data is safe; it'll reconnect when the box is back online. Pull down to re-check.")
                                .font(FS.font.bodySm())
                                .foregroundColor(c.textMuted)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }
            }
            .accessibilityIdentifier("server-detail-offline")
        } else {
            FSCard {
                VStack(alignment: .leading, spacing: FS.space.s3) {
                    HStack(alignment: .top, spacing: FS.space.s3) {
                        ProgressView()
                            .padding(.top, 2)
                        VStack(alignment: .leading, spacing: 4) {
                            Text("Still coming up…")
                                .font(.system(size: 17, weight: .semibold))
                                .foregroundColor(c.text)
                            Text("This server is registered and powering on, but hasn't checked in for the first time yet. This can take a few minutes after a fresh install. Pull down to re-check.")
                                .font(FS.font.bodySm())
                                .foregroundColor(c.textMuted)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }
            }
            .accessibilityIdentifier("server-detail-coming-up")
        }
    }

    /// Short display form of the box-reported HEAD, or nil while unknown
    /// (e.g. an un-reburned box whose daemon predates the field).
    static func shortCommit(_ sha: String?) -> String? {
        guard let sha, sha.count == 40,
              sha.allSatisfy({ $0.isHexDigit && !$0.isUppercase }) else { return nil }
        return String(sha.prefix(8))
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
                    // The box-reported running commit (short) — the version the
                    // update card orders away from. Hidden until the box reports.
                    if let short = Self.shortCommit(d.currentCommit) {
                        stat("Version", short, c: c)
                    }
                }
                Text("Up for \(uptime(ms: d.uptimeMs))")
                    .font(FS.font.bodySm())
                    .foregroundColor(c.textMuted)
            }
        }
    }

    private func certificate(_ d: ServerDetailResponse) -> MonitoringCert {
        MonitoringCert(
            notAfter: d.certNotAfter ?? verifiedCertStatus?.certValidUntil,
            notBefore: d.certNotBefore,
            issuer: verifiedCertStatus?.certIssuer,
            sans: d.certSans ?? verifiedCertStatus?.appsServed ?? []
        )
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

    private func uptime(ms: Int64) -> String {
        let seconds = Int(ms / 1000)
        let days = seconds / 86400
        let hours = (seconds % 86400) / 3600
        if days > 0 { return "\(days) days" }
        if hours > 0 { return "\(hours) hours" }
        return "\((seconds % 3600) / 60) minutes"
    }

    private func relative(ms: Int64) -> String {
        Date.flagshipFormatted(epochMs: ms)
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
    /// Which Box Request Inbox lane this card approves: `.unlockKey` (release the
    /// disk key) or `.entitlement` (authorize the box to serve). The detection
    /// flag passed in as `awaitingUnlock` is just "is this lane waiting?".
    var purpose: SecretPurpose = .unlockKey

    @State private var vm: BootUnlockApprovalViewModel?

    private var isEntitlement: Bool { purpose == .entitlement }
    private var headline: String {
        isEntitlement ? "Your box is waiting for authorization to serve"
                      : "Your box is waiting for your approval to unlock"
    }
    private var bodyCopy: String {
        isEntitlement
            ? "Authorize this box to serve your account so it can come online. Your phone will ask you to unlock once to approve."
            : "If you just powered it on, release its disk key to bring it online. Your phone will ask you to unlock once to approve."
    }
    private var ctaLabel: String { isEntitlement ? "Authorize" : "Approve unlock" }
    private var approvedCopy: String {
        isEntitlement ? "Authorized — your box should come online shortly."
                      : "Unlock approved — your box should come online shortly."
    }

    var body: some View {
        let c = FSColors.scheme(scheme)
        // Build the VM synchronously on the first body eval (a zero-size view's
        // onAppear can fail to fire inside a ScrollView). It holds no side
        // effects — detection is driven by the `awaitingUnlock` flag below, and
        // Face ID fires only when the owner taps Approve.
        let model = vm ?? BootUnlockApprovalViewModel(
            serverDomain: serverDomain,
            purpose: purpose,
            makeCoordinator: makeCoordinator,
            initialAwaiting: awaitingUnlock
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
                Label(approvedCopy, systemImage: "checkmark.seal.fill")
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
                    Text(headline)
                        .font(.system(size: 17, weight: .semibold))
                        .foregroundColor(c.text)
                    Text(bodyCopy)
                        .font(FS.font.caption())
                        .foregroundColor(c.textMuted)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.top, FS.space.s1)
                    FSPrimaryButton(ctaLabel, block: true, large: true) {
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
            // Slice D — the RootEntitlement this approval mints signs under the
            // admin master root when present (an admin-pinned box requires it),
            // resolved from the SAME memoized cache as the IRK so the whole
            // ceremony stays a single Face ID. nil ⇒ legacy ⇒ IRK-signed.
            orderKeyProvider: { try await keys.adminRoot() },
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
    private var cached: (irk: Curve25519.Signing.PrivateKey, bak: Curve25519.Signing.PrivateKey, adminRoot: Curve25519.Signing.PrivateKey?)?
    init(serverDomain: String) { self.serverDomain = serverDomain }
    private func keys() async throws -> (irk: Curve25519.Signing.PrivateKey, bak: Curve25519.Signing.PrivateKey, adminRoot: Curve25519.Signing.PrivateKey?) {
        if let cached { return cached }
        // Slice D — derive the IRK + BAK + admin master root in ONE biometric
        // (all seal under the same SE wrapping key), so the entitlement mint's
        // admin-root signature adds no second Face ID to the approve ceremony.
        let k = try await Keystore.deriveApprovalKeysWithAdminRoot(
            serverId: serverDomain,
            reason: "Approve your box's boot unlock"
        )
        cached = k
        return k
    }
    func irk() async throws -> Curve25519.Signing.PrivateKey { try await keys().irk }
    /// The admin master root when this device holds one, else nil (⇒ the
    /// coordinator signs the RootEntitlement under the IRK). Same memoized pass.
    func adminRoot() async throws -> Curve25519.Signing.PrivateKey? { try await keys().adminRoot }
    func unsealSeeds() async throws -> [Data] {
        let k = try await keys()
        return [k.bak.rawRepresentation, k.irk.rawRepresentation]
    }
}

/// Transfer-a-box entry in the danger zone (docs/account-deletion-and-name-reclaim.md §4).
/// Owner-only — the offer is IRK-signed behind the biometric inside
/// `TransferGiverViewModel`, so only the box's owner can complete it. Opens the
/// existing `TransferGiverScreen` (type-to-confirm → QR → disk-key hand-off) in
/// a sheet. First button in the danger zone.
struct TransferButton: View {
    @Environment(\.serverTransferClient) private var transfer
    @Environment(\.secretMailboxClient) private var mailbox
    @Environment(AppState.self) private var app

    let serverDomain: String

    @State private var showSheet = false

    var body: some View {
        FSDangerButton("Transfer to another account", block: true) {
            showSheet = true
        }
        .accessibilityIdentifier("sd-transfer-server")
        .sheet(isPresented: $showSheet) {
            NavigationStack {
                TransferGiverScreen(
                    vm: TransferGiverViewModel(
                        client: transfer,
                        mailbox: mailbox,
                        serverDomain: serverDomain,
                        username: app.currentUser ?? ""
                    ),
                    serverDomain: serverDomain
                )
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Done") { showSheet = false }
                    }
                }
            }
        }
    }
}

/// The server page's Backup / Migrate card: just the two action buttons.
struct BackupMigrateCard: View {
    @Environment(\.colorScheme) private var scheme

    let serverDomain: String

    var body: some View {
        let c = FSColors.scheme(scheme)
        VStack(alignment: .leading, spacing: FS.space.s3) {
            Text("BACKUP / MIGRATE")
                .font(.system(size: 12, weight: .semibold))
                .tracking(1)
                .foregroundColor(c.textMuted)
            FSCard {
                VStack(alignment: .leading, spacing: FS.space.s2) {
                    ServerBackupButton(serverDomain: serverDomain)
                    MigrateServerButton(serverDomain: serverDomain)
                }
            }
        }
    }
}

/// "Migrate to new machine / VM" entry on server-detail (docs/server-migration.md).
/// Same owner, same address, NEW box: the guided flow provisions a replacement,
/// pre-seeds it from backup, and hands the name over — the old box is wiped only
/// after a confirmed take-over. Owner-only; the migration order is admin-signed
/// behind the biometric inside `MigrationViewModel`. Distinct from Replace
/// (retire-first, then re-create) — migration keeps the old box serving until
/// the new one is ready.
struct MigrateServerButton: View {
    @Environment(\.serverMigrationClient) private var migration
    @Environment(\.secretMailboxClient) private var mailbox
    @Environment(\.screensClient) private var screens
    @Environment(AppState.self) private var app

    let serverDomain: String

    @State private var showSheet = false

    var body: some View {
        FSPrimaryButton("Migrate to new machine / VM", block: true) {
            showSheet = true
        }
        .accessibilityIdentifier("sd-migrate-server")
        .sheet(isPresented: $showSheet) {
            NavigationStack {
                MigrateServerScreen(
                    vm: MigrationViewModel(
                        migration: migration,
                        mailbox: mailbox,
                        screens: screens,
                        serverFqdn: serverDomain,
                        username: app.currentUser ?? ""
                    )
                )
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Done") { showSheet = false }
                    }
                }
            }
        }
    }
}

/// "Update this server" entry on server-detail (docs/server-update-mechanism.md).
/// Admin-only — the update order is signed with the admin master root (when
/// pinned) behind the biometric inside `UpdateServerViewModel`, and it is only
/// HALF the gate: the box also requires the target commit to be maintainer-
/// endorsed, and rolls back automatically if the new version fails to boot.
/// Disabled (with a hint) until the box reports its running commit — the
/// order's `fromCommit` must be truth, never a guess.
struct UpdateServerCard: View {
    @Environment(\.colorScheme) private var scheme
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.secretMailboxClient) private var mailbox
    @Environment(AppState.self) private var app

    let serverDomain: String
    /// The box-reported running commit from server-detail, or nil.
    let currentCommit: String?
    /// The box's verdict on the last update order, or nil.
    var lastUpdate: LastUpdate? = nil
    /// Reloads server-detail only. Polled every 15 s while an order is pending
    /// and the page is on screen, so the box's outcome shows up on its own.
    var onRefreshDetail: () async -> Void = {}

    @Environment(\.screensClient) private var client
    @State private var showSheet = false
    @State private var latestTag: String?
    /// The order this device sent that the box hasn't reported on yet.
    @State private var pending: PendingUpdateOrder?
    @State private var resendVm: UpdateServerViewModel?

    private var reported: Bool { ServerDetailScreen.shortCommit(currentCommit) != nil }

    private func makeVm() -> UpdateServerViewModel {
        UpdateServerViewModel(
            username: app.currentUser ?? "",
            serverFqdn: serverDomain,
            currentCommit: currentCommit,
            mailbox: mailbox
        )
    }

    private func reconcile() {
        pending = PendingUpdateStore().reconcile(
            serverFqdn: serverDomain, currentCommit: currentCommit, lastUpdate: lastUpdate
        )
    }

    var body: some View {
        let c = FSColors.scheme(scheme)
        VStack(alignment: .leading, spacing: FS.space.s3) {
            Text("UPDATE FIRMWARE")
                .font(.system(size: 12, weight: .semibold))
                .tracking(1)
                .foregroundColor(c.textMuted)
            FSCard {
                VStack(alignment: .leading, spacing: FS.space.s2) {
                    if let short = ServerDetailScreen.shortCommit(currentCommit) {
                        HStack {
                            Text("Running").font(FS.font.caption()).foregroundColor(c.textMuted)
                            Spacer()
                            Text(short).font(FS.font.mono()).foregroundColor(c.text)
                        }
                    }
                    if let latestTag, pending == nil {
                        Label("New release available: \(latestTag)", systemImage: "arrow.up.circle.fill")
                            .font(FS.font.caption())
                            .foregroundColor(c.primary)
                            .accessibilityIdentifier("sd-update-available")
                    }
                    if let summary = lastUpdate?.summary {
                        Text(summary)
                            .font(FS.font.caption())
                            .foregroundColor(lastUpdate?.outcome == "applied" ? c.textMuted : c.danger)
                            .accessibilityIdentifier("sd-update-last-outcome")
                    }
                    if let pending {
                        PendingUpdateNotice(
                            order: pending,
                            working: resendVm?.isWorking ?? false,
                            failure: resendVm?.failureMessage,
                            onSendAgain: { resend(pending) },
                            onForget: { forget() }
                        )
                    } else {
                        FSDangerButton(latestTag == nil ? "Update this server" : "Update to latest", block: true) {
                            showSheet = true
                        }
                        .disabled(!reported)
                        .opacity(reported ? 1 : 0.4)
                        .accessibilityIdentifier("sd-update-server")
                        if !reported {
                            Text("Waiting for this server to report its current version — it can't be updated in place until it does.")
                                .font(FS.font.caption())
                                .foregroundColor(c.textMuted)
                        }
                    }
                }
            }
        }
        .task(id: currentCommit) {
            latestTag = (try? await ReleaseCatalogLoader.load(
                screens: client, mailbox: mailbox, currentCommit: currentCommit, refresh: false
            ))?.latest?.tag
        }
        .onAppear { reconcile() }
        .onChange(of: currentCommit) { reconcile() }
        .onChange(of: lastUpdate) { reconcile() }
        .task(id: PendingPoll(orderedAt: pending?.orderedAt, active: scenePhase == .active)) {
            guard pending != nil, scenePhase == .active else { return }
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(15))
                if Task.isCancelled { return }
                await onRefreshDetail()
            }
        }
        .sheet(isPresented: $showSheet, onDismiss: { reconcile() }) {
            NavigationStack {
                UpdateServerSheet(
                    vm: makeVm(),
                    serverFqdn: serverDomain,
                    currentCommit: currentCommit,
                    pending: $pending,
                    lastUpdate: lastUpdate
                )
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Done") { showSheet = false }
                    }
                }
            }
        }
    }

    private func resend(_ order: PendingUpdateOrder) {
        guard resendVm?.isWorking != true else { return }
        let vm = makeVm()
        resendVm = vm
        Task {
            if await vm.resend(order) { resendVm = nil }
            reconcile()
        }
    }

    private func forget() {
        PendingUpdateStore().clear(serverFqdn: serverDomain)
        resendVm = nil
        pending = nil
    }
}

private struct PendingPoll: Equatable {
    let orderedAt: Int64?
    let active: Bool
}

/// The post-send state, shared by the update card and its sheet: the order is
/// on its way, or (30 minutes on, no outcome) Send again / Forget it.
struct PendingUpdateNotice: View {
    @Environment(\.colorScheme) private var scheme
    let order: PendingUpdateOrder
    var working: Bool = false
    var failure: String? = nil
    let onSendAgain: () -> Void
    let onForget: () -> Void

    var body: some View {
        let c = FSColors.scheme(scheme)
        TimelineView(.periodic(from: .now, by: 15)) { context in
            let now = Int64(context.date.timeIntervalSince1970 * 1000)
            VStack(alignment: .leading, spacing: FS.space.s2) {
                switch UpdateCardMode(pending: order, now: now) {
                case .ready:
                    EmptyView()
                case .pending(let o):
                    HStack(alignment: .top, spacing: FS.space.s2) {
                        ProgressView().controlSize(.small)
                        Text(o.sentCopy(now: now))
                            .font(FS.font.bodySm())
                            .foregroundColor(c.text)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .accessibilityElement(children: .combine)
                    .accessibilityIdentifier("sd-update-pending")
                case .stale:
                    Text(PendingUpdateOrder.staleCopy)
                        .font(FS.font.bodySm())
                        .foregroundColor(c.text)
                        .accessibilityIdentifier("sd-update-stale")
                    HStack(spacing: FS.space.s2) {
                        FSPrimaryButton(working ? "Working…" : "Send again", enabled: !working, block: true, action: onSendAgain)
                            .accessibilityIdentifier("sd-update-send-again")
                        FSSecondaryButton("Forget it", block: true, action: onForget)
                            .disabled(working)
                            .accessibilityIdentifier("sd-update-forget")
                    }
                    if let failure {
                        Text(failure).font(FS.font.caption()).foregroundColor(c.danger)
                    }
                }
            }
        }
    }
}

/// Sheet body for the update order. The box lists the releases it verified for
/// itself; the main action is "Update to latest", other newer releases sit
/// below, and going back to an older release (or pasting any commit) is under
/// Advanced, beside its warning. Whatever is picked, the signed
/// order names one exact commit. The biometric fires ONCE, on the tap.
struct UpdateServerSheet: View {
    @Environment(\.colorScheme) private var scheme
    @Environment(\.screensClient) private var client
    @Environment(\.secretMailboxClient) private var mailbox

    @State var vm: UpdateServerViewModel
    let serverFqdn: String
    let currentCommit: String?
    /// The card's pending order for this server: while set, the sheet shows
    /// the post-send state instead of the release picker.
    @Binding var pending: PendingUpdateOrder?
    var lastUpdate: LastUpdate? = nil

    @State private var target = ""
    @State private var catalog: ReleaseCatalogResponse?
    @State private var catalogError: String?
    @State private var loadingCatalog = false
    @State private var showAdvanced = false
    /// Opened on a pending order: stays post-send if the box reports while
    /// the sheet is open (Forget it returns to the picker).
    @State private var openedPending = false

    static let downgradeWarning = "Older releases don't have the fixes made since, and may not understand changes made to this server after them, such as a rotated admin key. In the worst case the server stops accepting updates and has to be reinstalled. Only go back if a newer release broke something."

    private var working: Bool { vm.isWorking }

    /// Post-send instead of the picker: an order is pending, or one was sent
    /// from this sheet (and the box may already have reported on it).
    static func showsPostSend(phase: UpdateServerViewModel.Phase, pending: PendingUpdateOrder?) -> Bool {
        pending != nil || phase == .done
    }

    private var currentTag: String? {
        catalog?.releases.first { $0.relation == "current" }?.tag
    }

    var body: some View {
        let c = FSColors.scheme(scheme)
        ScrollView {
            VStack(alignment: .leading, spacing: FS.space.s4) {
                Text("Update \(serverFqdn)")
                    .font(FS.font.h2()).foregroundColor(c.text)
                if let short = vm.runningShort {
                    HStack {
                        Text("Running").font(FS.font.bodySm()).foregroundColor(c.textMuted)
                        Spacer()
                        Text(currentTag ?? short).font(FS.font.mono()).foregroundColor(c.text)
                    }
                }
                if openedPending || Self.showsPostSend(phase: vm.phase, pending: pending) {
                    if let pending {
                        PendingUpdateNotice(
                            order: pending,
                            working: working,
                            failure: vm.failureMessage,
                            onSendAgain: { resend(pending) },
                            onForget: {
                                vm.forgetPending()
                                self.pending = nil
                                openedPending = false
                            }
                        )
                    } else {
                        Text(lastUpdate?.summary ?? "The server has picked up the update.")
                            .font(FS.font.body()).foregroundColor(c.text)
                    }
                } else {
                    latestSection(c: c)
                    otherNewer(c: c)
                    advanced(c: c)
                    if case .failed(let msg) = vm.phase {
                        Text(msg).font(FS.font.caption()).foregroundColor(c.danger)
                    }
                }
            }
            .padding(FS.space.s6)
        }
        .background(c.bg.ignoresSafeArea())
        .navigationTitle("Update server")
        .navigationBarTitleDisplayMode(.inline)
        .onAppear { if pending != nil { openedPending = true } }
        .task { await loadCatalog(refresh: false) }
    }

    @ViewBuilder
    private func latestSection(c: FSColors) -> some View {
        if let latest = catalog?.latest {
            FSCard {
                VStack(alignment: .leading, spacing: FS.space.s3) {
                    Text("Latest release").font(FS.font.caption()).foregroundColor(c.textMuted)
                    Text(latest.tag).font(FS.font.mono()).foregroundColor(c.text)
                    FSPrimaryButton(working ? "Working…" : "Update to latest", enabled: vm.canUpdate && !working, block: true) {
                        order(latest.commit)
                    }
                    .accessibilityIdentifier("update-latest-btn")
                    Text("Approve with Face ID. The server rolls back by itself if the new version doesn't start.")
                        .font(FS.font.caption()).foregroundColor(c.textMuted)
                }
            }
        } else if loadingCatalog && catalog == nil {
            HStack(spacing: FS.space.s2) {
                ProgressView()
                Text("Checking for new releases…").font(FS.font.bodySm()).foregroundColor(c.textMuted)
            }
        } else if catalog != nil {
            HStack {
                Image(systemName: "checkmark.circle.fill").foregroundColor(c.success)
                Text("This server is on the latest release.").font(FS.font.body()).foregroundColor(c.text)
                Spacer()
                Button("Check again") { Task { await loadCatalog(refresh: true) } }
                    .font(FS.font.bodySm()).disabled(loadingCatalog)
            }
        } else if let err = catalogError {
            Text("Couldn't check for releases: \(err) You can still enter a release under Advanced.")
                .font(FS.font.bodySm()).foregroundColor(c.textMuted)
        }
        if catalog?.stale == true {
            Text("The server couldn't reach GitHub, so this list may be out of date.")
                .font(FS.font.caption()).foregroundColor(c.textMuted)
        }
    }

    @ViewBuilder
    private func otherNewer(c: FSColors) -> some View {
        let others = (catalog?.releases ?? []).filter { $0.relation == "newer" && $0.commit != catalog?.latest?.commit }
        if !others.isEmpty {
            Text("Other new releases").font(FS.font.caption()).foregroundColor(c.textMuted)
            ForEach(others) { r in
                releaseRow(r, actionLabel: "Update", c: c) { order(r.commit) }
            }
        }
    }

    private func advanced(c: FSColors) -> some View {
        DisclosureGroup(isExpanded: $showAdvanced) {
            VStack(alignment: .leading, spacing: FS.space.s3) {
                HStack(alignment: .top, spacing: FS.space.s2) {
                    Image(systemName: "exclamationmark.triangle.fill").foregroundColor(c.warning)
                    Text(Self.downgradeWarning).font(FS.font.caption()).foregroundColor(c.textMuted)
                }
                ForEach((catalog?.releases ?? []).filter { $0.relation == "older" }) { r in
                    releaseRow(r, actionLabel: "Go back", c: c) { order(r.commit) }
                }
                Text("Or enter any release (full commit)").font(FS.font.bodySm()).foregroundColor(c.textMuted)
                TextField("40-character commit hash", text: $target)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .font(FS.font.mono())
                    .padding(FS.space.s3)
                    .background(c.surface)
                    .clipShape(RoundedRectangle(cornerRadius: FS.radius.sm))
                    .accessibilityIdentifier("update-target-field")
                if let problem = vm.targetProblem(target) {
                    Text(problem).font(FS.font.caption()).foregroundColor(c.textMuted)
                }
                FSDangerButton(working ? "Working…" : "Order update", block: true) {
                    guard vm.canOrder(target), !working else { return }
                    order(target.trimmingCharacters(in: .whitespacesAndNewlines).lowercased())
                }
                .disabled(!vm.canOrder(target) || working)
                .opacity(vm.canOrder(target) && !working ? 1 : 0.4)
                .accessibilityIdentifier("update-order-btn")
            }
            .padding(.top, FS.space.s2)
        } label: {
            Text("Advanced").font(FS.font.bodySm()).foregroundColor(c.text)
        }
    }

    private func releaseRow(_ r: ReleaseEntry, actionLabel: String, c: FSColors, action: @escaping () -> Void) -> some View {
        HStack {
            Text(r.tag).font(FS.font.mono()).foregroundColor(c.text).lineLimit(1).truncationMode(.middle)
            Spacer()
            Button(actionLabel, action: action).font(FS.font.bodySm()).disabled(!vm.canUpdate || working)
        }
    }

    private func order(_ commit: String) {
        guard !working else { return }
        let tag = catalog?.releases.first { $0.commit.lowercased() == commit.lowercased() }?.tag
        Task {
            if await vm.update(targetCommit: commit, targetTag: tag) {
                pending = PendingUpdateStore().load(serverFqdn: serverFqdn)
            }
        }
    }

    private func resend(_ order: PendingUpdateOrder) {
        guard !working else { return }
        Task {
            if await vm.resend(order) {
                pending = PendingUpdateStore().load(serverFqdn: serverFqdn)
            }
        }
    }

    private func loadCatalog(refresh: Bool) async {
        loadingCatalog = true
        defer { loadingCatalog = false }
        do {
            catalog = try await ReleaseCatalogLoader.load(
                screens: client, mailbox: mailbox, currentCommit: currentCommit, refresh: refresh
            )
            catalogError = nil
        } catch {
            if catalog == nil { catalogError = ScreensClientError.userFacing(error) }
        }
    }
}

/// Per-server danger zone: Revoke (reversible) or Un-revoke, and Delete. None
/// of these needs the box to answer, so the page shows this card in every
/// state. The signing + POSTs live in `RevokeServerViewModel`,
/// `UnrevokeServerViewModel` and `DeleteServerViewModel`.
struct DangerZoneCard: View {
    @Environment(\.colorScheme) private var scheme
    @Environment(\.flagshipServerClient) private var server
    @Environment(AppState.self) private var app
    @Environment(ToastCenter.self) private var toasts

    let serverDomain: String
    let displayName: String?
    let identityPubKeyHex: String
    let revoked: Bool
    /// Transfer needs the box (disk-key hand-off), so only a loaded page offers it.
    var canTransfer: Bool = false
    /// Pop back to Home after a delete: this page now points at nothing.
    var onDeleted: () -> Void = {}

    @State private var showRevoke = false
    @State private var showDelete = false
    @State private var unrevokeVm: UnrevokeServerViewModel?

    private var name: String {
        displayName.flatMap { $0.isEmpty ? nil : $0 } ?? DeleteServerViewModel.serverLabel(forFqdn: serverDomain)
    }

    private var unrevoking: Bool {
        if case .working = unrevokeVm?.phase { return true }
        return false
    }

    var body: some View {
        let c = FSColors.scheme(scheme)
        let toastCenter = toasts
        let appState = app
        let fqdn = serverDomain
        VStack(alignment: .leading, spacing: FS.space.s3) {
            Text("DANGER ZONE")
                .font(.system(size: 12, weight: .semibold))
                .tracking(1)
                .foregroundColor(c.textMuted)
            FSCard {
                VStack(alignment: .leading, spacing: FS.space.s3) {
                    if canTransfer {
                        TransferButton(serverDomain: serverDomain)
                    }
                    if revoked {
                        FSPrimaryButton(unrevoking ? "Restoring…" : "Un-revoke server", block: true) {
                            Task { await unrevoke(toasts: toastCenter, app: appState) }
                        }
                        .disabled(unrevoking)
                        .accessibilityIdentifier("sd-unrevoke-server")
                    } else {
                        FSDangerButton("Revoke server (reversible)", block: true) {
                            showRevoke = true
                        }
                        .accessibilityIdentifier("sd-revoke-server")
                    }
                    FSDangerButton("Delete and wipe this server", block: true) {
                        showDelete = true
                    }
                    .accessibilityIdentifier("sd-delete-server")
                }
            }
        }
        .sheet(isPresented: $showRevoke) {
            RevokeServerSheet(
                serverDomain: fqdn,
                username: { appState.currentUser },
                server: server,
                onCompleted: { reason in
                    appState.setPodRevoked(
                        fqdn: fqdn,
                        revokedAt: Int64(Date().timeIntervalSince1970 * 1000),
                        reason: reason.rawValue
                    )
                    toastCenter.success("Server revoked. It can't connect or unlock until you un-revoke it.")
                },
                onFailed: { msg in toastCenter.error("Revoke failed: \(msg)") }
            )
        }
        .sheet(isPresented: $showDelete) {
            DeleteServerSheet(
                serverDomain: fqdn,
                displayName: name,
                identityPubKeyHex: identityPubKeyHex,
                onCompleted: { message in
                    toastCenter.success(message)
                    onDeleted()
                }
            )
        }
    }

    @MainActor
    private func unrevoke(toasts: ToastCenter, app: AppState) async {
        guard !unrevoking else { return }
        let vm = UnrevokeServerViewModel(
            server: server,
            serverDomain: serverDomain,
            username: { app.currentUser }
        )
        unrevokeVm = vm
        await vm.run()
        switch vm.phase {
        case .completed:
            app.setPodRevoked(fqdn: serverDomain, revokedAt: nil, reason: nil)
            toasts.success(UnrevokeServerViewModel.completedMessage)
        case .failed(let msg):
            toasts.error(msg)
        default:
            break
        }
    }
}

/// Revoke sheet: reason picker + hold-to-confirm primary (1.5s long-press,
/// per docs/revocation-ui.md). The visible button label tracks press
/// progress so the user gets a clear "Hold to confirm" affordance.
struct RevokeServerSheet: View {
    @Environment(\.colorScheme) private var scheme
    @Environment(\.dismiss) private var dismiss

    let serverDomain: String
    let username: () -> String?
    let server: any FlagshipServerClient
    let onCompleted: (RevokeServerViewModel.Reason) -> Void
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
                Text("Locks \(serverDomain) out right away: it can't connect or unlock until you un-revoke it. Its name stays reserved. Use this if the box is lost or stolen. Other servers on your account keep running.")
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
                // to confirm. A short tap does nothing.
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
        let picked = reason
        await m.run(reason: picked)
        switch m.phase {
        case .completed:
            onCompleted(picked)
            dismiss()
        case .failed(let msg):
            onFailed(msg)
        default:
            break
        }
    }
}

/// Delete confirmation: the owner types the server's name to arm the button,
/// then one biometric covers the erase order and the name release.
struct DeleteServerSheet: View {
    @Environment(\.colorScheme) private var scheme
    @Environment(\.dismiss) private var dismiss
    @Environment(\.flagshipServerClient) private var server
    @Environment(\.secretMailboxClient) private var mailbox
    @Environment(AppState.self) private var app

    let serverDomain: String
    let displayName: String
    let identityPubKeyHex: String
    /// Fired once after a successful delete with the toast copy.
    let onCompleted: (String) -> Void

    @State private var typed = ""
    @State private var vm: DeleteServerViewModel?

    private var label: String { DeleteServerViewModel.serverLabel(forFqdn: serverDomain) }
    private var armed: Bool { DeleteServerViewModel.confirmationMatches(typed, serverLabel: label) }
    private var working: Bool {
        if case .working = vm?.phase { return true }
        return false
    }

    var body: some View {
        let c = FSColors.scheme(scheme)
        NavigationStack {
            VStack(alignment: .leading, spacing: FS.space.s4) {
                Text("Delete \(displayName)?")
                    .font(.system(size: 22, weight: .semibold))
                    .foregroundColor(c.text)
                Text("Deletes \(displayName) for good. If the box is online it erases its data and powers off; if it's offline it can never come back online. The name becomes free to reuse.")
                    .font(FS.font.body())
                    .foregroundColor(c.textMuted)
                    .fixedSize(horizontal: false, vertical: true)
                FSField(value: $typed, label: "Type \(label) to confirm", placeholder: label)
                    .accessibilityIdentifier("delete-server-name-field")
                Spacer()
                if let vm, case .failed(let msg) = vm.phase {
                    Text(msg).font(FS.font.caption()).foregroundColor(c.danger)
                }
                FSDangerButton(working ? "Deleting…" : "Delete server", muted: !armed, block: true, large: true) {
                    Task { await fire() }
                }
                .disabled(!armed || working)
                .accessibilityIdentifier("delete-server-confirm")
                FSGhostButton("Cancel", block: true) { dismiss() }
                    .disabled(working)
                    .padding(.bottom, FS.space.s2)
            }
            .padding(FS.space.s4)
        }
        .interactiveDismissDisabled(working)
    }

    @MainActor
    private func fire() async {
        guard armed, !working else { return }
        let appState = app
        let podId = PodInfo.podId(forFqdn: serverDomain)
        let m = vm ?? DeleteServerViewModel(
            server: server,
            mailbox: mailbox,
            serverFqdn: serverDomain,
            identityPubKeyHex: identityPubKeyHex,
            username: { appState.currentUser },
            onDeleted: {
                if let user = appState.currentUser {
                    PendingServerStore().remove(username: user, podId: podId)
                }
                appState.removePod(podId)
            }
        )
        vm = m
        let done = onCompleted
        let name = displayName
        await m.run(typedName: typed)
        if case .completed(let erase) = m.phase {
            dismiss()
            done(DeleteServerViewModel.completionMessage(name: name, eraseRequested: erase))
        }
    }
}
