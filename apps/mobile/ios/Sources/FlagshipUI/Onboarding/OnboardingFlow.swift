import SwiftUI
import FlagshipCore

/// Onboarding stack presented as a fullScreenCover over the RootShell
/// when AppState.isPaired == false.
///
///   Welcome
///     ├─ Create your account → ChooseUsername → CreateServer (stub)
///     └─ I already have a server → PodPair (stub)
///
/// Both leaf flows currently call `mockPair(...)` on AppState to drop
/// the user into the main shell with fixture data. Real impls land
/// once the provisioning + pairing wire formats are wired through.
public struct OnboardingFlow: View {
    @Environment(AppState.self) private var app
    @State private var path: [OnboardingRoute] = []

    public init() {}

    public var body: some View {
        NavigationStack(path: $path) {
            WelcomeScreen(
                onCreate:   { path.append(.chooseUsername) },
                onExisting: { path.append(.podPair) }
            )
            .navigationDestination(for: OnboardingRoute.self) { route in
                switch route {
                case .chooseUsername:
                    ChooseUsernameScreen(onContinue: { username in
                        path.append(.createServer(username: username))
                    })
                case .createServer(let username):
                    OnboardingCreateServer(username: username) { name, description in
                        completeMockPair(username: username, name: name, description: description)
                    }
                case .podPair:
                    PodPairScreen(
                        onSubmit: { _, name, description in
                            completeMockPair(username: "guest", name: name, description: description)
                        },
                        onCancel: { path.removeLast() }
                    )
                }
            }
        }
    }

}

private struct OnboardingCreateServer: View {
    let username: String
    let onComplete: (String, String) -> Void
    @Environment(\.flagshipServerClient) private var serverClient
    @Environment(\.qrRelayClient) private var qrRelay
    @State private var vm: CreateServerViewModel?

    var body: some View {
        ZStack {
            FSColors.scheme(.light).bg.ignoresSafeArea()
            if let vm {
                CreateServerStubScreen(
                    vm: vm,
                    onDelivered: { _, n, d in onComplete(n, d) },
                    onDemoComplete: onComplete
                )
            } else { ProgressView() }
        }
        .task {
            if vm == nil {
                vm = CreateServerViewModel(
                    username: username,
                    server: serverClient,
                    relay: qrRelay
                )
            }
        }
    }
}

extension OnboardingFlow {
    fileprivate func completeMockPair(username: String, name: String, description: String) {
        let label = name.isEmpty ? "Home" : name
        let slug = SlugUtil.slugify(label)
        let pods = [
            PodInfo(
                podId: "home",
                name: label,
                description: description.isEmpty ? nil : description,
                fqdn: "\(slug).\(username).flagship.services",
                status: .online
            )
        ]
        app.completeOnboarding(username: username, pods: pods)
    }
}
