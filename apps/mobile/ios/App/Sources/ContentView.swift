import SwiftUI
import FlagshipCore
import FlagshipUI

struct ContentView: View {
    @Environment(AppState.self) private var app

    var body: some View {
        ZStack {
            if app.isPaired {
                RootShell()
            } else {
                Color.clear
            }
        }
        .fullScreenCover(isPresented: Binding(
            get: { !app.isPaired },
            set: { _ in /* read-only — onboarding sets paired itself */ }
        )) {
            OnboardingFlow()
                .environment(app)
        }
    }
}
