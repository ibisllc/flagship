import SwiftUI
import UIKit
import CryptoKit
import Flagship
import FlagshipCore
import FlagshipAPI

// docs/abuse-handling.md §4-§5: an operator's notice about a report (Home banner, admin devices only) and
// "This account was suspended" (every device). Nothing here is given to an AI.

extension OverlayWindowPresenter {
    static let accountSuspended = OverlayWindowPresenter(level: .alert + 1)
}

/// The blocks Home shows above the server list: the suspended line (once the full screen was put aside) and
/// each notice (admin devices only).
public struct AbuseNoticeHomeSection: View {
    @Environment(\.colorScheme) private var scheme
    @Environment(AppState.self) private var app
    @Environment(AbuseNoticeCenter.self) private var center: AbuseNoticeCenter?
    @Environment(\.flagshipServerClient) private var client
    @State private var doneFor: AbuseNoticeBannerModel?

    public init() {}

    public var body: some View {
        let c = FSColors.scheme(scheme)
        if let center {
            VStack(alignment: .leading, spacing: FS.space.s3) {
                if center.isSuspended && center.suspendedScreenDismissed {
                    suspendedLine(c: c, center: center)
                }
                ForEach(AbuseNoticeBannerModel.banners(center.notices, isAdminDevice: AdminOrderGate.allows(app))) { m in
                    noticeCard(m, c: c)
                }
            }
            .sheet(item: $doneFor) { m in
                AbuseNoticeDoneSheet(noticeId: m.id) { doneFor = nil }
                    .environment(center)
            }
        }
    }

    private func suspendedLine(c: FSColors, center: AbuseNoticeCenter) -> some View {
        HStack(spacing: FS.space.s3) {
            Image(systemName: "exclamationmark.octagon.fill").foregroundColor(c.danger)
            Text(AbuseCopy.suspendedBanner)
                .font(FS.font.scaled(15, weight: .semibold))
                .foregroundColor(c.text)
            Spacer(minLength: 0)
            Button(AbuseCopy.details) { center.showSuspendedScreen() }
                .font(FS.font.scaled(15, weight: .semibold))
                .frame(minHeight: 44)
                .accessibilityIdentifier("account-suspended-details")
        }
        .padding(FS.space.s3)
        .background(c.dangerWash)
        .clipShape(RoundedRectangle(cornerRadius: FS.radius.md, style: .continuous))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("account-suspended-banner")
    }

    private func noticeCard(_ m: AbuseNoticeBannerModel, c: FSColors) -> some View {
        VStack(alignment: .leading, spacing: FS.space.s2) {
            Label(m.title, systemImage: "exclamationmark.triangle.fill")
                .font(FS.font.scaled(17, weight: .semibold))
                .foregroundColor(c.text)
                .accessibilityIdentifier("abuse-notice-title")
            Text(m.reported).foregroundColor(c.text).accessibilityIdentifier("abuse-notice-subject")
            Text(m.reason).foregroundColor(c.text)
            Text(m.todo).foregroundColor(c.text)
            Text(m.deadline).font(FS.font.scaled(15, weight: .semibold)).foregroundColor(c.text)
                .accessibilityIdentifier("abuse-notice-deadline")
            if let detail = m.detail {
                Text(detail).foregroundColor(c.textMuted).accessibilityIdentifier("abuse-notice-detail")
            }
            if let done = m.doneLine {
                Text(done).foregroundColor(c.textMuted).accessibilityIdentifier("abuse-notice-done-line")
            } else {
                Text(m.warning).foregroundColor(c.textMuted)
            }
            HStack(spacing: FS.space.s3) {
                if m.showsDoneButton {
                    FSPrimaryButton(AbuseCopy.done) { doneFor = m }
                        .accessibilityIdentifier("abuse-notice-done")
                }
                FSSecondaryButton(AbuseCopy.appeal) {
                    UIApplication.shared.open(AbuseCopy.appealURL(username: app.currentUser))
                }
                .accessibilityIdentifier("abuse-notice-appeal")
            }
        }
        .font(FS.font.scaled(15))
        .fixedSize(horizontal: false, vertical: true)
        .padding(FS.space.s4)
        .background(c.warningWash)
        .clipShape(RoundedRectangle(cornerRadius: FS.radius.md, style: .continuous))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("abuse-notice")
    }
}

/// "Tell us what you changed": an optional note, then the admin signs `flagship/abuse-notice-done/v1`.
struct AbuseNoticeDoneSheet: View {
    let noticeId: String
    let onClose: () -> Void

    @Environment(\.colorScheme) private var scheme
    @Environment(AbuseNoticeCenter.self) private var center
    @Environment(\.flagshipServerClient) private var client
    @State private var note = ""
    @State private var sending = false
    @State private var failure: String?

    var body: some View {
        let c = FSColors.scheme(scheme)
        NavigationStack {
            VStack(alignment: .leading, spacing: FS.space.s4) {
                TextField(AbuseCopy.doneNotePlaceholder, text: $note, axis: .vertical)
                    .lineLimit(3...8)
                    .textFieldStyle(.roundedBorder)
                    .accessibilityIdentifier("abuse-notice-done-note")
                if let failure {
                    Text(failure).font(FS.font.scaled(14)).foregroundColor(c.danger)
                        .accessibilityIdentifier("abuse-notice-done-error")
                }
                FSPrimaryButton(AbuseCopy.send, enabled: !sending, block: true, large: true) { Task { await send() } }
                    .accessibilityIdentifier("abuse-notice-done-send")
                Spacer()
            }
            .padding(FS.space.s6)
            .navigationTitle(AbuseCopy.doneTitle)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { onClose() }
                }
            }
        }
    }

    @MainActor
    private func send() async {
        sending = true
        failure = nil
        defer { sending = false }
        let key: Curve25519.Signing.PrivateKey
        do {
            key = try await Keystore.sensitiveOrderSigningKey(reason: AbuseCopy.done)
        } catch {
            failure = AbuseCopy.sendFailed
            return
        }
        switch await center.markDone(noticeId: noticeId, note: note, key: key, client: client) {
        case .sent: onClose()
        case .notAdmin: failure = AbuseCopy.notAdmin
        case .failed: failure = AbuseCopy.sendFailed
        }
    }
}

/// Full screen "This account was suspended", on every device. "Continue to my data" puts it aside for the session
/// (backups and LAN rescue stay reachable); Home then keeps a line with Details.
struct AccountSuspendedScreen: View {
    let model: AccountSuspendedModel
    let onContinue: () -> Void

    @Environment(\.colorScheme) private var scheme

    var body: some View {
        let c = FSColors.scheme(scheme)
        ZStack {
            c.bg.ignoresSafeArea()
            ScrollView {
                VStack(alignment: .leading, spacing: FS.space.s4) {
                    Text(model.title)
                        .font(FS.font.scaled(28, weight: .semibold))
                        .foregroundColor(c.text)
                        .accessibilityAddTraits(.isHeader)
                        .accessibilityIdentifier("account-suspended-title")
                    Text(model.reason)
                        .font(FS.font.scaled(17, weight: .semibold))
                        .foregroundColor(c.text)
                        .accessibilityIdentifier("account-suspended-reason")
                    if let r = model.operatorReason {
                        Text(r).font(FS.font.scaled(17)).foregroundColor(c.text)
                            .accessibilityIdentifier("account-suspended-operator-reason")
                    }
                    Text(model.offline).font(FS.font.scaled(15)).foregroundColor(c.text)
                    Text(model.data).font(FS.font.scaled(15)).foregroundColor(c.text)
                        .accessibilityIdentifier("account-suspended-data")
                    Text(model.appeal).font(FS.font.scaled(15)).foregroundColor(c.textMuted)
                    VStack(spacing: FS.space.s3) {
                        FSPrimaryButton(model.appealButton, block: true, large: true) {
                            UIApplication.shared.open(model.appealURL)
                        }
                        .accessibilityIdentifier("account-suspended-appeal")
                        FSSecondaryButton(model.continueButton, block: true, large: true) { onContinue() }
                            .accessibilityIdentifier("account-suspended-continue")
                    }
                }
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: 440, alignment: .leading)
                .padding(.horizontal, FS.space.s6)
                .padding(.vertical, FS.space.s8)
                .frame(maxWidth: .infinity, minHeight: UIScreen.main.bounds.height * 0.8, alignment: .center)
            }
            .scrollBounceBehavior(.basedOnSize)
        }
        .accessibilityElement(children: .contain)
        .accessibilityAddTraits(.isModal)
        .accessibilityIdentifier("account-suspended")
    }
}

private struct AbuseNoticeHost: ViewModifier {
    @Environment(AbuseNoticeCenter.self) private var center: AbuseNoticeCenter?
    @Environment(AppState.self) private var app
    @Environment(PrivacySettings.self) private var privacy
    @Environment(\.flagshipServerClient) private var client
    @Environment(\.scenePhase) private var scenePhase

    func body(content: Content) -> some View {
        let shown = (center?.showsSuspendedScreen ?? false) && app.isPaired && app.isUnlocked
        content
            .task(id: app.isPaired ? app.currentUser : nil) { await refresh() }
            .onChange(of: scenePhase) { _, phase in
                if phase == .active { Task { await refresh() } }
            }
            .onReceive(NotificationCenter.default.publisher(for: AbuseNoticeEvents.refresh)) { _ in
                Task { await refresh() }
            }
            .onChange(of: shown, initial: true) { _, next in present(next) }
    }

    @MainActor
    private func refresh() async {
        guard let center else { return }
        await center.refresh(username: app.isPaired ? app.currentUser : nil, client: client)
    }

    private func present(_ shown: Bool) {
        OverlayWindowPresenter.accountSuspended.sync(key: shown ? AnyHashable(center?.suspension?.suspendedAt ?? 0) : nil) {
            guard shown, let center, let s = center.suspension else { return AnyView(EmptyView()) }
            return AnyView(
                AccountSuspendedScreen(model: AccountSuspendedModel(suspension: s, username: app.currentUser)) {
                    center.dismissSuspendedScreen()
                }
                .preferredColorScheme(privacy.themeMode.preferredColorScheme)
            )
        }
    }
}

extension View {
    /// Read this account's abuse notices and suspension (sign-in, foreground, an `abuse-notice` push) and show
    /// "This account was suspended" above the whole app while it is.
    public func abuseNoticeHost() -> some View { modifier(AbuseNoticeHost()) }
}
