import SwiftUI
import FlagshipAPI
import FlagshipCore

/// Settings tab. Sections:
///   - ACCOUNT — username
///   - SUBSCRIPTION — tier, credits, bandwidth, manage providers
///   - BROWSER SESSIONS — computers you've docked a browser from to
///                        manage this account (temporary, NOT pods).
///                        Hidden entirely when none are active.
///   - RECOVERY + ABOUT — recovery setup, version/license
///   - Sign out
///
/// The server list intentionally lives only on Home — having it here
/// too was redundant.
public struct SettingsScreen: View {
    @Environment(\.colorScheme) private var scheme
    /// iPad/regular: sidebar already names the destination → inline title.
    /// iPhone keeps the large collapsing title.
    @Environment(\.horizontalSizeClass) private var sizeClass
    @State private var disconnectTarget: TrustedDevice?
    @State private var disconnectMessage: String?
    /// Drives the v1 "Wipe & restart — coming soon" info sheet. The
    /// menu entry stays visible (rather than hidden) so users
    /// understand the option exists and is being designed; tapping
    /// it opens an explainer instead of running the ceremony.
    @State private var showWipeComingSoon = false
    /// B6a — confirmation modal for "Remove this device from account."
    /// Two-stage UX: tap fires this state, sheet shows; sheet's primary
    /// button calls onRemoveFromAccount. Sheet copy adapts based on
    /// whether the user has cloud recovery enrolled.
    @State private var showRemoveConfirm = false
    /// B7 — drives the Replace device confirmation sheet. nil → not
    /// asking; non-nil → ask the user to confirm rotating the IRK.
    /// The container observes this and routes the action through
    /// ReplaceDeviceViewModel.
    @State private var replaceConfirm: Bool = false
    /// E3 — drives the Wipe & restart confirmation dialog.
    @State private var wipeConfirm: Bool = false
    /// Tier 2 — drives the key-wipe Sign-out confirmation dialog. Copy +
    /// severity adapt on `hasCloudRecovery` (a wipe without recovery is
    /// permanent account loss, so it gets the danger-zone framing).
    @State private var signOutConfirm: Bool = false
    let username: String
    let tier: LoadingState<TierStatusResponse>
    let controlDevices: LoadingState<[PairedSessionSummary]>
    /// Peer-class devices on this user's account (push-token holders).
    /// The new "Trusted devices" section. Empty list renders an
    /// explainer; .failed renders an error card.
    let trustedDevices: LoadingState<[TrustedDevice]>
    var onDisconnectTrustedDevice: (TrustedDevice) async -> Bool = { _ in false }
    let showDeveloper: Bool
    /// v1.2 Phase 4 — "Multi-device + 2FA" badge state read out of the
    /// Worker `usernames` row. Nil while the load is in flight or if
    /// the call failed; "single" / "multi" otherwise.
    var accountType: String? = nil
    /// Phase 3b — admin opens the "Add a device" cross-device QR pairing
    /// (Settings → Trusted devices → Add a device).
    var onAddDevice: () -> Void = {}
    /// Phase 3b — open the in-app pairing-code scanner to JOIN another
    /// account on this device (the incoming/collaborator side).
    var onScanPairingCode: () -> Void = {}
    var onRevokeDevice: (PairedSessionSummary) -> Void = { _ in }
    /// Tier 1 — LOCK. Re-gate the app behind Face ID without removing
    /// anything (no network, key + session stay in the Keychain).
    var onLock: () -> Void = {}
    /// Tier 2 — SIGN OUT. Wipe this device's local key material from the
    /// Keychain (snoop-hardening) WITHOUT revoking server-side. Only
    /// safe when cloud recovery is enrolled; the screen gates on that.
    var onSignOut: () -> Void = {}
    var onOpenProviders: () -> Void = {}
    /// P7 — open the dedicated tier-status / subscription screen.
    var onOpenSubscription: () -> Void = {}
    var onOpenRecovery: () -> Void = {}
    /// Open "Back up your account key" — the `.flagshipkey` export.
    var onOpenKeyfileBackup: () -> Void = {}
    /// v1.2 Phase 4 — open the Account-security drill-down. The
    /// container hosts AccountSecurityScreen + drives the enable /
    /// disable flows.
    var onOpenAccountSecurity: () -> Void = {}
    /// W3 — open the Profiles picker (multi-cloud).
    var onOpenProfiles: () -> Void = {}
    /// P9 — open the peer-backup management screen.
    var onOpenPeerBackup: () -> Void = {}
    /// P14 — open the "Dock a browser" companion-pairing screen.
    var onOpenCompanionDock: () -> Void = {}
    /// P14 Phase 2 — open the Companion-requests inbox. The badge count
    /// next to the row reflects `pendingCompanionWritesCount`.
    var onOpenCompanionRequests: () -> Void = {}
    /// P14 Phase 2 — count of pending companion-forwarded writes. Drives
    /// the badge on the Companion-requests nav row.
    var pendingCompanionWritesCount: Int = 0
    var onOpenAbout: () -> Void = {}
    var onOpenDeveloper: () -> Void = {}
    var onOpenPrivacy: () -> Void = {}
    var onRefresh: () async -> Void = {}
    /// B6a — fired after the user confirms in the Remove sheet. The
    /// container is expected to: revoke this device's push token on
    /// .com, wipe local Keystore, and call AppState.signOut so the
    /// user drops back to Welcome.
    var onRemoveFromAccount: () async -> Void = {}
    /// B7 — fired after the user confirms the Replace device scare
    /// sheet. The container drives ReplaceDeviceViewModel.initiate
    /// with the captured devices ETag.
    var onReplaceDevice: () async -> Void = {}
    /// E2/E3 — fired after the user confirms the Wipe scare sheet.
    /// The container runs WipeRestartViewModel.run.
    var onWipeRestart: () async -> Void = {}
    /// Whether the user has cloud recovery enrolled — read by the
    /// Remove confirmation sheet to surface a STRONGER warning when
    /// not enrolled (no enrolment = removing this device permanently
    /// loses account access).
    var hasCloudRecovery: Bool = true
    /// #52 — the Tier-2 sign-out gate, computed by the container
    /// (SettingsTab) via SignOutPolicy.evaluate so the demo exemption
    /// lives in ONE place. `.blockedNoRecovery` replaces the destructive
    /// confirm with an explainer + a route into recovery enrollment.
    var signOutPolicy: SignOutPolicy = .allowed

    public init(
        username: String,
        tier: LoadingState<TierStatusResponse>,
        controlDevices: LoadingState<[PairedSessionSummary]>,
        trustedDevices: LoadingState<[TrustedDevice]> = .loaded([]),
        showDeveloper: Bool = false,
        accountType: String? = nil,
        onAddDevice: @escaping () -> Void = {},
        onScanPairingCode: @escaping () -> Void = {},
        onRevokeDevice: @escaping (PairedSessionSummary) -> Void = { _ in },
        onDisconnectTrustedDevice: @escaping (TrustedDevice) async -> Bool = { _ in false },
        onLock: @escaping () -> Void = {},
        onSignOut: @escaping () -> Void = {},
        onOpenProviders: @escaping () -> Void = {},
        onOpenSubscription: @escaping () -> Void = {},
        onOpenRecovery: @escaping () -> Void = {},
        onOpenKeyfileBackup: @escaping () -> Void = {},
        onOpenAccountSecurity: @escaping () -> Void = {},
        onOpenProfiles: @escaping () -> Void = {},
        onOpenPeerBackup: @escaping () -> Void = {},
        onOpenCompanionDock: @escaping () -> Void = {},
        onOpenCompanionRequests: @escaping () -> Void = {},
        pendingCompanionWritesCount: Int = 0,
        onOpenAbout: @escaping () -> Void = {},
        onOpenDeveloper: @escaping () -> Void = {},
        onOpenPrivacy: @escaping () -> Void = {},
        onRefresh: @escaping () async -> Void = {},
        onRemoveFromAccount: @escaping () async -> Void = {},
        onReplaceDevice: @escaping () async -> Void = {},
        onWipeRestart: @escaping () async -> Void = {},
        hasCloudRecovery: Bool = true,
        signOutPolicy: SignOutPolicy = .allowed
    ) {
        self.username = username
        self.tier = tier
        self.controlDevices = controlDevices
        self.trustedDevices = trustedDevices
        self.onDisconnectTrustedDevice = onDisconnectTrustedDevice
        self.showDeveloper = showDeveloper
        self.accountType = accountType
        self.onAddDevice = onAddDevice
        self.onScanPairingCode = onScanPairingCode
        self.onRevokeDevice = onRevokeDevice
        self.onLock = onLock
        self.onSignOut = onSignOut
        self.onOpenProviders = onOpenProviders
        self.onOpenSubscription = onOpenSubscription
        self.onOpenRecovery = onOpenRecovery
        self.onOpenKeyfileBackup = onOpenKeyfileBackup
        self.onOpenAccountSecurity = onOpenAccountSecurity
        self.onOpenProfiles = onOpenProfiles
        self.onOpenPeerBackup = onOpenPeerBackup
        self.onOpenCompanionDock = onOpenCompanionDock
        self.onOpenCompanionRequests = onOpenCompanionRequests
        self.pendingCompanionWritesCount = pendingCompanionWritesCount
        self.onOpenAbout = onOpenAbout
        self.onOpenDeveloper = onOpenDeveloper
        self.onOpenPrivacy = onOpenPrivacy
        self.onRefresh = onRefresh
        self.onRemoveFromAccount = onRemoveFromAccount
        self.onReplaceDevice = onReplaceDevice
        self.onWipeRestart = onWipeRestart
        self.hasCloudRecovery = hasCloudRecovery
        self.signOutPolicy = signOutPolicy
    }

    /// Optional promo announcement at the top of Settings. Wired but empty by
    /// default — the container can flip it on for a campaign without touching
    /// the screen. Kept as state so a future "dismiss" is a one-liner.
    @State private var showPromo: Bool = false

    public var body: some View {
        let c = FSColors.scheme(scheme)
        ScrollView {
            VStack(alignment: .leading, spacing: FS.space.s6) {
                // Account hero — teal monogram + username + account-type
                // subtitle. Drills into Account security (the most relevant
                // account-level destination).
                FSProfileCard(
                    name: username,
                    subtitle: profileSubtitle,
                    action: onOpenAccountSecurity
                )
                .padding(.top, FS.space.s2)

                // Optional promo slot (empty unless flipped on).
                if showPromo {
                    FSAnnouncementCard(
                        icon: "sparkles",
                        title: "Welcome to Flagship",
                        message: "Your stuff, on your hardware, with a real green padlock.",
                        onDismiss: { showPromo = false }
                    )
                }

                // v1.2 Phase 4 — account-security badge + entry. Placed
                // immediately after Account so the "Single-device" /
                // "Multi-device + 2FA" state is one of the first
                // things the user sees.
                accountSecuritySection(c: c)
                subscription(c: c)
                trustedDevicesSection(c: c)
                browserSessionsSection(c: c)
                links(c: c)
                sessionActions(c: c)
                dangerZone(c: c)
                about(c: c)

                Spacer().frame(height: FS.space.s12)
            }
            .padding(.horizontal, FS.space.s6)
            .fsReadingColumn()
            // Hard-pin the scroll content to the ScrollView's own width. A
            // vertical ScrollView rubber-bands sideways the moment ANY
            // descendant reports a width past the viewport (an over-wide row,
            // a long unbreakable value, a fixed-size child). containerRelative-
            // Frame clamps the content to the container width exactly, so there
            // is simply no horizontal scroll range left to drag — independent
            // of which child would otherwise overflow.
            .containerRelativeFrame(.horizontal)
        }
        .scrollBounceBehavior(.basedOnSize, axes: .horizontal)
        .background(c.bg.ignoresSafeArea())
        .navigationTitle("Settings")
        .navigationBarTitleDisplayMode(sizeClass == .regular ? .inline : .large)
        .refreshable { await onRefresh() }
        .confirmationDialog(
            disconnectTarget.map { "Disconnect \($0.label)?" } ?? "Disconnect device?",
            isPresented: Binding(
                get: { disconnectTarget != nil },
                set: { if !$0 { disconnectTarget = nil } }
            ),
            titleVisibility: .visible,
            presenting: disconnectTarget
        ) { target in
            Button("Disconnect \(target.label)", role: .destructive) {
                Task {
                    let success = await onDisconnectTrustedDevice(target)
                    if !success {
                        disconnectMessage = "Couldn't disconnect — check your connection and try again."
                    }
                    disconnectTarget = nil
                }
            }
            Button("Cancel", role: .cancel) { disconnectTarget = nil }
        } message: { target in
            Text("We'll stop sending alerts to \(target.label). It can sign back in with your passkey.")
        }
        .alert(
            "Disconnect failed",
            isPresented: Binding(
                get: { disconnectMessage != nil },
                set: { if !$0 { disconnectMessage = nil } }
            )
        ) {
            Button("OK") { disconnectMessage = nil }
        } message: {
            Text(disconnectMessage ?? "")
        }
        .sheet(isPresented: $showWipeComingSoon) {
            WipeComingSoonSheet { showWipeComingSoon = false }
        }
        .confirmationDialog(
            "Replace this device?",
            isPresented: $replaceConfirm,
            titleVisibility: .visible,
        ) {
            Button("Replace device", role: .destructive) {
                Task { await onReplaceDevice() }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Rotates your account's identity key. Other devices on this account will need to re-pair the next time they open the app — including this phone. Pods stay running, apps stay installed. The change takes effect after a 24-hour grace window during which another device can object.")
        }
        .confirmationDialog(
            "Wipe and start over?",
            isPresented: $wipeConfirm,
            titleVisibility: .visible,
        ) {
            Button("Wipe and start over", role: .destructive) {
                Task { await onWipeRestart() }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Your account keeps the same username and your pods keep their data. Every device currently on this account will be disconnected — including this phone, which becomes the new root of trust. You'll re-pair each one fresh.\n\nThis can't be undone from another device.")
        }
        .confirmationDialog(
            signOutPolicy == .blockedNoRecovery
                ? "Set up recovery first"
                : "Sign out of this device?",
            isPresented: $signOutConfirm,
            titleVisibility: .visible
        ) {
            // #52 — without cloud recovery a key-wipe sign-out is permanent
            // account loss, so there is NO destructive proceed at all: the
            // only forward action routes into recovery enrollment. With
            // recovery enrolled (or in demo mode) it's a routine confirm —
            // the same IRK comes back via passkey.
            if signOutPolicy == .blockedNoRecovery {
                Button("Set up recovery") {
                    onOpenRecovery()
                }
                Button("Cancel", role: .cancel) {}
            } else {
                Button("Sign out", role: .destructive) {
                    onSignOut()
                }
                Button("Cancel", role: .cancel) {}
            }
        } message: {
            Text(signOutPolicy == .blockedNoRecovery
                ? "Enroll cloud recovery first — signing out now would permanently lose access to this account. This device holds the only copy of your account key."
                : "This erases this device's account key from the Keychain so nothing sensitive is left at rest while you're signed out. Your account and your servers are untouched — sign back in with your recovery passkey and the same key is restored, no re-pair.")
        }
    }

    /// Account-type one-liner under the username on the profile hero.
    private var profileSubtitle: String {
        switch accountType {
        case "multi":  return "Multi-device + 2FA"
        case "single": return "Single-device account"
        default:       return "Tap to manage account security"
        }
    }

    private func subscription(c: FSColors) -> some View {
        FSSettingsGroup("SUBSCRIPTION", rows: [
            FSSettingsRow(
                icon: "creditcard.fill",
                title: "Tier & usage",
                subtitle: subscriptionSubtitle,
                action: onOpenSubscription
            )
        ])
        .accessibilityIdentifier("settings-open-subscription")
    }

    private var subscriptionSubtitle: String {
        switch tier {
        case .loaded(let t):
            switch t.tier {
            case "byok":  return "Bring-your-own-key • credits, usage, domains"
            case "promo": return "Free credits • credits, usage, domains"
            default:      return "Free • credits, usage, domains"
            }
        case .failed:
            return "Credits, usage, custom domains, reserved names"
        default:
            return "Loading…"
        }
    }

    /// v1.2 Phase 4 — Account-security entry. Badge surfaces the
    /// current account type ("Single-device" / "Multi-device + 2FA");
    /// the row drills into AccountSecurityScreen for enroll / disable.
    private func accountSecuritySection(c: FSColors) -> some View {
        FSSettingsGroup("ACCOUNT SECURITY", rows: [
            FSSettingsRow(
                icon: accountType == "multi" ? "checkmark.shield.fill" : "shield.lefthalf.filled",
                iconTint: accountType == "multi" ? c.success : c.primary,
                title: accountType == "multi" ? "Multi-device + 2FA" : "Single-device account",
                subtitle: accountType == "multi"
                    ? "Recovery requires a 6-digit code + 24-hour grace."
                    : "Recovery is a 7-day waiting period.",
                action: onOpenAccountSecurity
            )
        ])
        .accessibilityIdentifier("settings-open-account-security")
    }

    private func trustedDevicesSection(c: FSColors) -> some View {
        section("TRUSTED DEVICES", c: c) {
            VStack(alignment: .leading, spacing: FS.space.s2) {
                Text("Phones and tablets that hold your account keys.")
                    .font(FS.font.caption()).foregroundColor(c.textMuted)
                switch trustedDevices {
                case .idle, .loading:
                    ServerCardSkeleton()
                case .failed(let msg):
                    ErrorCard(message: msg)
                case .loaded(let devices):
                    if devices.isEmpty {
                        FSCard {
                            HStack(alignment: .top, spacing: FS.space.s2) {
                                Image(systemName: "iphone").foregroundColor(c.textMuted)
                                VStack(alignment: .leading, spacing: 4) {
                                    Text("Just this device").font(FS.font.bodySm()).foregroundColor(c.text)
                                    Text("Sign in on another phone or tablet to add a trusted device.")
                                        .font(FS.font.caption()).foregroundColor(c.textMuted)
                                }
                            }
                        }
                    } else {
                        VStack(spacing: FS.space.s3) {
                            ForEach(devices) { d in
                                trustedDeviceRow(d, c: c)
                            }
                        }
                    }
                }
                // Phase 3b — cross-device pairing entries.
                VStack(spacing: FS.space.s2) {
                    Button(action: onAddDevice) {
                        HStack(spacing: FS.space.s2) {
                            Image(systemName: "plus.viewfinder")
                            Text("Add a device").font(FS.font.bodySm())
                            Spacer()
                            Image(systemName: "chevron.right").imageScale(.small).foregroundColor(c.textMuted)
                        }
                        .foregroundColor(c.primary)
                        .padding(FS.space.s3)
                        .frame(maxWidth: .infinity)
                        .background(c.surface)
                        .clipShape(RoundedRectangle(cornerRadius: FS.radius.md))
                    }
                    .accessibilityIdentifier("settings-add-device")
                    Button(action: onScanPairingCode) {
                        HStack(spacing: FS.space.s2) {
                            Image(systemName: "qrcode.viewfinder")
                            Text("Scan a pairing code").font(FS.font.bodySm())
                            Spacer()
                            Image(systemName: "chevron.right").imageScale(.small).foregroundColor(c.textMuted)
                        }
                        .foregroundColor(c.text)
                        .padding(FS.space.s3)
                        .frame(maxWidth: .infinity)
                        .background(c.surface)
                        .clipShape(RoundedRectangle(cornerRadius: FS.radius.md))
                    }
                    .accessibilityIdentifier("settings-scan-pairing-code")
                }
                .padding(.top, FS.space.s2)
            }
        }
    }

    /// One row per peer device. Carries the Disconnect / Replace
    /// (B7) actions via a contextual Menu on iOS — feels native
    /// versus a button stack and keeps the row visually clean.
    ///
    /// v1.2 Phase 4 — when the row is quarantined (the 14-day
    /// freshly-admitted window), surface a clock icon + tooltip and
    /// disable the destructive menu entries. Tapping a disabled
    /// entry surfaces a toast explaining why.
    private func trustedDeviceRow(_ d: TrustedDevice, c: FSColors) -> some View {
        let quarantined = d.isQuarantined()
        return FSCard {
            HStack(alignment: .top, spacing: FS.space.s3) {
                Image(systemName: platformIcon(d.platform))
                    .foregroundColor(c.primary)
                    .imageScale(.large)
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 6) {
                        Text(d.label)
                            .font(.system(size: 15, weight: .semibold))
                            .foregroundColor(c.text)
                            .lineLimit(1)
                            .truncationMode(.tail)
                        if quarantined {
                            Image(systemName: "clock.badge.exclamationmark")
                                .foregroundColor(c.danger)
                                .imageScale(.small)
                                .accessibilityIdentifier("trusted-device-quarantine-icon-\(d.tokenPrefix)")
                                .help(quarantineTooltip(for: d))
                        }
                    }
                    HStack(spacing: 4) {
                        Text(platformDisplay(d.platform))
                        Text("·").foregroundColor(c.textMuted)
                        Text("added \(relative(ms: d.addedAt))")
                    }
                    .font(FS.font.caption()).foregroundColor(c.textMuted)
                    if quarantined {
                        Text(quarantineTooltip(for: d))
                            .font(FS.font.caption())
                            .foregroundColor(c.danger)
                            .accessibilityIdentifier("trusted-device-quarantine-msg-\(d.tokenPrefix)")
                    } else if d.lastSeenAt > d.addedAt {
                        Text("last seen \(relative(ms: d.lastSeenAt))")
                            .font(FS.font.caption()).foregroundColor(c.textMuted)
                    }
                }
                Spacer()
                Menu {
                    Button(role: .destructive) {
                        if quarantined {
                            disconnectMessage = quarantineTooltip(for: d)
                        } else {
                            disconnectTarget = d
                        }
                    } label: {
                        Label("Disconnect", systemImage: "wifi.slash")
                    }
                    .disabled(quarantined)
                    // B7 — Replace device. Tap opens a two-stage scare
                    // sheet; the container drives the actual IRK
                    // rotation ceremony through ReplaceDeviceViewModel.
                    Button(role: .destructive) {
                        if quarantined {
                            disconnectMessage = quarantineTooltip(for: d)
                        } else {
                            replaceConfirm = true
                        }
                    } label: {
                        Label("Replace device", systemImage: "arrow.triangle.2.circlepath")
                    }
                    .disabled(quarantined)
                    Divider()
                    // E2/E3 — Wipe & restart. Live ceremony. The
                    // container observes onWipeRestart and routes
                    // through WipeRestartViewModel.
                    Button(role: .destructive) {
                        if quarantined {
                            disconnectMessage = quarantineTooltip(for: d)
                        } else {
                            wipeConfirm = true
                        }
                    } label: {
                        Label("Wipe & restart…", systemImage: "trash")
                    }
                    .disabled(quarantined)
                } label: {
                    Image(systemName: "ellipsis.circle")
                        .foregroundColor(c.textMuted)
                        .imageScale(.large)
                }
                .accessibilityIdentifier("trusted-device-menu-\(d.tokenPrefix)")
            }
        }
    }

    /// Tooltip + toast copy for a quarantined device. Surfaced both
    /// next to the clock icon AND on a disabled-menu tap. Kept
    /// here (not inline) so the test asserts on the exact string.
    private func quarantineTooltip(for d: TrustedDevice) -> String {
        guard let until = d.quarantineUntil else {
            return "This device is in quarantine. Use another device."
        }
        let f = DateFormatter()
        f.dateStyle = .medium
        f.timeStyle = .none
        let when = f.string(from: Date(timeIntervalSince1970: TimeInterval(until) / 1000))
        return "Quarantined until \(when). Use another device."
    }

    private func platformIcon(_ raw: String) -> String {
        switch raw {
        case "apns":    return "iphone"
        case "fcm":     return "antenna.radiowaves.left.and.right"
        case "webpush": return "globe"
        default:        return "questionmark.circle"
        }
    }

    private func platformDisplay(_ raw: String) -> String {
        switch raw {
        case "apns":    return "iPhone / iPad"
        case "fcm":     return "Android"
        case "webpush": return "Web"
        default:        return raw
        }
    }

    /// Docked-browser sessions — distinct from Trusted devices (which
    /// hold your account keys). These are temporary desktop companions
    /// created via "Dock a browser". The section is HIDDEN unless at
    /// least one session is active, so a normal single-phone account
    /// never sees a second, duplicate-looking device list. When present,
    /// each row carries the Revoke action — the only place to end a
    /// docked session.
    @ViewBuilder
    private func browserSessionsSection(c: FSColors) -> some View {
        if case .loaded(let sessions) = controlDevices, !sessions.isEmpty {
            section("BROWSER SESSIONS", c: c) {
                VStack(alignment: .leading, spacing: FS.space.s2) {
                    Text("Computers you've docked a browser from. They can manage this account for a few hours, then expire.")
                        .font(FS.font.caption()).foregroundColor(c.textMuted)
                    VStack(spacing: FS.space.s3) {
                        ForEach(sessions, id: \.tokenPrefix) { s in
                            browserSessionRow(s, c: c)
                        }
                    }
                }
            }
        }
    }

    private func browserSessionRow(_ s: PairedSessionSummary, c: FSColors) -> some View {
        FSCard {
            HStack {
                Image(systemName: s.current ? "iphone.gen3" : "laptopcomputer")
                    .foregroundColor(s.current ? c.success : c.textMuted)
                VStack(alignment: .leading, spacing: 2) {
                    Text(s.label).foregroundColor(c.text)
                    Text("paired \(relative(ms: s.addedAt))")
                        .font(FS.font.caption()).foregroundColor(c.textMuted)
                }
                Spacer()
                if s.current {
                    FSPill("This device", kind: .online)
                } else {
                    Button("Revoke") { onRevokeDevice(s) }
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundColor(c.danger)
                }
            }
        }
    }

    private func links(c: FSColors) -> some View {
        var rows: [FSSettingsRow] = [
            FSSettingsRow(icon: "key.horizontal.fill", title: "Recovery setup", subtitle: "Recover on a new device", action: onOpenRecovery),
            FSSettingsRow(icon: "doc.badge.arrow.up.fill", title: "Back up your account key", subtitle: "Save an encrypted key file", action: onOpenKeyfileBackup),
            FSSettingsRow(icon: "person.2.circle.fill", title: "Profiles", subtitle: "Switch between your clouds", action: onOpenProfiles),
            FSSettingsRow(icon: "laptopcomputer", title: "Dock a browser", subtitle: "Read-only desktop companion (4h)", action: onOpenCompanionDock),
            FSSettingsRow(
                icon: "tray.full",
                title: "Companion requests",
                subtitle: companionRequestsSubtitle,
                badge: pendingCompanionWritesCount > 0 ? pendingCompanionWritesCount : nil,
                action: onOpenCompanionRequests
            ),
            FSSettingsRow(icon: "externaldrive.connected.to.line.below.fill", title: "Peer-backup", subtitle: "Shard health across peers", action: onOpenPeerBackup),
            FSSettingsRow(icon: "lock.shield.fill", title: "Privacy", subtitle: "Face ID lock, app-level gating", action: onOpenPrivacy),
            FSSettingsRow(icon: "info.circle.fill", title: "About Flagship", subtitle: "Version, license, source", action: onOpenAbout),
        ]
        if showDeveloper {
            rows.append(FSSettingsRow(icon: "hammer.fill", title: "Developer", subtitle: "Mock/live toggle, latency knob", action: onOpenDeveloper))
        }
        return FSSettingsGroup("RECOVERY", rows: rows)
    }

    /// The three-tier "leave the app" cluster, ordered by increasing
    /// severity. Tier 3 (Remove this device) lives in the danger zone
    /// just below.
    ///
    ///   - LOCK (tier 1): re-gate behind Face ID. Removes NOTHING — no
    ///     network, the key + session stay in the Keychain. Cheapest;
    ///     re-entry is Face ID via the lock screen.
    ///   - SIGN OUT (tier 2): erase this device's local key material from
    ///     the Keychain WITHOUT revoking server-side. The device stays a
    ///     valid account member; this just hardens against an at-rest /
    ///     memory snoop while signed out. Re-entry is a passkey recovery
    ///     that restores the SAME key (instant re-pair, no rotation).
    ///     Gated on cloud recovery — see the confirmation dialog.
    private func sessionActions(c: FSColors) -> some View {
        VStack(spacing: FS.space.s3) {
            VStack(alignment: .leading, spacing: FS.space.s2) {
                Text("Locks Flagship behind Face ID. Nothing is removed and your apps keep running — just hides the screen until you unlock.")
                    .font(FS.font.caption()).foregroundColor(c.textMuted)
                FSGhostButton("Lock", block: true, large: true, action: onLock)
                    .accessibilityIdentifier("settings-lock-btn")
            }
            VStack(alignment: .leading, spacing: FS.space.s2) {
                Text(signOutPolicy == .blockedNoRecovery
                    ? "Sign out is disabled until you set up cloud recovery — this device holds the only copy of your account key, and erasing it would permanently lose access."
                    : (hasCloudRecovery
                        ? "Erases this device's account key from the Keychain so nothing's left at rest while you're signed out. Sign back in with your recovery passkey to restore it — your account and servers stay put."
                        : "Erases this device's account key. ⚠️ You have NO cloud recovery — this would permanently lose access."))
                    .font(FS.font.caption()).foregroundColor(c.textMuted)
                FSDangerButton("Sign out", block: true, large: true) {
                    signOutConfirm = true
                }
                .accessibilityIdentifier("settings-sign-out-btn")
            }
        }
        .padding(.top, FS.space.s4)
    }

    /// B6a — danger zone. Strictly destructive: revokes this device's
    /// push token on .com AND wipes local Keystore. The user must
    /// recover (or, if they have no cloud recovery, re-create the
    /// account from scratch) to come back. Two-stage confirm so a
    /// fat-finger doesn't blow up the user's setup.
    private func dangerZone(c: FSColors) -> some View {
        section("DANGER ZONE", c: c) {
            VStack(alignment: .leading, spacing: FS.space.s2) {
                Text(hasCloudRecovery
                    ? "Remove this device from your account. You'll need your recovery passkey to come back."
                    : "Remove this device from your account. ⚠️ You have NO cloud recovery enrolled — this will permanently lose access.")
                    .font(FS.font.caption()).foregroundColor(c.textMuted)
                FSDangerButton("Remove this device from account", block: true) {
                    showRemoveConfirm = true
                }
                .accessibilityIdentifier("remove-from-account-btn")
            }
        }
        .confirmationDialog(
            hasCloudRecovery
                ? "Remove this device from your account?"
                : "Permanently remove this device?",
            isPresented: $showRemoveConfirm,
            titleVisibility: .visible
        ) {
            Button("Remove this device", role: .destructive) {
                Task { await onRemoveFromAccount() }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text(hasCloudRecovery
                ? "We'll revoke this device's notification access and erase its local keys. Use your recovery passkey to sign in again later."
                : "You have no cloud recovery on this account. After removal, no other device can take over — your account is gone for good. Set up recovery first if you might want to come back.")
        }
    }

    private func about(c: FSColors) -> some View {
        Text("Flagship • BUSL-1.1 • Your stuff, on your hardware.")
            .font(FS.font.caption())
            .foregroundColor(c.textMuted)
            .frame(maxWidth: .infinity, alignment: .center)
            .padding(.top, FS.space.s4)
    }

    private var companionRequestsSubtitle: String {
        if pendingCompanionWritesCount == 0 { return "Approve writes from docked browsers" }
        if pendingCompanionWritesCount == 1 { return "1 pending write from a docked browser" }
        return "\(pendingCompanionWritesCount) pending writes from docked browsers"
    }

    @ViewBuilder
    private func section<C: View>(_ label: String, c: FSColors, @ViewBuilder content: () -> C) -> some View {
        VStack(alignment: .leading, spacing: FS.space.s3) {
            Text(label).font(.system(size: 12, weight: .semibold)).tracking(1).foregroundColor(c.textMuted)
            content()
        }
    }

    private func relative(ms: Int64) -> String {
        let date = Date(timeIntervalSince1970: TimeInterval(ms) / 1000)
        let fmt = RelativeDateTimeFormatter()
        fmt.unitsStyle = .abbreviated
        return fmt.localizedString(for: date, relativeTo: Date())
    }
}

/// "Coming soon" explainer for the v1 Wipe & restart entry. Visible
/// (rather than hidden) so users can see the v1.1 option exists and
/// is being designed. The actual ceremony lands as E2/E3 on iOS.
struct WipeComingSoonSheet: View {
    @Environment(\.colorScheme) private var scheme
    let onClose: () -> Void

    var body: some View {
        let c = FSColors.scheme(scheme)
        VStack(alignment: .leading, spacing: FS.space.s4) {
            HStack {
                Image(systemName: "trash.circle.fill")
                    .imageScale(.large)
                    .foregroundColor(c.danger)
                Text("Wipe & restart")
                    .font(.system(size: 22, weight: .semibold))
                    .foregroundColor(c.text)
                Spacer()
            }
            Text("Coming in v1.1.")
                .font(FS.font.bodySm())
                .foregroundColor(c.textMuted)
            Text("This rotates your account's identity and recovery passkey in one shot — every other device gets disconnected and you re-pair each one fresh. Pods stay running, apps stay installed.")
                .foregroundColor(c.text)
            Text("For v1 you can still Disconnect a single device, and Replace device will land alongside the Keystore-rotation primitives. The full Wipe ceremony needs the new-IRK + new-UMK + new-passkey generation paths exercised end-to-end before we ship it.")
                .font(FS.font.bodySm())
                .foregroundColor(c.textMuted)
            FSPrimaryButton("Got it", block: true, action: onClose)
        }
        .padding(FS.space.s6)
        .background(c.bg)
        .presentationDetents([.medium])
    }
}
