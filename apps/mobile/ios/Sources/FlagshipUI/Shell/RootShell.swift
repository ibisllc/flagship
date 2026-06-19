import SwiftUI
import FlagshipCore
import FlagshipAPI

/// Adaptive root shell.
///
/// iPhone (compact): bottom TabView; each tab owns its own
/// NavigationStack(path:).
///
/// iPad (regular): custom HStack-based sidebar + main panel. We avoid
/// nesting NavigationStack inside NavigationSplitView's detail column —
/// SwiftUI asserts on `NavigationColumnState.boundPathChange` when the
/// sidebar selection changes a tab that owns a bound path, so we
/// sidestep the conflict by composing the layout manually.
public struct RootShell: View {
    @Environment(\.horizontalSizeClass) private var sizeClass
    @Environment(\.scenePhase) private var scenePhase
    @Environment(DeepLinker.self) private var linker
    @Environment(AppState.self) private var app
    @Environment(PrivacySettings.self) private var privacy

    @State private var selected: RootDestination
    /// #92 — a friend redeem invite is presented as a full-screen cover
    /// (account-agnostic, independent of the tab nav stacks).
    @State private var pendingRedeem: RedeemTarget?
    /// Web-experience gating — a knock-authorize (QR-login for a restricted
    /// site) is presented the same way: a full-screen cover, account-agnostic,
    /// gated behind the lock screen until the visitor unlocks (they AID-sign).
    @State private var pendingKnock: KnockTarget?

    private struct RedeemTarget: Identifiable, Equatable {
        let serverDomain: String
        let secretHex: String
        var id: String { "\(serverDomain)#\(secretHex)" }
    }

    private struct KnockTarget: Identifiable, Equatable {
        let serverDomain: String
        let svc: String
        let serviceRef: String
        let pageId: String
        var id: String { "\(serverDomain)#\(serviceRef)#\(pageId)" }
    }

    public init(initialDestination: RootDestination = .home) {
        _selected = State(initialValue: initialDestination)
    }

    public var body: some View {
        ZStack {
            Group {
                if sizeClass == .regular {
                    iPadShell(selected: $selected)
                } else {
                    iPhoneShell(selected: $selected)
                }
            }
            // The global operations sliver lives in the top safe-area inset
            // so it physically slides the whole shell (every tab + its nav
            // stack) DOWN to reveal itself — WhatsApp's active-call bar — and
            // collapses to zero height (no push) when idle. One mount covers
            // both the iPhone TabView and the iPad sidebar layout.
            .safeAreaInset(edge: .top, spacing: 0) {
                // The trust sliver sits ABOVE the operations sliver: a degraded
                // maintainer-trust state is higher priority than any running
                // operation, and both push the shell down from the top.
                VStack(spacing: 0) {
                    GlobalTrustBar()
                    GlobalOperationsBar()
                }
            }
            // B12 — top overlay. The lock screen renders ABOVE the
            // shell whenever the runtime unlock latch is false. Putting
            // it inside the shell's ZStack (not as a presentation-style
            // overlay) means it traps interaction without a transition
            // flash.
            //
            // The latch is false in two cases: (a) the user requires
            // biometric-at-launch and `relockForBackground()` re-armed it,
            // or (b) the user explicitly tapped Lock (`AppState.lock()`),
            // which re-gates regardless of the launch preference. Gating on
            // the latch ALONE (not also `requireBiometricAtLaunch`) is what
            // lets an explicit Lock work even when auto-lock is off — the
            // latch starts `true` when the preference is off, so nothing
            // else flips it spuriously.
            if !app.isUnlocked {
                BiometricLockScreen()
                    .transition(.opacity)
                    .zIndex(10)
            }
        }
        .onChange(of: linker.pending) { _, link in
            if let link { route(link) }
        }
        .task(id: linker.pending) {
            if let link = linker.pending { route(link) }
        }
        .fullScreenCover(item: $pendingRedeem) { target in
            NavigationStack {
                InviteRedeemScreen(
                    serverDomain: target.serverDomain,
                    secretHex: target.secretHex,
                    onOpenService: { _ in pendingRedeem = nil },
                    onDone: { pendingRedeem = nil }
                )
                .toolbar {
                    ToolbarItem(placement: .topBarLeading) {
                        Button("Close") { pendingRedeem = nil }
                    }
                }
            }
        }
        .fullScreenCover(item: $pendingKnock) { target in
            NavigationStack {
                KnockAuthorizeScreen(
                    serverDomain: target.serverDomain,
                    svc: target.svc,
                    serviceRef: target.serviceRef,
                    pageId: target.pageId,
                    onDone: { pendingKnock = nil }
                )
                .toolbar {
                    ToolbarItem(placement: .topBarLeading) {
                        Button("Close") { pendingKnock = nil }
                    }
                }
            }
        }
        // B12 — re-lock when the app moves to background. The .inactive
        // intermediate state happens during transitions (notification
        // pull-down, control center) — we DON'T relock on .inactive
        // because that would dump the user back to Face ID mid-task.
        // Only the hard .background transition (app actually backgrounded)
        // re-arms the gate.
        .onChange(of: scenePhase) { _, phase in
            if phase == .background {
                app.relockForBackground()
            }
        }
        // #92 — a redeem invite that arrived while locked is held in the
        // linker; replay it once the friend unlocks (they sign with their AID).
        .onChange(of: app.isUnlocked) { _, unlocked in
            if unlocked, let link = linker.pending { route(link) }
        }
        // Appearance override (Settings → Appearance). `auto` ⇒ nil ⇒ follow the
        // system; light/dark force the scheme app-wide. Every view that reads
        // `@Environment(\.colorScheme)` + `FSColors.scheme(scheme)` then resolves
        // to the chosen palette.
        .preferredColorScheme(privacy.themeMode.preferredColorScheme)
    }

    /// Route a freshly-arrived deep link. The friend-redeem invite is consumed
    /// here into a full-screen cover (account-agnostic); every other link
    /// selects the owning tab and is consumed by that tab's own router.
    private func route(_ link: DeepLink) {
        if case let .inviteRedeem(serverDomain, secretHex) = link {
            // Hold the link behind the lock screen until the friend is
            // unlocked (they sign the redeem with their own AID).
            guard app.isUnlocked else { return }
            _ = linker.consume()
            pendingRedeem = RedeemTarget(serverDomain: serverDomain, secretHex: secretHex)
            return
        }
        if case let .knockAuthorize(serverDomain, svc, serviceRef, pageId) = link {
            // Same as redeem: hold behind the lock screen until the visitor is
            // unlocked (they AID-sign the authorization with their own AID).
            guard app.isUnlocked else { return }
            _ = linker.consume()
            pendingKnock = KnockTarget(serverDomain: serverDomain, svc: svc, serviceRef: serviceRef, pageId: pageId)
            return
        }
        selected = tab(for: link)
    }

    /// Tab that owns a given deep-link target. Inner navigation
    /// (NavigationStack push) is handled by the tab itself when it
    /// reads the same `linker.pending` value.
    private func tab(for link: DeepLink) -> RootDestination {
        switch link {
        case .secretRequests:                         return .activity
        case .serverDetail, .createServer:            return .home
        case .appDetail, .vibeCodeChat, .startVibeCode: return .apps
        case .recoverySetup, .joinAccount:            return .settings
        case .inviteRedeem, .knockAuthorize:          return selected
        }
    }
}

/// Maps the persisted appearance choice to a SwiftUI scheme override.
/// `auto` returns nil so the system appearance is honoured.
public extension PrivacySettings.ThemeMode {
    var preferredColorScheme: ColorScheme? {
        switch self {
        case .auto: return nil
        case .light: return .light
        case .dark: return .dark
        }
    }
}

// MARK: - iPhone (TabView)

private struct iPhoneShell: View {
    @Binding var selected: RootDestination
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        TabView(selection: $selected) {
            ForEach(RootDestination.allCases) { dest in
                destinationContent(dest)
                    .tabItem {
                        Label(dest.title, systemImage: dest.systemImage)
                    }
                    .tag(dest)
            }
        }
        .tint(FSColors.scheme(scheme).primary)
    }
}

// MARK: - iPad (custom sidebar + content)

private struct iPadShell: View {
    @Binding var selected: RootDestination
    @Environment(\.colorScheme) private var scheme
    @Environment(AppState.self) private var app

    var body: some View {
        let c = FSColors.scheme(scheme)
        HStack(spacing: 0) {
            Sidebar(selected: $selected, app: app, c: c)
                .frame(width: 280)
                .background(c.sidebar)
                // Addressable so the gym's iPad pass can assert the regular
                // (iPad) shell renders the 280pt sidebar — and NOT the iPhone
                // TabView — at the iPad destination (§7-C, D8). iPhone (compact)
                // never builds this branch, so the id is iPad-only by construction.
                .accessibilityIdentifier("ipad-sidebar")
            Divider()
            destinationContent(selected)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .tint(c.primary)
    }
}

private struct Sidebar: View {
    @Binding var selected: RootDestination
    let app: AppState
    let c: FSColors

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 4) {
                Text("Flagship")
                    .font(.system(size: 28, weight: .bold))
                    .foregroundColor(c.text)
                if let user = app.currentUser {
                    Text(user)
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundColor(c.text)
                    Text("\(app.pods.count) \(app.pods.count == 1 ? "server" : "servers")")
                        .font(FS.font.caption())
                        .foregroundColor(c.textMuted)
                }
            }
            .padding(.horizontal, FS.space.s6)
            .padding(.top, FS.space.s8)
            .padding(.bottom, FS.space.s6)

            Text("DESTINATIONS")
                .font(.system(size: 11, weight: .semibold))
                .tracking(1)
                .foregroundColor(c.textMuted)
                .padding(.horizontal, FS.space.s6)
                .padding(.bottom, FS.space.s2)

            VStack(spacing: 2) {
                ForEach(RootDestination.allCases) { dest in
                    SidebarRow(dest: dest, isSelected: dest == selected, c: c) {
                        selected = dest
                    }
                }
            }
            .padding(.horizontal, FS.space.s3)
            .background(Color.clear)

            Spacer()
        }
    }
}

private struct SidebarRow: View {
    let dest: RootDestination
    let isSelected: Bool
    let c: FSColors
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: FS.space.s3) {
                Image(systemName: dest.systemImage)
                    .foregroundColor(isSelected ? c.primary : c.textMuted)
                    .frame(width: 22)
                Text(dest.title)
                    .font(.system(size: 15, weight: isSelected ? .semibold : .regular))
                    .foregroundColor(isSelected ? c.text : c.textMuted)
                Spacer()
            }
            .padding(.horizontal, FS.space.s3)
            .padding(.vertical, FS.space.s2)
            .background(isSelected ? Color.white.opacity(0.85) : Color.clear)
            .clipShape(RoundedRectangle(cornerRadius: FS.radius.sm))
        }
        .buttonStyle(.plain)
    }
}

// MARK: - Destination dispatch

@ViewBuilder
private func destinationContent(_ dest: RootDestination) -> some View {
    switch dest {
    case .home:     HomeTab()
    case .apps:     ServicesTab()
    case .activity: ActivityTab()
    case .settings: SettingsTab()
    }
}
