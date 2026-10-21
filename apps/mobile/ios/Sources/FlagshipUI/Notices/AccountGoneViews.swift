import SwiftUI
import UIKit
import Flagship
import FlagshipCore
import FlagshipAPI

/// The words of "This account was removed" (docs/account-gone.md); the
/// webapp's `ACCOUNT_GONE_COPY` with the phone variants ("device").
public enum AccountGoneCopy {
    public static let title = String(localized: "This account was removed")
    public static let body = String(localized: "This account no longer exists on Flagship. This can happen after a reset.")
    public static let restoreHint = String(localized: "If you saved a backup of your servers, you can restore it into a new account.")
    public static let create = String(localized: "Create a new account")
    public static let remove = String(localized: "Remove it from this device")
    public static func account(_ name: String) -> String { "Account: \(name)" }
    public static let failed = String(localized: "Couldn't remove it yet. Close the app and try again.")
}

/// Where the removal warning and Settings ask "does this device hold a key
/// that can still save a server's data?".
@MainActor
enum RescueKeyCheck {
    static func holdsRescueKey(_ app: AppState) -> Bool {
        var sessions = app.sessionPodIds?.count ?? 0
        #if DEBUG
        if let forced = GymSeams.serverSessionCount { sessions = forced }
        #endif
        return AdminKeyWarning.holdsRescueKey(
            isDemoAccount: app.isDemoAccount,
            hasAdminRoot: holdsAdminRoot,
            serverSessionCount: sessions
        )
    }

    static var holdsAdminRoot: Bool {
        #if DEBUG
        // The mock gym decides by its launch arguments, not by whatever an
        // earlier onboarding walk left in the simulator's keychain.
        if GymLaunch.usesMocks { return GymSeams.forceAdminRoot }
        #endif
        return Keystore.hasAdminRoot
    }
}

/// Forget this device's copy of the gone account: the keys it held (Keychain
/// profile, sealed admin root), the signed-in state, held read tokens and
/// demo session (through `AppState.onSignedOut`). Nothing else on the device
/// and no server is touched.
@MainActor
enum AccountGoneRemoval {
    static func removeCopy(app: AppState, gone: AccountGoneCenter?, thenCreate: Bool) {
        let name = gone?.goneName ?? app.currentUser ?? ""
        Keystore.wipe()
        KeyBackupState.forget(username: name)
        gone?.clear()
        app.openCreateAccountOnWelcome = thenCreate
        app.signOut()
    }
}

struct AccountGoneScreen: View {
    let name: String

    private enum Pending { case create, remove }

    @Environment(\.colorScheme) private var scheme
    @Environment(AppState.self) private var app
    @Environment(AccountGoneCenter.self) private var gone: AccountGoneCenter?
    @State private var pending: Pending?
    @State private var showBackup = false
    @State private var note: String?
    @State private var failure: String?

    var body: some View {
        let c = FSColors.scheme(scheme)
        ZStack {
            c.bg.ignoresSafeArea()
            ScrollView {
                VStack(alignment: .leading, spacing: FS.space.s4) {
                    Text(AccountGoneCopy.title)
                        .font(FS.font.scaled(28, weight: .semibold))
                        .foregroundColor(c.text)
                        .accessibilityAddTraits(.isHeader)
                        .accessibilityIdentifier("account-gone-title")
                    Text(AccountGoneCopy.body)
                        .font(FS.font.scaled(17))
                        .foregroundColor(c.text)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("account-gone-body")
                    Text(AccountGoneCopy.account(name))
                        .font(FS.font.scaled(12))
                        .foregroundColor(c.textMuted)
                        .accessibilityIdentifier("account-gone-name")
                    Text(AccountGoneCopy.restoreHint)
                        .font(FS.font.scaled(15))
                        .foregroundColor(c.text)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("account-gone-restore-hint")
                    if let pending {
                        warning(pending, c: c)
                    } else {
                        VStack(spacing: FS.space.s3) {
                            FSPrimaryButton(AccountGoneCopy.create, block: true, large: true) { ask(.create) }
                                .accessibilityIdentifier("account-gone-create")
                            Button(AccountGoneCopy.remove) { ask(.remove) }
                                .font(FS.font.scaled(15))
                                .foregroundColor(c.textMuted)
                                .frame(minHeight: 44)
                                .accessibilityIdentifier("account-gone-remove")
                        }
                    }
                    if let note {
                        Text(note)
                            .font(FS.font.scaled(14))
                            .foregroundColor(c.textMuted)
                            .fixedSize(horizontal: false, vertical: true)
                            .accessibilityIdentifier("account-gone-note")
                    }
                    if let failure {
                        Text(failure)
                            .font(FS.font.scaled(14))
                            .foregroundColor(c.danger)
                            .accessibilityIdentifier("account-gone-error")
                    }
                }
                .frame(maxWidth: 440, alignment: .leading)
                .padding(.horizontal, FS.space.s6)
                .padding(.vertical, FS.space.s8)
                .frame(maxWidth: .infinity, minHeight: UIScreen.main.bounds.height * 0.8, alignment: .center)
            }
            .scrollBounceBehavior(.basedOnSize)
        }
        .accessibilityElement(children: .contain)
        .accessibilityAddTraits(.isModal)
        .accessibilityIdentifier("account-gone")
        .sheet(isPresented: $showBackup) {
            NavigationStack {
                KeyfileExportScreen(vm: KeyfileExportViewModel(username: name))
                    .toolbar {
                        ToolbarItem(placement: .topBarTrailing) {
                            Button("Done") { showBackup = false }
                                .accessibilityIdentifier("account-gone-backup-done")
                        }
                    }
            }
        }
    }

    /// The removal warning, in place of the buttons: only the named buttons
    /// act, and nothing here dismisses on a tap outside.
    @ViewBuilder
    private func warning(_ pending: Pending, c: FSColors) -> some View {
        let w = AdminKeyWarning.remove
        VStack(alignment: .leading, spacing: FS.space.s3) {
            Text(w.title)
                .font(FS.font.scaled(17, weight: .semibold))
                .foregroundColor(c.text)
                .accessibilityIdentifier("account-gone-warning-title")
            Text(w.message)
                .font(FS.font.scaled(15))
                .foregroundColor(c.text)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("account-gone-warning-message")
            FSSecondaryButton(AdminKeyCopy.saveFirst, block: true, large: true) { Task { await saveFirst() } }
                .accessibilityIdentifier("account-gone-save-first")
            FSDangerButton(AdminKeyCopy.removeAnyway, block: true, large: true) { remove(pending) }
                .accessibilityIdentifier("account-gone-remove-anyway")
        }
    }

    private func ask(_ p: Pending) {
        note = nil
        failure = nil
        if RescueKeyCheck.holdsRescueKey(app) { pending = p } else { remove(p) }
    }

    private func remove(_ p: Pending) {
        AccountGoneRemoval.removeCopy(app: app, gone: gone, thenCreate: p == .create)
    }

    /// Save a backup of the account key before anything is removed: the
    /// existing account-key export. It never removes anything; the warning
    /// stays up.
    @MainActor
    private func saveFirst() async {
        note = nil
        #if DEBUG
        let bypass = GymSeams.bypassBiometricGates
        #else
        let bypass = false
        #endif
        if !(bypass || app.isDemoAccount || Keystore.hasSessionKey()) {
            note = AdminKeyCopy.unlockFirst
            return
        }
        showBackup = true
    }
}

private struct AccountGoneHost: ViewModifier {
    @Environment(AccountGoneCenter.self) private var gone: AccountGoneCenter?
    @Environment(AppState.self) private var app
    @Environment(PrivacySettings.self) private var privacy

    func body(content: Content) -> some View {
        let name = gone?.goneName
        content
            .accessibilityHidden(name != nil)
            // The detector learns which names are this device's own.
            .onChange(of: app.currentUser, initial: true) { _, user in
                gone?.setOwnNames([user, app.activeProfile?.cloudName, app.activeProfile?.accountId])
            }
            .onChange(of: name, initial: true) { _, next in present(next) }
    }

    private func present(_ name: String?) {
        OverlayWindowPresenter.accountGone.sync(key: name.map { AnyHashable($0) }) {
            guard let name else { return AnyView(EmptyView()) }
            return AnyView(
                AccountGoneScreen(name: name)
                    .environment(app)
                    .environment(privacy)
                    .environment(gone)
                    .preferredColorScheme(privacy.themeMode.preferredColorScheme)
            )
        }
    }
}

extension View {
    /// Show "This account was removed" above the whole app when `.com` says
    /// this device's own account no longer exists, and keep the detector told
    /// which account is this device's own.
    public func accountGoneHost() -> some View { modifier(AccountGoneHost()) }
}
