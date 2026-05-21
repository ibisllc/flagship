import SwiftUI

@main
struct FlagshipBurnerApp: App {
    var body: some Scene {
        WindowGroup("Flagship Burner") {
            WizardView()
                .frame(minWidth: 760, minHeight: 600)
        }
        .windowResizability(.contentSize)
    }
}
