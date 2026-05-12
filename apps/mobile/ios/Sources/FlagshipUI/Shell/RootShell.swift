import SwiftUI
import FlagshipCore
import FlagshipAPI

/// Adaptive root shell. On iPhone (compact horizontal size class) renders
/// a TabView with a bottom tab bar; on iPad / Mac (regular) it renders a
/// NavigationSplitView with a sidebar. Each top-level destination has its
/// own NavigationStack so drill-downs stay scoped.
public struct RootShell: View {
    @Environment(\.horizontalSizeClass) private var sizeClass
    @Environment(\.screensClient) private var client
    @Environment(AppState.self) private var app

    @State private var selected: RootDestination = .home

    public init() {}

    public var body: some View {
        if sizeClass == .regular {
            iPadShell(selected: $selected)
        } else {
            iPhoneShell(selected: $selected)
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

// MARK: - iPad (NavigationSplitView)

private struct iPadShell: View {
    @Binding var selected: RootDestination
    @Environment(\.colorScheme) private var scheme
    @Environment(AppState.self) private var app
    @State private var columnVisibility: NavigationSplitViewVisibility = .all

    var body: some View {
        let c = FSColors.scheme(scheme)
        NavigationSplitView(columnVisibility: $columnVisibility) {
            sidebar(c: c)
        } detail: {
            destinationContent(selected)
        }
        .navigationSplitViewStyle(.balanced)
        .tint(c.primary)
    }

    private func sidebar(c: FSColors) -> some View {
        let optionalSelection = Binding<RootDestination?>(
            get: { selected },
            set: { selected = $0 ?? .home }
        )
        return List(selection: optionalSelection) {
            Section {
                VStack(alignment: .leading, spacing: 4) {
                    Text(app.currentUser ?? "")
                        .font(.system(size: 17, weight: .semibold))
                        .foregroundColor(c.text)
                    Text("\(app.pods.count) \(app.pods.count == 1 ? "server" : "servers")")
                        .font(FS.font.caption())
                        .foregroundColor(c.textMuted)
                }
                .padding(.vertical, 6)
            }
            Section("Destinations") {
                ForEach(RootDestination.allCases) { dest in
                    Label(dest.title, systemImage: dest.systemImage)
                        .tag(dest)
                }
            }
        }
        .listStyle(.sidebar)
        .navigationTitle("Flagship")
    }
}

// MARK: - Destination dispatch

@ViewBuilder
private func destinationContent(_ dest: RootDestination) -> some View {
    switch dest {
    case .home:     HomeTab()
    case .apps:     AppsTab()
    case .activity: ActivityTab()
    case .settings: SettingsTab()
    }
}
