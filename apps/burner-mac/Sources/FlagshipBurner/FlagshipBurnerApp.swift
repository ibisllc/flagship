import SwiftUI

@main
struct FlagshipBurnerApp: App {
    var body: some Scene {
        WindowGroup("Flagship Assembler") {
            WizardView()
        }
        .windowResizability(.contentSize)
    }
}
