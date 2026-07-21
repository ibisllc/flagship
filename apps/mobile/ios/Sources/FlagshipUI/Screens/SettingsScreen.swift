import SwiftUI
import FlagshipAPI
import FlagshipCore

/// Settings tab, organised into the spec S1 six-group taxonomy:
///   - ACCOUNT — account security · AI keys · Recovery · Back up account key · Profiles
///   - DEVICES — trusted devices · browser sessions · companions (dock / requests)
///   - WEB ACCESS — open secured sessions · process URL
///   - BACKUP & PEERS — peer-backup
///   - APP — appearance · privacy · about
///   - DANGER ZONE — remove this device · delete account
///   - DEVELOPER — hidden behind the mock/live toggle
///
/// The server list intentionally lives only on Home — having it here
/// too was redundant.
public struct SettingsScreen: View {
    @Environment(\.colorScheme) private var scheme
    /// iPad/regular: sidebar already names the destination → inline title.
    /// iPhone keeps the large collapsing title.
    @Environment(\.horizontalSizeClass) private var sizeClass
    /// Appearance choice (Light / Dark / Auto) — read + written by the
    /// APPEARANCE segmented control; applied app-wide by RootShell.
    @Environment(PrivacySettings.self) private var privacy
    @State private var disconnectTarget: SettingsViewModel.DirectoryDevice?
    @State private var disconnectMessage: String?
    /// Browser-session revoke awaiting its confirm step. A revoke is
    /// destructive (the docked computer loses access), so it gates behind
    /// a grey Cancel / red Revoke dialog like every other destructive action.
    @State private var revokeSessionTarget: PairedSessionSummary?
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
    @State private var nameEditor: NameEditor?
    @State private var nameEditMessage: String?
    let username: String
    let accountDisplayName: String?
    let controlDevices: LoadingState<[PairedSessionSummary]>
    /// Peer-class devices on this user's account (push-token holders).
    /// The new "Trusted devices" section. Empty list renders an
    /// explainer; .failed renders an error card.
    let trustedDevices: LoadingState<[SettingsViewModel.DirectoryDevice]>
    /// M4 — the pending re-pair snapshot (GET /re-pair). When a row is
    /// present + un-objected, the Trusted-devices section shows a
    /// grace-gated "Replace pending" banner; a "Finalize now" tap routes
    /// into the existing finalize screen via `onFinalizeReplace`. Mirrors
    /// the webapp banner. nil → no banner.
    var pendingRePair: PendingRePairSnapshot? = nil
    var onDisconnectTrustedDevice: (SettingsViewModel.DirectoryDevice) async -> Bool = { _ in false }
    var canManageNames: Bool = false
    var onRenameAccount: (String) async -> Bool = { _ in false }
    var onRenameCurrentDevice: (String) async -> Bool = { _ in false }
    var onSetManagedDeviceName: (String, String, Bool) async -> Bool = { _, _, _ in false }
    var onRemoveManagedDeviceName: (String) async -> Bool = { _ in false }
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
    /// Open Settings → AI keys (device-local BYOK key manager).
    var onOpenAiKeys: () -> Void = {}
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
    /// Web-experience gating — open "Open secured sessions" (browser QR-login
    /// sessions this phone has authorized).
    var onOpenSecuredSessions: () -> Void = {}
    /// Web-experience gating — open "Process URL" (paste a `flagship://access`
    /// link / "Get link" string to authorize a site).
    var onOpenProcessUrl: () -> Void = {}
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
    /// M4 — fired when "Finalize now" on the pending-re-pair banner is
    /// tapped (the grace has elapsed). Carries the snapshot's
    /// `completesAt` so the container can push the finalize screen with
    /// the right deadline. Complements onReplaceDevice: this finishes a
    /// replace that may have been started on ANOTHER device.
    var onFinalizeReplace: (Int64) -> Void = { _ in }
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
    /// lives in ONE place. `.blockedNoRecovery` greys out the gated
    /// buttons ("Lock with passkey" + "Remove this device") and routes a
    /// tap to `onRecoveryRequired` instead of the destructive confirm.
    var signOutPolicy: SignOutPolicy = .allowed
    /// Fired when a recovery-gated button is tapped while still greyed
    /// (no cloud recovery enrolled). The container surfaces a toast —
    /// "Set up account recovery to use this." — rather than running the
    /// destructive path.
    var onRecoveryRequired: () -> Void = {}
    /// Fired when the action is account DEATH (`signOutPolicy ==
    /// .deletionCeremony` — no cloud recovery AND this is the last device).
    /// Both the tier-2 "Lock with passkey" and the danger-zone "Remove this
    /// device" confirm into the SAME ceremony: this routes the container to
    /// push the full-page irreversible warning (typed-username + biometric →
    /// owner-IRK self-delete bundle → local wipe → Welcome).
    var onDeleteAccount: () -> Void = {}

    public init(
        username: String,
        accountDisplayName: String? = nil,
        controlDevices: LoadingState<[PairedSessionSummary]>,
        trustedDevices: LoadingState<[SettingsViewModel.DirectoryDevice]> = .loaded([]),
        pendingRePair: PendingRePairSnapshot? = nil,
        showDeveloper: Bool = false,
        accountType: String? = nil,
        onAddDevice: @escaping () -> Void = {},
        onScanPairingCode: @escaping () -> Void = {},
        onRevokeDevice: @escaping (PairedSessionSummary) -> Void = { _ in },
        onDisconnectTrustedDevice: @escaping (SettingsViewModel.DirectoryDevice) async -> Bool = { _ in false },
        canManageNames: Bool = false,
        onRenameAccount: @escaping (String) async -> Bool = { _ in false },
        onRenameCurrentDevice: @escaping (String) async -> Bool = { _ in false },
        onSetManagedDeviceName: @escaping (String, String, Bool) async -> Bool = { _, _, _ in false },
        onRemoveManagedDeviceName: @escaping (String) async -> Bool = { _ in false },
        onLock: @escaping () -> Void = {},
        onSignOut: @escaping () -> Void = {},
        onOpenProviders: @escaping () -> Void = {},
        onOpenAiKeys: @escaping () -> Void = {},
        onOpenRecovery: @escaping () -> Void = {},
        onOpenKeyfileBackup: @escaping () -> Void = {},
        onOpenAccountSecurity: @escaping () -> Void = {},
        onOpenProfiles: @escaping () -> Void = {},
        onOpenPeerBackup: @escaping () -> Void = {},
        onOpenCompanionDock: @escaping () -> Void = {},
        onOpenSecuredSessions: @escaping () -> Void = {},
        onOpenProcessUrl: @escaping () -> Void = {},
        onOpenCompanionRequests: @escaping () -> Void = {},
        pendingCompanionWritesCount: Int = 0,
        onOpenAbout: @escaping () -> Void = {},
        onOpenDeveloper: @escaping () -> Void = {},
        onOpenPrivacy: @escaping () -> Void = {},
        onRefresh: @escaping () async -> Void = {},
        onRemoveFromAccount: @escaping () async -> Void = {},
        onReplaceDevice: @escaping () async -> Void = {},
        onFinalizeReplace: @escaping (Int64) -> Void = { _ in },
        onWipeRestart: @escaping () async -> Void = {},
        hasCloudRecovery: Bool = true,
        signOutPolicy: SignOutPolicy = .allowed,
        onRecoveryRequired: @escaping () -> Void = {},
        onDeleteAccount: @escaping () -> Void = {}
    ) {
        self.username = username
        self.accountDisplayName = accountDisplayName
        self.controlDevices = controlDevices
        self.trustedDevices = trustedDevices
        self.pendingRePair = pendingRePair
        self.onDisconnectTrustedDevice = onDisconnectTrustedDevice
        self.canManageNames = canManageNames
        self.onRenameAccount = onRenameAccount
        self.onRenameCurrentDevice = onRenameCurrentDevice
        self.onSetManagedDeviceName = onSetManagedDeviceName
        self.onRemoveManagedDeviceName = onRemoveManagedDeviceName
        self.showDeveloper = showDeveloper
        self.accountType = accountType
        self.onAddDevice = onAddDevice
        self.onScanPairingCode = onScanPairingCode
        self.onRevokeDevice = onRevokeDevice
        self.onLock = onLock
        self.onSignOut = onSignOut
        self.onOpenProviders = onOpenProviders
        self.onOpenAiKeys = onOpenAiKeys
        self.onOpenRecovery = onOpenRecovery
        self.onOpenKeyfileBackup = onOpenKeyfileBackup
        self.onOpenAccountSecurity = onOpenAccountSecurity
        self.onOpenProfiles = onOpenProfiles
        self.onOpenPeerBackup = onOpenPeerBackup
        self.onOpenCompanionDock = onOpenCompanionDock
        self.onOpenSecuredSessions = onOpenSecuredSessions
        self.onOpenProcessUrl = onOpenProcessUrl
        self.onOpenCompanionRequests = onOpenCompanionRequests
        self.pendingCompanionWritesCount = pendingCompanionWritesCount
        self.onOpenAbout = onOpenAbout
        self.onOpenDeveloper = onOpenDeveloper
        self.onOpenPrivacy = onOpenPrivacy
        self.onRefresh = onRefresh
        self.onRemoveFromAccount = onRemoveFromAccount
        self.onReplaceDevice = onReplaceDevice
        self.onFinalizeReplace = onFinalizeReplace
        self.onWipeRestart = onWipeRestart
        self.hasCloudRecovery = hasCloudRecovery
        self.signOutPolicy = signOutPolicy
        self.onRecoveryRequired = onRecoveryRequired
        self.onDeleteAccount = onDeleteAccount
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
                    name: accountDisplayName ?? "@\(username)",
                    subtitle: accountDisplayName == nil ? profileSubtitle : "@\(username) · \(profileSubtitle)",
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

                // Settings taxonomy (spec S1): Account · Devices · Web access ·
                // Backup & peers · App · Danger zone · Developer (hidden). One
                // tap to any row; account security leads the Account group.
                accountGroup(c: c)
                trustedDevicesSection(c: c)
                browserSessionsSection(c: c)
                deviceExtrasGroup(c: c)
                webAccessGroup(c: c)
                backupPeersGroup(c: c)
                appSection(c: c)
                sessionActions(c: c)
                dangerZone(c: c)
                developerGroup(c: c)
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
            disconnectTarget.map { "Revoke \($0.displayName)?" } ?? "Revoke device?",
            isPresented: Binding(
                get: { disconnectTarget != nil },
                set: { if !$0 { disconnectTarget = nil } }
            ),
            titleVisibility: .visible,
            presenting: disconnectTarget
        ) { target in
            Button("Revoke \(target.displayName)", role: .destructive) {
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
            Text("This revokes the device's account access. Its presentation name is never sent to Flagship's control plane in plaintext.")
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
        .sheet(item: $nameEditor) { editor in
            DeviceNameEditor(
                title: editor.title,
                initialName: editor.initialName,
                supportsLock: editor.supportsLock,
                initiallyLocked: editor.initiallyLocked
            ) { name, locked in
                let success: Bool
                switch editor.kind {
                case .account:
                    success = await onRenameAccount(name)
                case .selfDevice:
                    success = await onRenameCurrentDevice(name)
                case .managed(let deviceId):
                    success = await onSetManagedDeviceName(deviceId, name, locked)
                }
                if !success { nameEditMessage = "Couldn't save the encrypted name. Check the name and try again." }
                return success
            }
        }
        .alert(
            "Name not saved",
            isPresented: Binding(
                get: { nameEditMessage != nil },
                set: { if !$0 { nameEditMessage = nil } }
            )
        ) { Button("OK") { nameEditMessage = nil } } message: { Text(nameEditMessage ?? "") }
        .sheet(isPresented: $showWipeComingSoon) {
            WipeComingSoonSheet { showWipeComingSoon = false }
        }
        .confirmationDialog(
            revokeSessionTarget.map { "Revoke \($0.label)?" } ?? "Revoke this session?",
            isPresented: Binding(
                get: { revokeSessionTarget != nil },
                set: { if !$0 { revokeSessionTarget = nil } }
            ),
            titleVisibility: .visible,
            presenting: revokeSessionTarget
        ) { target in
            Button("Revoke", role: .destructive) {
                onRevokeDevice(target)
                revokeSessionTarget = nil
            }
            Button("Cancel", role: .cancel) { revokeSessionTarget = nil }
        } message: { target in
            Text("The browser docked from \(target.label) loses access to this account.")
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
            Text("Rotates your account's identity key. Other devices on this account will need to re-pair the next time they open the app — including this phone. Pods stay running, services stay installed. The change takes effect after a 24-hour grace window during which another device can object.")
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
            "Lock with passkey?",
            isPresented: $signOutConfirm,
            titleVisibility: .visible
        ) {
            // Only reachable when recovery is enrolled (or in demo mode) —
            // the button is greyed and routes to a toast otherwise. The
            // same IRK comes back via the recovery passkey.
            Button("Lock with passkey", role: .destructive) {
                onSignOut()
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This erases this device's account key and data so nothing sensitive is left at rest. Your account and your servers are untouched — sign back in with your recovery passkey and the same key is restored, no re-pair.")
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

    /// The ACCOUNT group (spec S1 group 1): account security, AI keys,
    /// recovery, key backup, profiles. The lead row still surfaces the
    /// account-type state (single-device vs multi-device + 2FA) in its
    /// subtitle and drills into AccountSecurityScreen.
    private func accountGroup(c: FSColors) -> some View {
        FSSettingsGroup("ACCOUNT", rows: [
            FSSettingsRow(
                icon: "person.text.rectangle",
                title: "Display name",
                subtitle: accountDisplayName ?? "Encrypted account presentation name",
                accessibilityId: "settings-edit-account-name",
                action: {
                    guard canManageNames else { return }
                    nameEditor = NameEditor(kind: .account, title: "Edit account name", initialName: accountDisplayName ?? "")
                }
            ),
            FSSettingsRow(
                icon: accountType == "multi" ? "checkmark.shield.fill" : "shield.lefthalf.filled",
                iconTint: accountType == "multi" ? c.success : c.primary,
                title: "Account security",
                subtitle: accountType == "multi"
                    ? "Multi-device + 2FA — recovery needs a code."
                    : "Single-device — recovery is a 3-day wait.",
                accessibilityId: "settings-open-account-security",
                action: onOpenAccountSecurity
            ),
            FSSettingsRow(icon: "sparkles", title: "AI keys", subtitle: "Bring-your-own keys for building apps", action: onOpenAiKeys),
            FSSettingsRow(icon: "key.horizontal.fill", title: "Recovery", subtitle: "Recover on a new device", action: onOpenRecovery),
            FSSettingsRow(icon: "doc.badge.arrow.up.fill", title: "Back up account key", subtitle: "Save an encrypted key file", action: onOpenKeyfileBackup),
            FSSettingsRow(icon: "person.2.circle.fill", title: "Profiles", subtitle: "Switch between your clouds", action: onOpenProfiles),
        ])
    }

    private func trustedDevicesSection(c: FSColors) -> some View {
        section("TRUSTED DEVICES", c: c) {
            VStack(alignment: .leading, spacing: FS.space.s2) {
                // M4 — pending re-pair banner. A replace started on THIS or
                // ANY other device surfaces here with a grace countdown and
                // a "Finalize now" entry into the finalize screen.
                pendingRePairBanner(c: c)
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

    /// M4 — the "Replace pending" banner. Renders only when the GET
    /// /re-pair snapshot carries an un-objected pending row (mirrors the
    /// webapp's `shouldRenderBanner`). The countdown ticks live via a
    /// TimelineView; "Finalize now" is gated on the grace having elapsed
    /// and routes into the existing finalize screen via onFinalizeReplace.
    @ViewBuilder
    private func pendingRePairBanner(c: FSColors) -> some View {
        if ReplaceDeviceViewModel.shouldRenderPendingBanner(pendingRePair),
           let pending = pendingRePair?.pending {
            TimelineView(.periodic(from: .now, by: 1)) { ctx in
                let elapsed = ReplaceDeviceViewModel.graceElapsed(
                    completesAt: pending.completesAt, now: ctx.date)
                FSCard {
                    VStack(alignment: .leading, spacing: FS.space.s2) {
                        HStack(spacing: FS.space.s2) {
                            Image(systemName: "arrow.triangle.2.circlepath.circle.fill")
                                .foregroundColor(c.primary)
                            Text("Replace pending")
                                .font(FS.font.h4()).foregroundColor(c.text)
                            Spacer()
                        }
                        Text(elapsed
                            ? "The grace window has elapsed — finalize the device replacement now."
                            : "Replace pending — finalize when the 3-day grace elapses (\(absolute(ms: pending.completesAt))).")
                            .font(FS.font.caption()).foregroundColor(c.textMuted)
                            .accessibilityIdentifier("pending-re-pair-banner-body")
                        FSPrimaryButton(
                            "Finalize now",
                            enabled: elapsed,
                            block: true
                        ) {
                            onFinalizeReplace(pending.completesAt)
                        }
                        .accessibilityIdentifier("pending-re-pair-finalize-btn")
                    }
                }
                .accessibilityIdentifier("pending-re-pair-banner")
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
    private func trustedDeviceRow(_ d: SettingsViewModel.DirectoryDevice, c: FSColors) -> some View {
        return FSCard {
            HStack(alignment: .top, spacing: FS.space.s3) {
                Image(systemName: platformIcon(d.platformClass))
                    .foregroundColor(c.primary)
                    .imageScale(.large)
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 6) {
                        Text(d.displayName)
                            .font(.system(size: 15, weight: .semibold))
                            .foregroundColor(c.text)
                            .lineLimit(1)
                            .truncationMode(.tail)
                        if d.isCurrent { Text("This device").font(FS.font.caption()).foregroundColor(c.primary) }
                        if d.isLocked { Image(systemName: "lock.fill").foregroundColor(c.textMuted) }
                    }
                    HStack(spacing: 4) {
                        Text(platformDisplay(d.platformClass))
                        Text("·").foregroundColor(c.textMuted)
                        Text("Device \(d.supportCode)")
                    }
                    .font(FS.font.caption()).foregroundColor(c.textMuted)
                    if d.isManaged {
                        Text(d.isLocked ? "Administrator-managed · locked" : "Administrator-managed")
                            .font(FS.font.caption()).foregroundColor(c.textMuted)
                    } else if d.lastSeenAt > d.createdAt {
                        Text("last seen \(relative(ms: d.lastSeenAt))")
                            .font(FS.font.caption()).foregroundColor(c.textMuted)
                    }
                }
                Spacer()
                Menu {
                    if d.isCurrent {
                        Button {
                            nameEditor = NameEditor(kind: .selfDevice, title: "Rename this device", initialName: d.displayName)
                        } label: {
                            Label("Rename this device", systemImage: "pencil")
                        }
                    }
                    if canManageNames {
                        Button {
                            nameEditor = NameEditor(
                                kind: .managed(d.deviceId),
                                title: d.isManaged ? "Edit managed name" : "Set managed name",
                                initialName: d.displayName,
                                supportsLock: true,
                                initiallyLocked: d.isLocked
                            )
                        } label: {
                            Label(d.isManaged ? "Edit managed name" : "Set managed name", systemImage: "lock.shield")
                        }
                        if d.isManaged {
                            Button(role: .destructive) {
                                Task {
                                    if !(await onRemoveManagedDeviceName(d.deviceId)) {
                                        nameEditMessage = "Couldn't remove the managed name."
                                    }
                                }
                            } label: {
                                Label("Remove managed name", systemImage: "lock.open")
                            }
                        }
                        Divider()
                    }
                    Button(role: .destructive) {
                        disconnectTarget = d
                    } label: {
                        Label("Disconnect", systemImage: "wifi.slash")
                    }
                    .disabled(d.isCurrent)
                    // B7 — Replace device. Tap opens a two-stage scare
                    // sheet; the container drives the actual IRK
                    // rotation ceremony through ReplaceDeviceViewModel.
                    Button(role: .destructive) {
                        replaceConfirm = true
                    } label: {
                        Label("Replace device", systemImage: "arrow.triangle.2.circlepath")
                    }
                    .disabled(d.isCurrent)
                    Divider()
                    // E2/E3 — Wipe & restart. Live ceremony. The
                    // container observes onWipeRestart and routes
                    // through WipeRestartViewModel.
                    Button(role: .destructive) {
                        wipeConfirm = true
                    } label: {
                        Label("Wipe & restart…", systemImage: "trash")
                    }
                    .disabled(d.isCurrent)
                } label: {
                    Image(systemName: "ellipsis.circle")
                        .foregroundColor(c.textMuted)
                        .imageScale(.large)
                }
                .accessibilityIdentifier("trusted-device-menu-\(d.deviceId)")
            }
        }
    }

    /// Tooltip + toast copy for a quarantined device. Surfaced both
    /// next to the clock icon AND on a disabled-menu tap. Kept
    /// here (not inline) so the test asserts on the exact string.
    private func platformIcon(_ raw: String?) -> String {
        switch raw {
        case "ios": return "iphone"
        case "android": return "antenna.radiowaves.left.and.right"
        case "web": return "globe"
        case "macos": return "laptopcomputer"
        default:        return "questionmark.circle"
        }
    }

    private func platformDisplay(_ raw: String?) -> String {
        switch raw {
        case "ios": return "iPhone / iPad"
        case "android": return "Android"
        case "web": return "Web"
        case "macos": return "Mac"
        default: return "Device"
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
                    FSDangerButton("Revoke") { revokeSessionTarget = s }
                        .accessibilityIdentifier("settings-revoke-browser-\(s.tokenPrefix)")
                }
            }
        }
    }

    /// Devices continuation (spec S1 group 2): the browser/companion device
    /// ops that aren't the trusted-device list or browser sessions. Rendered
    /// right after those two sections so all device management reads as one
    /// area.
    private func deviceExtrasGroup(c: FSColors) -> some View {
        FSSettingsGroup("COMPANIONS", rows: [
            FSSettingsRow(icon: "laptopcomputer", title: "Dock a browser", subtitle: "Read-only desktop companion (4h)", action: onOpenCompanionDock),
            FSSettingsRow(
                icon: "tray.full",
                title: "Companion requests",
                subtitle: companionRequestsSubtitle,
                badge: pendingCompanionWritesCount > 0 ? pendingCompanionWritesCount : nil,
                action: onOpenCompanionRequests
            ),
        ])
    }

    /// Web-access group (spec S1 group 3).
    private func webAccessGroup(c: FSColors) -> some View {
        FSSettingsGroup("WEB ACCESS", rows: [
            FSSettingsRow(icon: "lock.open.laptopcomputer", title: "Open secured sessions", subtitle: "Sites you've signed a browser into", accessibilityId: "settings-open-secured-sessions", action: onOpenSecuredSessions),
            FSSettingsRow(icon: "link", title: "Process URL", subtitle: "Open a sign-in link you copied", action: onOpenProcessUrl),
        ])
    }

    /// Backup-&-peers group (spec S1 group 4).
    private func backupPeersGroup(c: FSColors) -> some View {
        FSSettingsGroup("BACKUP & PEERS", rows: [
            FSSettingsRow(icon: "externaldrive.connected.to.line.below.fill", title: "Peer-backup", subtitle: "Shard health across peers", action: onOpenPeerBackup),
        ])
    }

    /// Developer group (spec S1 group 7) — hidden behind the 3-tap / mock
    /// toggle. The one place technical terms are allowed to stay.
    @ViewBuilder
    private func developerGroup(c: FSColors) -> some View {
        if showDeveloper {
            FSSettingsGroup("DEVELOPER", rows: [
                FSSettingsRow(icon: "hammer.fill", title: "Developer", subtitle: "Mock/live toggle, latency knob", action: onOpenDeveloper),
            ])
        }
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
        // "Lock with passkey" (tier 2) is recovery-gated: greyed until
        // cloud recovery is enrolled, and a tap on the greyed button
        // surfaces a toast instead of running the key wipe.
        let gated = signOutPolicy == .blockedNoRecovery
        return VStack(spacing: FS.space.s3) {
            VStack(alignment: .leading, spacing: FS.space.s2) {
                Text("Locks Flagship behind Face ID. Nothing is interrupted.")
                    .font(FS.font.caption()).foregroundColor(c.textMuted)
                FSGhostButton("Lock with Face ID", block: true, large: true, action: onLock)
                    .accessibilityIdentifier("settings-lock-btn")
            }
            VStack(alignment: .leading, spacing: FS.space.s2) {
                Text("Erases account key and deletes data. Sign back in with your recovery passkey.")
                    .font(FS.font.caption()).foregroundColor(c.textMuted)
                FSDangerButton("Lock with passkey", muted: gated, block: true, large: true) {
                    if gated { onRecoveryRequired() }
                    else if signOutPolicy == .deletionCeremony { onDeleteAccount() }
                    else { signOutConfirm = true }
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
        // Recovery-gated like "Lock with passkey": greyed until cloud
        // recovery is enrolled, tap-while-greyed surfaces a toast.
        let gated = signOutPolicy == .blockedNoRecovery
        return section("DANGER ZONE", c: c) {
            VStack(alignment: .leading, spacing: FS.space.s2) {
                Text("Remove this device from your account. You may need account recovery to resume.")
                    .font(FS.font.caption()).foregroundColor(c.textMuted)
                FSDangerButton("Remove this device from account", muted: gated, block: true) {
                    if gated { onRecoveryRequired() }
                    else if signOutPolicy == .deletionCeremony { onDeleteAccount() }
                    else { showRemoveConfirm = true }
                }
                .accessibilityIdentifier("remove-from-account-btn")

                Text("Permanently delete your account, its username, and every server's data. This cannot be undone.")
                    .font(FS.font.caption()).foregroundColor(c.textMuted)
                    .padding(.top, FS.space.s2)
                FSDangerButton("Delete account", block: true, action: onDeleteAccount)
                    .accessibilityIdentifier("settings-delete-account-btn")
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

    /// APP group (spec S1 group 5): appearance (Light / Dark / Auto segmented
    /// control), Privacy, and About under one header. Appearance writes
    /// straight to PrivacySettings; RootShell applies it app-wide.
    private func appSection(c: FSColors) -> some View {
        section("APP", c: c) {
            VStack(alignment: .leading, spacing: FS.space.s3) {
                HStack(spacing: FS.space.s2) {
                    appearanceOption(.light, systemImage: "sun.max.fill", text: nil, c: c)
                    appearanceOption(.dark, systemImage: "moon.fill", text: nil, c: c)
                    appearanceOption(.auto, systemImage: nil, text: "AUTO", c: c)
                }
                FSSettingsGroup(rows: [
                    FSSettingsRow(icon: "lock.shield.fill", title: "Privacy", subtitle: "Face ID lock, app-level gating", action: onOpenPrivacy),
                    FSSettingsRow(icon: "info.circle.fill", title: "About Flagship", subtitle: "Version, license, source", action: onOpenAbout),
                ])
            }
        }
    }

    @ViewBuilder
    private func appearanceOption(
        _ mode: PrivacySettings.ThemeMode,
        systemImage: String?,
        text: String?,
        c: FSColors
    ) -> some View {
        let selected = privacy.themeMode == mode
        Button {
            privacy.themeMode = mode
        } label: {
            Group {
                if let systemImage {
                    Image(systemName: systemImage).font(.system(size: 18, weight: .medium))
                } else if let text {
                    Text(text).font(.system(size: 11, weight: .bold)).tracking(1.5)
                }
            }
            .frame(maxWidth: .infinity)
            .frame(height: 46)
            .foregroundColor(selected ? .white : c.text)
            .background(selected ? c.primary : c.surfaceSunken)
            .clipShape(RoundedRectangle(cornerRadius: FS.radius.sm))
        }
        .buttonStyle(.plain)
        .accessibilityLabel(mode == .auto ? "Automatic appearance" : (mode == .light ? "Light appearance" : "Dark appearance"))
        .accessibilityIdentifier("appearance-\(mode.rawValue)")
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
        Date.flagshipFormatted(epochMs: ms)
    }

    /// M4 — absolute locale timestamp for the pending-re-pair banner's
    /// unlock time (mirrors the webapp's `formatCompletesAt`).
    private func absolute(ms: Int64) -> String {
        Date.flagshipFormatted(epochMs: ms, includeTime: true)
    }
}

private struct NameEditor: Identifiable {
    enum Kind {
        case account
        case selfDevice
        case managed(String)
    }

    let id = UUID()
    let kind: Kind
    let title: String
    let initialName: String
    var supportsLock = false
    var initiallyLocked = false
}

private struct DeviceNameEditor: View {
    @Environment(\.dismiss) private var dismiss
    @State private var name: String
    @State private var locked: Bool
    @State private var saving = false
    let title: String
    let supportsLock: Bool
    let onSave: (String, Bool) async -> Bool

    init(
        title: String,
        initialName: String,
        supportsLock: Bool,
        initiallyLocked: Bool,
        onSave: @escaping (String, Bool) async -> Bool
    ) {
        self.title = title
        self.supportsLock = supportsLock
        self.onSave = onSave
        _name = State(initialValue: initialName)
        _locked = State(initialValue: initiallyLocked)
    }

    var body: some View {
        NavigationStack {
            Form {
                TextField("Display name", text: $name)
                    .textInputAutocapitalization(.words)
                if supportsLock {
                    Toggle("Lock managed name", isOn: $locked)
                    Text("The device may retain its own suggestion, but the managed name remains visible until an administrator removes it.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Text("Names are encrypted and apply only inside this Flagship account.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(saving ? "Saving…" : "Save") {
                        saving = true
                        Task {
                            if await onSave(name, locked) { dismiss() }
                            saving = false
                        }
                    }
                    .disabled(saving || name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
        }
        .presentationDetents([.medium])
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
            Text("This rotates your account's identity and recovery passkey in one shot — every other device gets disconnected and you re-pair each one fresh. Pods stay running, services stay installed.")
                .foregroundColor(c.text)
            Text("For v1 you can still Disconnect a single device, and Replace device will land alongside the account-key rotation tools. The full Wipe ceremony needs more testing before we ship it.")
                .font(FS.font.bodySm())
                .foregroundColor(c.textMuted)
            FSPrimaryButton("Got it", block: true, action: onClose)
        }
        .padding(FS.space.s6)
        .background(c.bg)
        .presentationDetents([.medium])
    }
}
