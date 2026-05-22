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

    @State private var selected: RootDestination

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
            // B12 — top overlay. The lock screen renders ABOVE the
            // shell whenever the user requires biometric-at-launch
            // and the runtime latch is false. Putting it inside the
            // shell's ZStack (not as a presentation-style overlay)
            // means it traps interaction without a transition flash.
            if app.requireBiometricAtLaunch && !app.isUnlocked {
                BiometricLockScreen()
                    .transition(.opacity)
                    .zIndex(10)
            }
        }
        .onChange(of: linker.pending) { _, link in
            if let link {
                selected = tab(for: link)
            }
        }
        .task(id: linker.pending) {
            if let link = linker.pending {
                selected = tab(for: link)
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
    }

    /// Tab that owns a given deep-link target. Inner navigation
    /// (NavigationStack push) is handled by the tab itself when it
    /// reads the same `linker.pending` value.
    private func tab(for link: DeepLink) -> RootDestination {
        switch link {
        case .unlockApprove, .unlockApprovalsList:   return .activity
        case .serverDetail, .createServer:            return .home
        case .appDetail, .marketplace, .vibeCodeChat: return .apps
        case .recoverySetup, .joinAccount:            return .settings
        }
    }
}

// MARK: - iPhone (TabView)

private struct iPhoneShell: View {
    @Binding var selected: RootDestination

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
        .tint(FSColors.scheme(.light).primary)
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
