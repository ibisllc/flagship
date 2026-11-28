import SwiftUI
import UIKit
import FlagshipAPI
import Flagship
import FlagshipCore

/// Settings tab, organised into the spec S1 six-group taxonomy:
///   - ACCOUNT — account security · AI keys · Recovery · Back up account key · Profiles
///   - SUBSCRIPTION — the Plan page: data usage, plan, prepaid balance
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
    /// "Remove from account" awaiting its confirmation, then the reason it failed.
    @State private var removeTarget: SettingsViewModel.DirectoryDevice?
    @State private var removeFailure: String?
    /// A removed device was an admin: offer to change the admin key (Account security → Rotate admin key).
    @State private var rotateAdminSuggested = false
    /// Current alternate app-icon name — nil = the primary "classic" icon,
    /// "AppIcon-Legacy" = the original hexagon. Read from UIApplication in
    /// onAppear (App-icon segmented control).
    @State private var alternateIconName: String?
    /// Browser-session revoke awaiting its confirm step. A revoke is
    /// destructive (the docked computer loses access), so it gates behind
    /// a grey Cancel / red Revoke dialog like every other destructive action.
    @State private var revokeSessionTarget: PairedSessionSummary?
    /// B6a — confirmation modal for "Remove this device from account."
    /// Two-stage UX: tap fires this state, sheet shows; sheet's primary
    /// button calls onRemoveFromAccount. Sheet copy adapts based on
    /// whether the user has cloud recovery enrolled.
    @State private var showRemoveConfirm = false
    /// Tier 2 — drives the key-wipe Sign-out confirmation dialog. Copy +
    /// severity adapt on `hasCloudRecovery` (a wipe without recovery is
    /// permanent account loss, so it gets the danger-zone framing).
    @State private var signOutConfirm: Bool = false
    /// The admin-key warnings (docs/account-gone.md): Sign out on an admin
    /// device, and Remove this device on one that holds a key that can still
    /// save a server's data. Only the named buttons act.
    @State private var signOutWarning: Bool = false
    @State private var removeWarning: Bool = false
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
    /// An admin device sees a pending recovery and may reject it (N04).
    var canRejectRecovery: Bool = false
    var onRejectRecovery: () async -> SettingsViewModel.RecoveryVetoOutcome = { .alreadyOver }
    @State private var confirmReject = false
    @State private var rejectMessage: String? = nil
    /// Remove another device from the account: nil once removed, else the sentence to show ("" says nothing).
    var onRemoveTrustedDevice: (SettingsViewModel.DirectoryDevice) async -> String? = { _ in UserErrorText.refused }
    /// This device may change the account key (it holds the admin root): Remove asks whether someone else could
    /// unlock the device, and "Yes, or I'm not sure" opens Change your account key for it.
    var canChangeAccountKey: Bool = false
    var onChangeAccountKey: (SettingsViewModel.DirectoryDevice) -> Void = { _ in }
    var canManageNames: Bool = false
    var onRenameAccount: (String) async -> Bool = { _ in false }
    var onRenameCurrentDevice: (String) async -> Bool = { _ in false }
    var onSetManagedDeviceName: (String, String, Bool) async -> Bool = { _, _, _ in false }
    var onRemoveManagedDeviceName: (String) async -> Bool = { _ in false }
    /// v1.2 Phase 4 — "Multi-device + 2FA" badge state read out of the
    /// Worker `usernames` row. Nil while the load is in flight or if
    /// the call failed; "single" / "multi" otherwise.
    var accountType: String? = nil
    /// Phase 3b — admin opens the "Add a device" cross-device QR pairing
    /// (Settings → Trusted devices → Add a device).
    var onAddDevice: () -> Void = {}
    /// Only an admin device (or a demo account's) adds devices; any other
    /// shows the sentence in place of the button.
    var canAddDevice: Bool = true
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
    /// Open Settings → AI keys (device-local BYOK key manager).
    var onOpenAiKeys: () -> Void = {}
    /// Open Settings → Plan (the plan, the voucher balance, auto-pay and the overage limit).
    var onOpenPlan: () -> Void = {}
    var onOpenRecovery: () -> Void = {}
    /// Open "Back up your account key" — the `.flagshipkey` export.
    var onOpenKeyfileBackup: () -> Void = {}
    /// Open Offline control: your servers on this Wi-Fi when Flagship can't be reached.
    var onOpenOfflineControl: () -> Void = {}
    /// v1.2 Phase 4 — open the Account-security drill-down. The
    /// container hosts AccountSecurityScreen + drives the enable /
    /// disable flows.
    var onOpenAccountSecurity: () -> Void = {}
    var onOpenQuantumSafety: () -> Void = {}
    var onOpenOrganizations: () -> Void = {}
    /// Architecture v2: each trusted device's post-quantum key, by device id ("hardware PQ",
    /// "PQ, hardware-wrapped", or that it has none yet).
    var pqLabels: [String: String] = [:]
    /// W3 — open the Profiles picker (multi-cloud).
    var onOpenProfiles: () -> Void = {}
    /// Name dibs — shown only while the one-year window is open.
    var nameDibsOpen: Bool = false
    var onOpenNameDibs: () -> Void = {}
    /// P9 — open the peer-backup management screen.
    var onOpenPeerBackup: () -> Void = {}
    /// P14 — open the "Remote" browser-pairing screen.
    var onOpenCompanionDock: () -> Void = {}
    /// Web-experience gating — open "Open secured sessions" (browser QR-login
    /// sessions this phone has authorized).
    var onOpenSecuredSessions: () -> Void = {}
    /// P14 Phase 2 — open the Companion-requests inbox. The badge count
    /// next to the row reflects `pendingCompanionWritesCount`.
    var onOpenCompanionRequests: () -> Void = {}
    /// P14 Phase 2 — count of pending companion-forwarded writes. Drives
    /// the badge on the Companion-requests nav row.
    var pendingCompanionWritesCount: Int = 0
    var onOpenAbout: () -> Void = {}
    var onOpenPrivacy: () -> Void = {}
    /// "Your page": opens the page in the Social tab (nil for a sample account, which has none).
    var onOpenYourPage: (() -> Void)?
    var onRefresh: () async -> Void = {}
    /// The trusted-devices list waits for Face ID (the system could not show the prompt when it loaded).
    var trustedDevicesNeedUnlock: Bool = false
    var onLoadTrustedDevices: () async -> Void = {}
    /// B6a — fired after the user confirms in the Remove sheet. The
    /// container is expected to: revoke this device's push token on
    /// .com, wipe local Keystore, and call AppState.signOut so the
    /// user drops back to Welcome.
    var onRemoveFromAccount: () async -> Void = {}
    /// M4 — fired when "Finalize now" on the pending-re-pair banner is
    /// tapped (the grace has elapsed). Carries the snapshot's
    /// `completesAt` so the container can push the finalize screen with
    /// the right deadline. This finishes a replace started on another
    /// device (a recovery's re-pair).
    var onFinalizeReplace: (Int64) -> Void = { _ in }
    /// Whether the user has cloud recovery enrolled — read by the
    /// Remove confirmation sheet to surface a STRONGER warning when
    /// not enrolled (no enrolment = removing this device permanently
    /// loses account access).
    var hasCloudRecovery: Bool = true
    /// SEC-REPAIR-001: the recovery record predates `.com`'s passkey check; a quiet row offers the update.
    var recoveryNeedsUpdate: Bool = false
    var onUpdateRecovery: () -> Void = {}
    /// A passwordless demo session holds no account keys, so the key-backed
    /// rows (recovery, key backup, trusted devices) are hidden for it.
    var isDemoAccount: Bool = false
    /// #52 — the Tier-2 sign-out gate, computed by the container
    /// (SettingsTab) via SignOutPolicy.evaluate so the demo exemption
    /// lives in ONE place. `.blockedNoRecovery` greys out the gated
    /// buttons ("Sign out" + "Remove this device") and routes a
    /// tap to `onRecoveryRequired` instead of the destructive confirm.
    var signOutPolicy: SignOutPolicy = .allowed
    /// Fired when a recovery-gated button is tapped while still greyed
    /// (no cloud recovery enrolled). The container surfaces a toast —
    /// "Set up account recovery to use this." — rather than running the
    /// destructive path.
    var onRecoveryRequired: () -> Void = {}
    /// Fired when the action is account DEATH (`signOutPolicy ==
    /// .deletionCeremony` — no cloud recovery AND this is the last device).
    /// Both the tier-2 "Sign out" and the danger-zone "Remove this
    /// device" confirm into the SAME ceremony: this routes the container to
    /// push the full-page irreversible warning (typed-username + biometric →
    /// owner-IRK self-delete bundle → local wipe → Welcome).
    var onDeleteAccount: () -> Void = {}
    /// This device holds the account's admin root: Sign out says it removes
    /// that key (a demo account holds none).
    var holdsAdminKey: Bool = false
    /// This device holds a key that can still save a server's data (the admin
    /// root, or a session for a server): Remove this device warns first.
    var holdsRescueKey: Bool = false
    /// This device wrote an account-key file: Sign out then says what to keep.
    var keyBackedUp: Bool = false
    /// "Save my account key first": opens the account-key export. Removes nothing.
    var onSaveDataFirst: () -> Void = {}

    public init(
        username: String,
        accountDisplayName: String? = nil,
        controlDevices: LoadingState<[PairedSessionSummary]>,
        trustedDevices: LoadingState<[SettingsViewModel.DirectoryDevice]> = .loaded([]),
        pendingRePair: PendingRePairSnapshot? = nil,
        canRejectRecovery: Bool = false,
        onRejectRecovery: @escaping () async -> SettingsViewModel.RecoveryVetoOutcome = { .alreadyOver },
        accountType: String? = nil,
        canAddDevice: Bool = true,
        onAddDevice: @escaping () -> Void = {},
        onScanPairingCode: @escaping () -> Void = {},
        onRevokeDevice: @escaping (PairedSessionSummary) -> Void = { _ in },
        onRemoveTrustedDevice: @escaping (SettingsViewModel.DirectoryDevice) async -> String? = { _ in UserErrorText.refused },
        canChangeAccountKey: Bool = false,
        onChangeAccountKey: @escaping (SettingsViewModel.DirectoryDevice) -> Void = { _ in },
        canManageNames: Bool = false,
        onRenameAccount: @escaping (String) async -> Bool = { _ in false },
        onRenameCurrentDevice: @escaping (String) async -> Bool = { _ in false },
        onSetManagedDeviceName: @escaping (String, String, Bool) async -> Bool = { _, _, _ in false },
        onRemoveManagedDeviceName: @escaping (String) async -> Bool = { _ in false },
        onLock: @escaping () -> Void = {},
        onSignOut: @escaping () -> Void = {},
        onOpenAiKeys: @escaping () -> Void = {},
        onOpenPlan: @escaping () -> Void = {},
        onOpenRecovery: @escaping () -> Void = {},
        onOpenKeyfileBackup: @escaping () -> Void = {},
        onOpenOfflineControl: @escaping () -> Void = {},
        onOpenAccountSecurity: @escaping () -> Void = {},
        onOpenQuantumSafety: @escaping () -> Void = {},
        onOpenOrganizations: @escaping () -> Void = {},
        pqLabels: [String: String] = [:],
        onOpenProfiles: @escaping () -> Void = {},
        nameDibsOpen: Bool = false,
        onOpenNameDibs: @escaping () -> Void = {},
        onOpenPeerBackup: @escaping () -> Void = {},
        onOpenCompanionDock: @escaping () -> Void = {},
        onOpenSecuredSessions: @escaping () -> Void = {},
        onOpenCompanionRequests: @escaping () -> Void = {},
        pendingCompanionWritesCount: Int = 0,
        onOpenAbout: @escaping () -> Void = {},
        onOpenPrivacy: @escaping () -> Void = {},
        onOpenYourPage: (() -> Void)? = nil,
        onRefresh: @escaping () async -> Void = {},
        trustedDevicesNeedUnlock: Bool = false,
        onLoadTrustedDevices: @escaping () async -> Void = {},
        onRemoveFromAccount: @escaping () async -> Void = {},
        onFinalizeReplace: @escaping (Int64) -> Void = { _ in },
        hasCloudRecovery: Bool = true,
        signOutPolicy: SignOutPolicy = .allowed,
        onRecoveryRequired: @escaping () -> Void = {},
        onDeleteAccount: @escaping () -> Void = {},
        isDemoAccount: Bool = false,
        holdsAdminKey: Bool = false,
        holdsRescueKey: Bool = false,
        keyBackedUp: Bool = false,
        onSaveDataFirst: @escaping () -> Void = {},
        recoveryNeedsUpdate: Bool = false,
        onUpdateRecovery: @escaping () -> Void = {}
    ) {
        self.recoveryNeedsUpdate = recoveryNeedsUpdate
        self.onUpdateRecovery = onUpdateRecovery
        self.username = username
        self.accountDisplayName = accountDisplayName
        self.controlDevices = controlDevices
        self.trustedDevices = trustedDevices
        self.pendingRePair = pendingRePair
        self.canRejectRecovery = canRejectRecovery
        self.onRejectRecovery = onRejectRecovery
        self.onRemoveTrustedDevice = onRemoveTrustedDevice
        self.canChangeAccountKey = canChangeAccountKey
        self.onChangeAccountKey = onChangeAccountKey
        self.canManageNames = canManageNames
        self.onRenameAccount = onRenameAccount
        self.onRenameCurrentDevice = onRenameCurrentDevice
        self.onSetManagedDeviceName = onSetManagedDeviceName
        self.onRemoveManagedDeviceName = onRemoveManagedDeviceName
        self.accountType = accountType
        self.canAddDevice = canAddDevice
        self.onAddDevice = onAddDevice
        self.onScanPairingCode = onScanPairingCode
        self.onRevokeDevice = onRevokeDevice
        self.onLock = onLock
        self.onSignOut = onSignOut
        self.onOpenAiKeys = onOpenAiKeys
        self.onOpenPlan = onOpenPlan
        self.onOpenRecovery = onOpenRecovery
        self.onOpenKeyfileBackup = onOpenKeyfileBackup
        self.onOpenOfflineControl = onOpenOfflineControl
        self.onOpenAccountSecurity = onOpenAccountSecurity
        self.onOpenQuantumSafety = onOpenQuantumSafety
        self.onOpenOrganizations = onOpenOrganizations
        self.pqLabels = pqLabels
        self.onOpenProfiles = onOpenProfiles
        self.nameDibsOpen = nameDibsOpen
        self.onOpenNameDibs = onOpenNameDibs
        self.onOpenPeerBackup = onOpenPeerBackup
        self.onOpenCompanionDock = onOpenCompanionDock
        self.onOpenSecuredSessions = onOpenSecuredSessions
        self.onOpenCompanionRequests = onOpenCompanionRequests
        self.pendingCompanionWritesCount = pendingCompanionWritesCount
        self.onOpenAbout = onOpenAbout
        self.onOpenPrivacy = onOpenPrivacy
        self.onOpenYourPage = onOpenYourPage
        self.onRefresh = onRefresh
        self.trustedDevicesNeedUnlock = trustedDevicesNeedUnlock
        self.onLoadTrustedDevices = onLoadTrustedDevices
        self.onRemoveFromAccount = onRemoveFromAccount
        self.onFinalizeReplace = onFinalizeReplace
        self.hasCloudRecovery = hasCloudRecovery
        self.signOutPolicy = signOutPolicy
        self.onRecoveryRequired = onRecoveryRequired
        self.onDeleteAccount = onDeleteAccount
        self.isDemoAccount = isDemoAccount
        self.holdsAdminKey = holdsAdminKey
        self.holdsRescueKey = holdsRescueKey
        self.keyBackedUp = keyBackedUp
        self.onSaveDataFirst = onSaveDataFirst
    }

    /// Optional promo announcement at the top of Settings. Wired but empty by
    /// default — the container can flip it on for a campaign without touching
    /// the screen. Kept as state so a future "dismiss" is a one-liner.
    @State private var showPromo: Bool = false

    public var body: some View {
        let c = FSColors.scheme(scheme)
        // Split in three: as one expression it took ~4 s to type-check and timed out CI.
        return laterDialogs(earlyDialogs(settingsList(c)))
    }

    private func settingsList(_ c: FSColors) -> some View {
        List {
            // A compact, non-interactive cloud identifier. Account
            // Security remains available in the Account group below.
            Text("@\(username)")
                .font(FS.font.scaled(22, weight: .semibold))
                .foregroundColor(c.text)
                .lineLimit(1)
                .truncationMode(.tail)
                .accessibilityIdentifier("settings-cloud-username")
                .fsPlainListRow()

            // Optional promo slot (empty unless flipped on).
            if showPromo {
                FSAnnouncementCard(
                    icon: "sparkles",
                    title: String(localized: "Welcome to Flagship"),
                    message: String(localized: "Your stuff, on your hardware, with a real green padlock."),
                    onDismiss: { showPromo = false }
                )
                .fsPlainListRow()
            }

            // Settings taxonomy (spec S1): Account · Devices · Web access ·
            // Backup & peers · App · Danger zone · Developer (hidden). One
            // tap to any row; account security leads the Account group.
            accountGroup(c: c)
            if !isDemoAccount {
                subscription(c: c)
                trustedDevicesSection(c: c).fsPlainListRow()
            }
            browserSessionsSection(c: c).fsPlainListRow()
            deviceExtrasGroup(c: c)
            webAccessGroup(c: c)
            backupPeersGroup(c: c)
            appSection(c: c).fsPlainListRow()
            appRows
            sessionActions(c: c).fsPlainListRow()
            dangerZone(c: c).fsPlainListRow()
            about(c: c).fsPlainListRow()
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .listSectionSpacing(FS.space.s4)
        .fsReadingColumn()
        .background(c.bg.ignoresSafeArea())
        .navigationTitle("Settings")
        .navigationBarTitleDisplayMode(sizeClass == .regular ? .inline : .large)
        .refreshable { await onRefresh() }
    }

    private func earlyDialogs(_ content: some View) -> some View {
        content
        .confirmationDialog(
            removeTarget.map { RemoveDeviceCopy.title($0.displayName) } ?? "",
            isPresented: Binding(
                get: { removeTarget != nil },
                set: { if !$0 { removeTarget = nil } }
            ),
            titleVisibility: .visible,
            presenting: removeTarget
        ) { target in
            Button(RemoveDeviceCopy.noChoice, role: .destructive) {
                remove(target)
            }
            .accessibilityIdentifier("remove-device-no")
            if canChangeAccountKey {
                Button(RemoveDeviceCopy.yesChoice) {
                    removeTarget = nil
                    onChangeAccountKey(target)
                }
                .accessibilityIdentifier("remove-device-yes")
            }
            Button("Cancel", role: .cancel) { removeTarget = nil }
        } message: { target in
            Text(RemoveDeviceCopy.message(for: target, canChangeKey: canChangeAccountKey))
        }
        .alert(RemoveDeviceCopy.adminRemovedTitle, isPresented: $rotateAdminSuggested) {
            Button(RemoveDeviceCopy.openAccountSecurity) { onOpenAccountSecurity() }
            Button("Not now", role: .cancel) {}
        } message: {
            Text(RemoveDeviceCopy.adminRemovedMessage)
        }
        .alert(
            RemoveDeviceCopy.failedTitle,
            isPresented: Binding(
                get: { removeFailure != nil },
                set: { if !$0 { removeFailure = nil } }
            )
        ) {
            Button("OK") { removeFailure = nil }
        } message: {
            Text(removeFailure ?? "")
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
                if !success { nameEditMessage = String(localized: "Couldn't save the encrypted name. Check the name and try again.") }
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
    }

    private func laterDialogs(_ content: some View) -> some View {
        content
        .confirmationDialog(
            revokeSessionTarget.map { String(localized: "Revoke session \($0.tokenPrefix)?") } ?? String(localized: "Revoke this session?"),
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
            Text("Session \(target.tokenPrefix) loses access to this account.")
        }
        .confirmationDialog(
            "Sign out?",
            isPresented: $signOutConfirm,
            titleVisibility: .visible
        ) {
            // Only reachable when recovery is enrolled (or in demo mode) —
            // the button is greyed and routes to a toast otherwise. The
            // same IRK comes back via the recovery passkey.
            Button("Sign out", role: .destructive) {
                onSignOut()
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This erases this device's account key and data so nothing sensitive is left at rest. Your account and your servers are untouched — sign back in with your recovery passkey and the same key is restored, no re-pair.")
        }
        .alert(
            AdminKeyWarning.signOut(backedUp: keyBackedUp).title,
            isPresented: $signOutWarning
        ) {
            ForEach(AdminKeyWarning.signOut(backedUp: keyBackedUp).choices, id: \.label) { choice in
                switch choice.role {
                case .cancel: Button(choice.label, role: .cancel) {}
                case .save: Button(choice.label) { onSaveDataFirst() }
                case .go: Button(choice.label, role: .destructive) { onSignOut() }
                }
            }
        } message: {
            Text(AdminKeyWarning.signOut(backedUp: keyBackedUp).message)
        }
        .alert(AdminKeyWarning.remove.title, isPresented: $removeWarning) {
            ForEach(AdminKeyWarning.remove.choices, id: \.label) { choice in
                switch choice.role {
                case .cancel: Button(choice.label, role: .cancel) {}
                case .save: Button(choice.label) { onSaveDataFirst() }
                case .go: Button(choice.label, role: .destructive) { Task { await onRemoveFromAccount() } }
                }
            }
        } message: {
            Text(AdminKeyWarning.remove.message)
        }
    }

    /// Remove from account, after its confirmation. The one step today; a later "Could someone else unlock this
    /// device?" question (new account keys) goes between the confirmation and this call.
    private func remove(_ target: SettingsViewModel.DirectoryDevice) {
        removeTarget = nil
        Task {
            if let failure = await onRemoveTrustedDevice(target) {
                if !failure.isEmpty { removeFailure = failure }
            } else if target.isAdministrator, canChangeAccountKey {
                // An admin added before admins were made by grant may hold the admin key itself.
                rotateAdminSuggested = true
            }
        }
    }

    /// SUBSCRIPTION group: the Plan page (data usage, the plan and the prepaid balance).
    private func subscription(c: FSColors) -> some View {
        FSSettingsListSection(String(localized: "Subscription"), rows: [
            FSSettingsRow(
                icon: "dollarsign.circle.fill",
                title: String(localized: "Plan"),
                subtitle: String(localized: "Data usage, your plan and prepaid balance"),
                accessibilityId: "settings-open-plan",
                action: onOpenPlan
            )
        ])
    }

    /// The ACCOUNT group (spec S1 group 1): account security, AI keys,
    /// recovery, key backup, profiles. The lead row still surfaces the
    /// account-type state (single-device vs multi-device + 2FA) in its
    /// subtitle and drills into AccountSecurityScreen.
    private func accountGroup(c: FSColors) -> some View {
        // Built step by step: one long `[...] + [...]` expression timed out the CI type checker.
        var rows: [FSSettingsRow] = [
            FSSettingsRow(
                icon: "person.text.rectangle",
                title: String(localized: "Display name"),
                subtitle: accountDisplayName ?? String(localized: "Encrypted account presentation name"),
                accessibilityId: "settings-edit-account-name",
                action: {
                    guard canManageNames else { return }
                    nameEditor = NameEditor(kind: .account, title: String(localized: "Edit account name"), initialName: accountDisplayName ?? "")
                }
            ),
        ]
        if let open = onOpenYourPage {
            rows.append(FSSettingsRow(icon: "person.crop.circle", title: String(localized: "Your page"), subtitle: "voi.ci/\(username)",
                                      accessibilityId: "settings-your-page", action: open))
        }
        let multi = accountType == "multi"
        rows.append(FSSettingsRow(
            icon: multi ? "checkmark.shield.fill" : "shield.lefthalf.filled",
            iconTint: multi ? c.success : c.accent,
            title: String(localized: "Account security"),
            subtitle: multi
                ? String(localized: "Code protection on — recovery needs a code.")
                : String(localized: "Single-device — recovery is a 3-day wait."),
            accessibilityId: "settings-open-account-security",
            action: onOpenAccountSecurity
        ))
        rows.append(FSSettingsRow(icon: "atom", title: String(localized: "Quantum-safe protection"), subtitle: String(localized: "Strict protection per server"),
                                  accessibilityId: "settings-open-quantum-safety", action: onOpenQuantumSafety))
        rows.append(FSSettingsRow(icon: "person.3", title: String(localized: "Organizations"), subtitle: String(localized: "Run servers together, with signed approvals"),
                                  accessibilityId: "settings-open-organizations", action: onOpenOrganizations))
        rows.append(FSSettingsRow(icon: "sparkles", title: String(localized: "AI API keys"), subtitle: String(localized: "Bring-your-own keys for building apps"), action: onOpenAiKeys))
        // Always present: it works when Flagship can't be reached (docs/data-sovereignty.md).
        rows.append(FSSettingsRow(icon: "wifi", title: String(localized: "Offline control"), subtitle: String(localized: "Your servers on this Wi-Fi, without Flagship"),
                                  accessibilityId: "settings-open-offline-control", action: onOpenOfflineControl))
        if !isDemoAccount {
            rows.append(FSSettingsRow(icon: "key.horizontal.fill", title: String(localized: "Cloud recovery"), subtitle: String(localized: "Recover on a new device"), action: onOpenRecovery))
            if recoveryNeedsUpdate {
                rows.append(FSSettingsRow(icon: "person.badge.key", title: RecoveryUpdatePrompt.settingsRow,
                                          subtitle: String(localized: "Have your passkey checked too"),
                                          accessibilityId: "settings-update-recovery", action: onUpdateRecovery))
            }
            rows.append(FSSettingsRow(icon: "doc.badge.arrow.up.fill", title: String(localized: "Back up account key"), subtitle: String(localized: "Save an encrypted key file"), action: onOpenKeyfileBackup))
            if nameDibsOpen {
                rows.append(FSSettingsRow(icon: "flag.fill", title: String(localized: "Claim your .com name"), subtitle: String(localized: "Own the .com? The matching name is held for you"),
                                          accessibilityId: "settings-open-name-dibs", action: onOpenNameDibs))
            }
        }
        rows.append(FSSettingsRow(icon: "person.2.circle.fill", title: String(localized: "Profiles"), subtitle: String(localized: "Switch between your clouds"), action: onOpenProfiles))
        return FSSettingsListSection(String(localized: "Account"), rows: rows)
    }

    private func trustedDevicesSection(c: FSColors) -> some View {
        section(String(localized: "Trusted devices"), c: c) {
            VStack(alignment: .leading, spacing: FS.space.s2) {
                // M4 — pending re-pair banner. A replace started on THIS or
                // ANY other device surfaces here with a grace countdown and
                // a "Finalize now" entry into the finalize screen.
                recoveryReviewCard(c: c)
                pendingRePairBanner(c: c)
                Text("Phones and tablets that hold your account keys.")
                    .font(FS.font.caption()).foregroundColor(c.textMuted)
                    // In a List row a multi-line caption keeps the height it had when the row was first
                    // measured (an error card), and is cut off once the list replaces it.
                    .fixedSize(horizontal: false, vertical: true)
                switch trustedDevices {
                case .idle, .loading:
                    ServerCardSkeleton()
                case .failed(let msg) where trustedDevicesNeedUnlock:
                    FSCard {
                        VStack(alignment: .leading, spacing: FS.space.s2) {
                            Text(msg).font(FS.font.bodySm()).foregroundColor(c.textMuted)
                                .fixedSize(horizontal: false, vertical: true)
                            FSSecondaryButton(String(localized: "Show trusted devices"), block: true) {
                                Task { await onLoadTrustedDevices() }
                            }
                            .accessibilityIdentifier("settings-trusted-devices-unlock")
                        }
                    }
                case .failed(let msg):
                    ErrorCard(message: msg, retry: onLoadTrustedDevices)
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
                        .foregroundColor(c.accent)
                        .padding(FS.space.s3)
                        .frame(maxWidth: .infinity)
                        .background(c.surface)
                        .clipShape(RoundedRectangle(cornerRadius: FS.radius.md, style: .continuous))
                    }
                    .disabled(!canAddDevice)
                    .opacity(canAddDevice ? 1 : 0.5)
                    .accessibilityIdentifier("settings-add-device")
                    Text(canAddDevice
                         ? String(localized: "For your own phones and tablets. To give another person access, use Share this server on the server's page.")
                         : AddDeviceGate.adminOnlyLine)
                        .font(FS.font.caption())
                        .foregroundColor(c.textMuted)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier(canAddDevice ? "settings-add-device-note" : "settings-add-device-admin-only")
                    Button(action: onScanPairingCode) {
                        HStack(spacing: FS.space.s2) {
                            Image(systemName: "qrcode.viewfinder")
                            Text("Scan a code or enter a link").font(FS.font.bodySm())
                            Spacer()
                            Image(systemName: "chevron.right").imageScale(.small).foregroundColor(c.textMuted)
                        }
                        .foregroundColor(c.text)
                        .padding(FS.space.s3)
                        .frame(maxWidth: .infinity)
                        .background(c.surface)
                        .clipShape(RoundedRectangle(cornerRadius: FS.radius.md, style: .continuous))
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
    /// N04: a recovery of this account is waiting. An admin device can reject it; the new
    /// device has no admin authority until the wait ends.
    @ViewBuilder
    private func recoveryReviewCard(c: FSColors) -> some View {
        if canRejectRecovery, let pending = pendingRePair?.pending, pending.objectedAt == nil {
            FSCard {
                VStack(alignment: .leading, spacing: FS.space.s2) {
                    HStack(spacing: FS.space.s2) {
                        Image(systemName: "exclamationmark.triangle.fill").foregroundColor(c.danger)
                        Text("A recovery of this account is waiting")
                            .font(FS.font.h4()).foregroundColor(c.text)
                        Spacer()
                    }
                    Text("A new device asked to take over this account. It becomes active on \(absolute(ms: pending.completesAt)) unless an admin rejects it. It has no admin authority until then.")
                        .font(FS.font.caption()).foregroundColor(c.textMuted)
                        .accessibilityIdentifier("recovery-review-body")
                    Text(RecoveryReviewCopy.unusualNote)
                        .font(FS.font.caption()).foregroundColor(c.textMuted)
                    if let m = rejectMessage {
                        Text(m).font(FS.font.caption()).foregroundColor(c.danger)
                    }
                    FSPrimaryButton(String(localized: "Reject recovery"), enabled: true, block: true) { confirmReject = true }
                        .accessibilityIdentifier("recovery-review-reject-btn")
                }
            }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("recovery-review-card")
            .confirmationDialog(RecoveryReviewCopy.confirmTitle, isPresented: $confirmReject, titleVisibility: .visible) {
                Button("Reject recovery", role: .destructive) {
                    Task {
                        switch await onRejectRecovery() {
                        case .rejected: rejectMessage = nil
                        case .alreadyOver: rejectMessage = "This recovery was already cancelled or finished."
                        case .failed(let m): rejectMessage = m
                        }
                    }
                }
                Button("Keep waiting", role: .cancel) {}
            } message: {
                Text(RecoveryReviewCopy.confirmMessage)
            }
        }
    }

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
                                .foregroundColor(c.accent)
                            Text("Replace pending")
                                .font(FS.font.h4()).foregroundColor(c.text)
                            Spacer()
                        }
                        Text(elapsed
                            ? String(localized: "The grace window has elapsed — finalize the device replacement now.")
                            : "Replace pending — finalize when the 3-day grace elapses (\(absolute(ms: pending.completesAt))).")
                            .font(FS.font.caption()).foregroundColor(c.textMuted)
                            .accessibilityIdentifier("pending-re-pair-banner-body")
                        FSPrimaryButton(
                            String(localized: "Finalize now"),
                            enabled: elapsed,
                            block: true
                        ) {
                            onFinalizeReplace(pending.completesAt)
                        }
                        .accessibilityIdentifier("pending-re-pair-finalize-btn")
                    }
                }
                // `.contain` keeps the Finalize button's own identifier.
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("pending-re-pair-banner")
            }
        }
    }

    /// One row per device. Its menu: the rename items and, for another
    /// device, Remove from account (docs/revocation-ui.md).
    ///
    /// v1.2 Phase 4 — when the row is quarantined (the 14-day
    /// freshly-admitted window), surface a clock icon + tooltip and
    /// disable the destructive menu entries. Tapping a disabled
    /// entry surfaces a toast explaining why.
    private func trustedDeviceRow(_ d: SettingsViewModel.DirectoryDevice, c: FSColors) -> some View {
        return FSCard {
            HStack(alignment: .top, spacing: FS.space.s3) {
                Image(systemName: platformIcon(d.platformClass))
                    .foregroundColor(c.accent)
                    .imageScale(.large)
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 6) {
                        Text(d.displayName)
                            .font(FS.font.scaled(15, weight: .semibold))
                            .foregroundColor(c.text)
                            .lineLimit(1)
                            .truncationMode(.tail)
                        if d.isCurrent { Text("This device").font(FS.font.scaled(12, weight: .semibold)).foregroundColor(c.text) }
                        if d.isLocked { Image(systemName: "lock.fill").foregroundColor(c.textMuted) }
                    }
                    HStack(spacing: 4) {
                        Text(platformDisplay(d.platformClass))
                        Text("·").foregroundColor(c.textMuted)
                        Text("Device \(d.supportCode)")
                    }
                    .font(FS.font.caption()).foregroundColor(c.textMuted)
                    if let pq = pqLabels[d.deviceId] {
                        Text(pq).font(FS.font.caption()).foregroundColor(c.textMuted)
                            .accessibilityIdentifier("settings-device-pq-\(d.deviceId)")
                    }
                    if d.isManaged {
                        Text(d.isLocked ? String(localized: "Administrator-managed · locked") : "Administrator-managed")
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
                            nameEditor = NameEditor(kind: .selfDevice, title: String(localized: "Rename this device"), initialName: d.displayName)
                        } label: {
                            Label("Rename this device", systemImage: "pencil")
                        }
                    }
                    if canManageNames {
                        Button {
                            nameEditor = NameEditor(
                                kind: .managed(d.deviceId),
                                title: d.isManaged ? String(localized: "Edit managed name") : String(localized: "Set managed name"),
                                initialName: d.displayName,
                                supportsLock: true,
                                initiallyLocked: d.isLocked
                            )
                        } label: {
                            Label(d.isManaged ? String(localized: "Edit managed name") : "Set managed name", systemImage: "lock.shield")
                        }
                        if d.isManaged {
                            Button(role: .destructive) {
                                Task {
                                    if !(await onRemoveManagedDeviceName(d.deviceId)) {
                                        nameEditMessage = String(localized: "Couldn't remove the managed name.")
                                    }
                                }
                            } label: {
                                Label("Remove managed name", systemImage: "lock.open")
                            }
                        }
                        Divider()
                    }
                    if !d.isCurrent {
                        Button(role: .destructive) {
                            removeTarget = d
                        } label: {
                            Label(RemoveDeviceCopy.confirm, systemImage: "person.crop.circle.badge.minus")
                        }
                        .accessibilityIdentifier("trusted-device-remove-\(d.deviceId)")
                    }
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
        case "web": return String(localized: "Web")
        case "macos": return String(localized: "Mac")
        default: return String(localized: "Device")
        }
    }

    /// Docked-browser sessions — distinct from Trusted devices (which
    /// hold your account keys). These are temporary desktop companions
    /// created via "Remote". The section is HIDDEN unless at
    /// least one session is active, so a normal single-phone account
    /// never sees a second, duplicate-looking device list. When present,
    /// each row carries the Revoke action — the only place to end a
    /// docked session.
    @ViewBuilder
    private func browserSessionsSection(c: FSColors) -> some View {
        if case .loaded(let sessions) = controlDevices, !sessions.isEmpty {
            section(String(localized: "Browser sessions"), c: c) {
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
                    Text("Session \(s.tokenPrefix)").foregroundColor(c.text)
                    Text("paired \(relative(ms: s.addedAt))")
                        .font(FS.font.caption()).foregroundColor(c.textMuted)
                }
                Spacer()
                if s.current {
                    FSPill(String(localized: "This device"), kind: .online)
                } else {
                    FSDangerButton(String(localized: "Revoke")) { revokeSessionTarget = s }
                        .accessibilityIdentifier("settings-revoke-browser-\(s.tokenPrefix)")
                }
            }
            if !s.current { CompanionDelegationView(sessionId: s.tokenPrefix, canSign: Keystore.hasAdminRoot) }
        }
    }

    /// Devices continuation (spec S1 group 2): the browser/companion device
    /// ops that aren't the trusted-device list or browser sessions. Rendered
    /// right after those two sections so all device management reads as one
    /// area.
    private func deviceExtrasGroup(c: FSColors) -> some View {
        FSSettingsListSection(String(localized: "Companions"), rows: [
            FSSettingsRow(icon: "laptopcomputer", title: String(localized: "Remote"), subtitle: String(localized: "Read-only browser session (4h)"), action: onOpenCompanionDock),
            FSSettingsRow(
                icon: "tray.full",
                title: String(localized: "Companion requests"),
                subtitle: companionRequestsSubtitle,
                badge: pendingCompanionWritesCount > 0 ? pendingCompanionWritesCount : nil,
                action: onOpenCompanionRequests
            ),
        ])
    }

    /// Web-access group (spec S1 group 3).
    private func webAccessGroup(c: FSColors) -> some View {
        FSSettingsListSection(String(localized: "Web access"), rows: [
            FSSettingsRow(icon: "lock.open.laptopcomputer", title: String(localized: "Open secured sessions"), subtitle: String(localized: "Sites you've signed a browser into"), accessibilityId: "settings-open-secured-sessions", action: onOpenSecuredSessions),
        ])
    }

    /// Backup-&-peers group (spec S1 group 4).
    private func backupPeersGroup(c: FSColors) -> some View {
        FSSettingsListSection(String(localized: "Backup & peers"), rows: [
            FSSettingsRow(icon: "externaldrive.connected.to.line.below.fill", title: String(localized: "Peer backup"), subtitle: String(localized: "Where the pieces of your backup are kept"), action: onOpenPeerBackup),
        ])
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
    ///
    /// Both buttons share one box and one look (owner, 2026-10-15); the
    /// sign-out confirmation carries the warning.
    private func sessionActions(c: FSColors) -> some View {
        // "Sign out" (tier 2) is recovery-gated: greyed until cloud
        // recovery is enrolled, and a tap on the greyed button surfaces a
        // toast instead of running the key wipe.
        let gated = signOutPolicy == .blockedNoRecovery
        return FSCard {
            VStack(alignment: .leading, spacing: FS.space.s3) {
                // Locking erases nothing, so it is not red; the three that
                // remove something are (owner, 2026-10-23). A recovery-gated
                // one stays red, dimmed, and a tap says why.
                FSSecondaryButton(String(localized: "Lock the app"), block: true, large: true, action: onLock)
                    .accessibilityIdentifier("settings-lock-btn")
                FSDangerButton(String(localized: "Sign out"), block: true, large: true) {
                    if gated { onRecoveryRequired() }
                    else if signOutPolicy == .deletionCeremony { onDeleteAccount() }
                    else if holdsAdminKey { signOutWarning = true }
                    else { signOutConfirm = true }
                }
                .opacity(gated ? 0.6 : 1)
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
        // Recovery-gated like "Sign out": greyed until cloud recovery is
        // enrolled, tap-while-greyed surfaces a toast. Boxed like a server
        // page's Danger zone; the confirmations carry the warnings.
        let gated = signOutPolicy == .blockedNoRecovery
        return section(String(localized: "Danger zone"), c: c) {
            FSCard {
                VStack(alignment: .leading, spacing: FS.space.s3) {
                    FSDangerButton(String(localized: "Remove this device from account"), block: true) {
                        if gated { onRecoveryRequired() }
                        else if signOutPolicy == .deletionCeremony { onDeleteAccount() }
                        else if holdsRescueKey { removeWarning = true }
                        else { showRemoveConfirm = true }
                    }
                    .opacity(gated ? 0.6 : 1)
                    .accessibilityIdentifier("remove-from-account-btn")
                    FSDangerButton(String(localized: "Delete account"), block: true, action: onDeleteAccount)
                        .accessibilityIdentifier("settings-delete-account-btn")
                }
            }
        }
        .confirmationDialog(
            hasCloudRecovery
                ? String(localized: "Remove this device from your account?")
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
                ? String(localized: "We'll revoke this device's notification access and erase its local keys. Use your recovery passkey to sign in again later.")
                : "You have no cloud recovery on this account. After removal, no other device can take over — your account is gone for good. Set up recovery first if you might want to come back.")
        }
    }

    /// APP group (spec S1 group 5): appearance (Light / Dark / Auto segmented
    /// control), Privacy, and About under one header. Appearance writes
    /// straight to PrivacySettings; RootShell applies it app-wide.
    private func appSection(c: FSColors) -> some View {
        section(String(localized: "App"), c: c) {
            VStack(alignment: .leading, spacing: FS.space.s3) {
                FSSegmentedControl(
                    segments: [
                        .init(value: PrivacySettings.ThemeMode.light, title: String(localized: "Light"), systemImage: "sun.max.fill",
                              identifier: "appearance-light", accessibilityLabel: String(localized: "Light appearance")),
                        .init(value: .dark, title: String(localized: "Dark"), systemImage: "moon.fill",
                              identifier: "appearance-dark", accessibilityLabel: String(localized: "Dark appearance")),
                        .init(value: .auto, title: String(localized: "Auto"), identifier: "appearance-auto",
                              accessibilityLabel: String(localized: "Automatic appearance")),
                    ],
                    selection: privacy.themeMode,
                    onSelect: { privacy.themeMode = $0 }
                )
                FSSectionLabel(String(localized: "App icon"))
                FSSegmentedControl(
                    segments: [
                        .init(value: String?.none, title: String(localized: "Classic"), identifier: "appicon-classic"),
                        .init(value: String(localized: "AppIcon-Legacy"), title: String(localized: "Legacy"), identifier: "appicon-legacy"),
                    ],
                    selection: alternateIconName,
                    onSelect: { setAppIcon($0) }
                )
            }
        }
        .onAppear { alternateIconName = UIApplication.shared.alternateIconName }
    }

    private var appRows: some View {
        FSSettingsListSection(rows: [
            FSSettingsRow(icon: "lock.shield.fill", title: String(localized: "Privacy"), subtitle: String(localized: "App lock, push notifications"), action: onOpenPrivacy),
            FSSettingsRow(icon: "info.circle.fill", title: String(localized: "About Flagship"), subtitle: String(localized: "Version, license, source"), action: onOpenAbout),
        ])
    }

    private func setAppIcon(_ name: String?) {
        guard UIApplication.shared.alternateIconName != name else { return }
        UIApplication.shared.setAlternateIconName(name) { error in
            Task { @MainActor in
                alternateIconName = error == nil ? name : UIApplication.shared.alternateIconName
            }
        }
    }

    private func about(c: FSColors) -> some View {
        Text("Flagship • Patent Pending • BUSL-1.1 • Your stuff, on your hardware.")
            .font(FS.font.caption())
            .foregroundColor(c.textMuted)
            .frame(maxWidth: .infinity, alignment: .center)
            .padding(.top, FS.space.s4)
    }

    private var companionRequestsSubtitle: String {
        if pendingCompanionWritesCount == 0 { return String(localized: "Approve writes from docked browsers") }
        if pendingCompanionWritesCount == 1 { return "1 pending write from a docked browser" }
        return String(localized: "\(pendingCompanionWritesCount) pending writes from docked browsers")
    }

    @ViewBuilder
    private func section<C: View>(_ label: String, c: FSColors, @ViewBuilder content: () -> C) -> some View {
        VStack(alignment: .leading, spacing: FS.space.s3) {
            // Indented like the native group headers above and below it.
            FSSectionLabel(label).padding(.leading, FS.space.s4)
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
                    Button(saving ? String(localized: "Saving…") : "Save") {
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

/// The words of Trusted devices → Remove from account (docs/revocation-ui.md).
public enum RemoveDeviceCopy {
    public static let confirm = String(localized: "Remove from account")
    public static func title(_ name: String) -> String { String(localized: "Remove \(name) from your account?") }
    public static let message = String(localized: "It loses access to your account and your servers. The next time it goes online, Flagship erases your account's keys from it.")
    public static let adminRemovedTitle = String(localized: "Change the admin key too?")
    public static let adminRemovedMessage = String(localized: "This device was an admin. If it was added before admins were made by grant, it may hold the admin key itself. Rotate the admin key in Account security.")
    public static let openAccountSecurity = String(localized: "Open Account security")
    public static let question = String(localized: "Could someone else unlock this device?")
    public static let noChoice = String(localized: "No: it's lost and locked, or I erased it")
    public static let yesChoice = String(localized: "Yes, or I'm not sure")
    public static let browserLine = String(localized: "This was a browser. Someone with the computer could try to guess its passphrase, so changing your account key is safer.")

    /// The dialog's message: what removing does, then (when this device can change the key) the question.
    public static func message(for device: SettingsViewModel.DirectoryDevice, canChangeKey: Bool) -> String {
        guard canChangeKey else { return message }
        let browser = device.platformClass == "web" || device.platformClass == "browser"
        return ([message, question] + (browser ? [browserLine] : [])).joined(separator: "\n\n")
    }
    public static let failedTitle = String(localized: "Couldn't remove the device")
}
