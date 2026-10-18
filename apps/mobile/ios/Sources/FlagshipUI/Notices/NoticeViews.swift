import SwiftUI
import UIKit
import Flagship
import FlagshipCore
import FlagshipAPI

/// The app's own store listing. It is a constant of the app, never read from a
/// notice, so a stolen signature cannot send people to a phishing page
/// (docs/security-notices.md section 6.5).
public enum AppStoreListing {
    public static let url = URL(string: "https://apps.apple.com/app/id6768945985")!
}

/// Every string of the banner and the lock screen, from `NOTICE_COPY` in the
/// webapp's `noticeUi.js` (native: the update button is "Update" on the banner
/// and "Update Flagship" on the lock; both open the store listing).
public enum NoticeCopy {
    public static let bannerDismiss = "Dismiss"
    public static let bannerUpdate = "Update"
    public static let lockKicker = "Security update"
    public static let lockTitle = "Update required"
    public static let lockReassure =
        "Your accounts and servers are unchanged and nothing has been deleted. Flagship is paused on this device until you update."
    public static let lockUpdate = "Update Flagship"
    public static let backup = "Back up my account key"
    public static let unlockFirst = "Unlock to back up my account key"
    public static let signOut = "Sign out"
    public static let signedBy = "Signed by the Flagship maintainers"
    public static let updateFailed = "Couldn't update yet. Check your connection and try again."

    public static func why(_ reason: String) -> String { reason.isEmpty ? "" : "Why: \(reason)" }
    public static func meta(advisoryId: String) -> String { "Advisory \(advisoryId) · \(signedBy)" }
}

// MARK: - Banner

/// One banner above the main content, below the status bar: a maintenance
/// notice, or the update nag (an advisory, or the grace window of an
/// update-required). Hidden under the biometric lock like the other slivers.
public struct NoticeBannerView: View {
    @Environment(\.colorScheme) private var scheme
    @Environment(SecurityNoticeCenter.self) private var notices: SecurityNoticeCenter?
    @Environment(AppState.self) private var app

    public init() {}

    public var body: some View {
        if let notices, app.isUnlocked, notices.bannerVisible, case let .banner(style, notice) = notices.outcome {
            let c = FSColors.scheme(scheme)
            let tint = style == .update ? c.warning : c.accent
            HStack(alignment: .top, spacing: 0) {
                Rectangle().fill(tint).frame(width: 4)
                VStack(alignment: .leading, spacing: FS.space.s3) {
                    Text(notice.text())
                        .font(FS.font.body())
                        .foregroundColor(c.text)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("notice-banner-text")
                    HStack(spacing: FS.space.s3) {
                        if style == .update {
                            Button {
                                UIApplication.shared.open(AppStoreListing.url)
                            } label: {
                                Text(NoticeCopy.bannerUpdate)
                                    .font(FS.font.scaled(15, weight: .semibold))
                                    .frame(minWidth: 44, minHeight: 44)
                                    .padding(.horizontal, FS.space.s3)
                                    .background(c.primaryFill)
                                    .foregroundColor(c.onPrimary)
                                    .clipShape(RoundedRectangle(cornerRadius: FS.radius.sm, style: .continuous))
                            }
                            .accessibilityIdentifier("notice-banner-update")
                        }
                        Button {
                            notices.dismissBanner()
                        } label: {
                            Text(NoticeCopy.bannerDismiss)
                                .font(FS.font.scaled(15, weight: .semibold))
                                .frame(minWidth: 44, minHeight: 44)
                                .padding(.horizontal, FS.space.s3)
                                .foregroundColor(c.text)
                                .overlay(RoundedRectangle(cornerRadius: FS.radius.sm, style: .continuous).stroke(c.border, lineWidth: 1))
                        }
                        .accessibilityIdentifier("notice-banner-dismiss")
                    }
                }
                .padding(FS.space.s3)
                Spacer(minLength: 0)
            }
            .background(style == .update ? c.warningWash : c.surface)
            .overlay(Rectangle().stroke(c.border, lineWidth: 0.5))
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("notice-banner")
        }
    }
}

// MARK: - Lock screen

/// The lock screen's contents for a notice, as plain strings, so a test can
/// read exactly what a person reads.
public struct UpdateLockModel: Equatable {
    public let kicker: String
    public let title: String
    public let body: String
    public let why: String
    public let reassure: String
    public let update: String
    public let backup: String
    public let signOut: String
    public let meta: String

    public init(notice: SecurityNotice, accountUnlocked: Bool, formatDate: (Date) -> String = SecurityNotice.localDate) {
        kicker = NoticeCopy.lockKicker
        title = NoticeCopy.lockTitle
        body = notice.text(formatDate: formatDate)
        why = NoticeCopy.why(notice.reason)
        reassure = NoticeCopy.lockReassure
        update = NoticeCopy.lockUpdate
        backup = accountUnlocked ? NoticeCopy.backup : NoticeCopy.unlockFirst
        signOut = NoticeCopy.signOut
        meta = NoticeCopy.meta(advisoryId: notice.advisoryId)
    }
}

/// Full screen "Update required". It replaces the whole app UI, keeps three
/// things reachable (the update, the account key backup and Sign out) and
/// deletes nothing.
struct UpdateLockScreen: View {
    let notice: SecurityNotice

    @Environment(\.colorScheme) private var scheme
    @Environment(AppState.self) private var app
    @State private var showBackup = false
    @State private var confirmSignOut = false
    @State private var failure: String?

    private var accountUnlocked: Bool {
        #if DEBUG
        // The mock gym has no enrolled biometric: its consent prompts are bypassed.
        if GymSeams.bypassBiometricGates { return true }
        #endif
        return app.isDemoAccount || Keystore.hasSessionKey()
    }

    var body: some View {
        let c = FSColors.scheme(scheme)
        let m = UpdateLockModel(notice: notice, accountUnlocked: accountUnlocked)
        ZStack {
            c.bg.ignoresSafeArea()
            ScrollView {
                VStack(alignment: .leading, spacing: FS.space.s4) {
                    Text(m.kicker)
                        .font(FS.font.mono())
                        .textCase(.uppercase)
                        .foregroundColor(c.textMuted)
                        .accessibilityIdentifier("update-lock-kicker")
                    Text(m.title)
                        .font(FS.font.scaled(28, weight: .semibold))
                        .foregroundColor(c.text)
                        .accessibilityAddTraits(.isHeader)
                        .accessibilityIdentifier("update-lock-title")
                    Text(m.body)
                        .font(FS.font.scaled(17))
                        .foregroundColor(c.text)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("update-lock-body")
                    if !m.why.isEmpty {
                        Text(m.why)
                            .font(FS.font.scaled(15))
                            .foregroundColor(c.textMuted)
                            .fixedSize(horizontal: false, vertical: true)
                            .accessibilityIdentifier("update-lock-why")
                    }
                    Text(m.reassure)
                        .font(FS.font.scaled(14))
                        .foregroundColor(c.textMuted)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("update-lock-reassure")
                    VStack(spacing: FS.space.s3) {
                        FSPrimaryButton(m.update, block: true, large: true) { openStore() }
                            .accessibilityIdentifier("update-lock-update")
                        if app.isPaired {
                            FSSecondaryButton(m.backup, block: true, large: true) { Task { await backupKey() } }
                                .accessibilityIdentifier("update-lock-backup")
                            FSSecondaryButton(m.signOut, block: true, large: true) { confirmSignOut = true }
                                .accessibilityIdentifier("update-lock-signout")
                        }
                    }
                    if let failure {
                        Text(failure)
                            .font(FS.font.scaled(14))
                            .foregroundColor(c.danger)
                            .fixedSize(horizontal: false, vertical: true)
                            .accessibilityIdentifier("update-lock-failure")
                    }
                    Text(m.meta)
                        .font(FS.font.scaled(12))
                        .foregroundColor(c.textMuted.opacity(0.8))
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("update-lock-meta")
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
        .accessibilityIdentifier("update-lock")
        .sheet(isPresented: $showBackup) {
            NavigationStack {
                KeyfileExportScreen(vm: KeyfileExportViewModel(username: app.currentUser ?? ""))
                    .toolbar {
                        ToolbarItem(placement: .topBarTrailing) {
                            Button("Done") { showBackup = false }
                                .accessibilityIdentifier("update-lock-backup-done")
                        }
                    }
            }
        }
        .confirmationDialog(
            app.hasCloudRecovery ? "Sign out of this device?" : "Sign out without recovery?",
            isPresented: $confirmSignOut,
            titleVisibility: .visible
        ) {
            Button(app.hasCloudRecovery || app.isDemoAccount ? "Sign out" : "Sign out anyway", role: .destructive) {
                Keystore.wipe()
                app.signOut()
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text(app.hasCloudRecovery || app.isDemoAccount
                ? "This erases this device's account key and returns you to the start. Sign back in with your recovery passkey to restore it. Your account and servers stay put."
                : "You have no cloud recovery set up. Erasing this device's key with no backup means there's no way to sign back in. Back up your account key first.")
        }
    }

    private func openStore() {
        failure = nil
        UIApplication.shared.open(AppStoreListing.url) { opened in
            if !opened { failure = NoticeCopy.updateFailed }
        }
    }

    /// The same ceremony as Settings, above the lock. An account not yet
    /// unlocked this session steps through the same Face ID first.
    @MainActor
    private func backupKey() async {
        failure = nil
        if !accountUnlocked {
            do {
                let context = try await BiometricGate().evaluateReturningContext(reason: "Unlock Flagship")
                Keystore.cacheSessionUMK(authenticatedBy: context)
            } catch {
                failure = BiometricLockScreen.message(for: error)
                return
            }
        }
        showBackup = true
    }
}

// MARK: - Presenting a full-screen state above everything

/// A full-screen state is its own window above every other: sheets, menus,
/// the onboarding cover and the biometric lock all live in the app window (or
/// presented from it), so nothing can stay open and operable on top of it, and
/// it cannot be swiped away. Showing it first runs the lock sweep. Used by the
/// "Update required" lock and the "This account was removed" screen.
@MainActor
final class OverlayWindowPresenter {
    static let updateLock = OverlayWindowPresenter(level: .alert + 1)
    static let accountGone = OverlayWindowPresenter(level: .alert + 2)

    private let level: UIWindow.Level
    private var window: UIWindow?
    private(set) var shownKey: AnyHashable?

    init(level: UIWindow.Level) { self.level = level }

    var isShown: Bool { window != nil }

    /// Show `content` while `key` is non-nil (a new key replaces what is shown); hide it on nil.
    func sync(key: AnyHashable?, content: () -> AnyView) {
        guard let key else { hide(); return }
        if window != nil, shownKey == key { return }
        if window == nil {
            // Nothing of a menu, dialog or sheet stays open behind it.
            PresentationSweeper.dismissAll()
        }
        guard let scene = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene })
            .first(where: { $0.activationState == .foregroundActive })
            ?? UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).first else { return }
        let host = UIHostingController(rootView: content())
        host.view.accessibilityViewIsModal = true
        host.view.backgroundColor = .systemBackground
        let w = window ?? UIWindow(windowScene: scene)
        w.windowLevel = level
        w.rootViewController = host
        w.accessibilityViewIsModal = true
        w.isHidden = false
        w.makeKeyAndVisible()
        window = w
        shownKey = key
    }

    func hide() {
        guard let w = window else { return }
        w.isHidden = true
        w.rootViewController = nil
        let scene = w.windowScene
        window = nil
        shownKey = nil
        scene?.windows.first(where: { !$0.isHidden })?.makeKey()
    }
}

private struct UpdateLockHost: ViewModifier {
    @Environment(SecurityNoticeCenter.self) private var notices: SecurityNoticeCenter?
    @Environment(AppState.self) private var app
    @Environment(PrivacySettings.self) private var privacy

    /// The lock yields to the biometric unlock screen: an unlock surface is
    /// never blocked, and the lock returns the moment the app is unlocked.
    private var lockNotice: SecurityNotice? {
        guard let notices, case let .lock(notice) = notices.outcome else { return nil }
        if app.isPaired && !app.isUnlocked { return nil }
        return notice
    }

    func body(content: Content) -> some View {
        let notice = lockNotice
        content
            .accessibilityHidden(notice != nil)
            .onChange(of: notice, initial: true) { _, next in present(next) }
    }

    private func present(_ notice: SecurityNotice?) {
        OverlayWindowPresenter.updateLock.sync(key: notice.map { AnyHashable($0.seq) }) {
            guard let notice else { return AnyView(EmptyView()) }
            return AnyView(
                UpdateLockScreen(notice: notice)
                    .environment(app)
                    .environment(privacy)
                    .preferredColorScheme(privacy.themeMode.preferredColorScheme)
            )
        }
    }
}

extension View {
    /// Show the "Update required" lock above the whole app while a verified
    /// notice locks this build.
    public func updateLockHost() -> some View { modifier(UpdateLockHost()) }
}
