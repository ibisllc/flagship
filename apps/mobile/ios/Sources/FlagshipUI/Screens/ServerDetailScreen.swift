import SwiftUI
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
    var onOpenSessions: () -> Void = {}
    var onOpenTier: () -> Void = {}
    var onRefresh: () async -> Void = {}

    public init(
        state: LoadingState<ServerDetailResponse>,
        metrics: LoadingState<ServerMetricsResponse>,
        onOpenSessions: @escaping () -> Void = {},
        onOpenTier: @escaping () -> Void = {},
        onRefresh: @escaping () async -> Void = {}
    ) {
        self.state = state
        self.metrics = metrics
        self.onOpenSessions = onOpenSessions
        self.onOpenTier = onOpenTier
        self.onRefresh = onRefresh
    }

    public var body: some View {
        let c = FSColors.scheme(scheme)
        ScrollView {
            VStack(alignment: .leading, spacing: FS.space.s6) {
                switch state {
                case .idle, .loading:
                    ServerCardSkeleton()
                case .failed(let msg):
                    ErrorCard(message: msg)
                case .loaded(let d):
                    overview(d: d, c: c)
                    MetricsSection(state: metrics)
                    cert(d: d, c: c)
                    CertAutonomyCard(serverDomain: d.serverFqdn)
                    deviceRow(d: d, c: c)
                    BootUnlockCard(serverDomain: d.serverFqdn)
                    timeline(d: d, c: c)
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

/// #28 seal-to-box — per-server "Grant cert-minting autonomy" action.
///
/// By default a box stays "managed": it asks the admin device for a fresh
/// TLS cert each renewal. This card opts THIS box into autonomy — it seals
/// the account key to the box's STK and IRK-signs the grant so the box can
/// re-issue its own `[<user>, *.<user>]` cert offline indefinitely.
///
/// Self-contained, mirroring `BootUnlockCard` / `DangerZoneCard`: reads its
/// dependencies (the .com server client, the directory mailbox, the active
/// account, toasts) from the environment so the parent screen stays a dumb
/// state+callbacks view. The box STK is sourced from the pods directory
/// inside `CertAutonomyGrantViewModel` (the same trust anchor the unlock
/// coordinator uses) — `ServerDetailResponse` does NOT carry it.
struct CertAutonomyCard: View {
    @Environment(\.colorScheme) private var scheme
    @Environment(\.flagshipServerClient) private var server
    @Environment(\.secretMailboxClient) private var mailbox
    @Environment(AppState.self) private var app
    @Environment(ToastCenter.self) private var toasts

    let serverDomain: String

    @State private var vm: CertAutonomyGrantViewModel?
    @State private var confirming = false

    var body: some View {
        let c = FSColors.scheme(scheme)
        VStack(alignment: .leading, spacing: FS.space.s3) {
            Text("CERT AUTONOMY")
                .font(.system(size: 12, weight: .semibold))
                .tracking(1)
                .foregroundColor(c.textMuted)
            FSCard {
                VStack(alignment: .leading, spacing: FS.space.s2) {
                    Label("Box renews its own certificate", systemImage: "lock.rotation")
                        .font(FS.font.body())
                        .foregroundColor(c.text)
                    Text("Hand this box the authority to re-issue its own TLS certificate, so it keeps a valid padlock even when your phone is offline for a long stretch. The account key is sealed to this box alone — flagshipserver.com only relays ciphertext it can't read.")
                        .font(FS.font.caption())
                        .foregroundColor(c.textMuted)
                    FSPrimaryButton(buttonLabel, enabled: !isBusy, block: true) {
                        confirming = true
                    }
                    .accessibilityIdentifier("sd-grant-cert-autonomy")
                }
            }
        }
        .alert("Grant cert-minting autonomy?", isPresented: $confirming) {
            Button("Cancel", role: .cancel) {}
            Button("Grant") { Task { await fire() } }
        } message: {
            Text("This box will be able to mint your TLS certificate on its own, indefinitely. You can still revoke it later from the admin device.")
        }
    }

    private var isBusy: Bool {
        switch vm?.phase {
        case .resolving, .signing, .posting: return true
        default: return false
        }
    }

    private var buttonLabel: String {
        switch vm?.phase {
        case .resolving: return "Finding box…"
        case .signing:   return "Sealing key…"
        case .posting:   return "Granting…"
        default:         return "Grant cert-minting autonomy"
        }
    }

    @MainActor
    private func fire() async {
        let m = CertAutonomyGrantViewModel(
            server: server,
            mailbox: mailbox,
            serverDomain: serverDomain,
            username: { app.currentUser }
        )
        vm = m
        await m.grant()
        switch m.phase {
        case .completed:
            toasts.success("Done. This box can now renew its own certificate.")
        case .failed(let msg):
            toasts.error(msg)
        default:
            break
        }
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
