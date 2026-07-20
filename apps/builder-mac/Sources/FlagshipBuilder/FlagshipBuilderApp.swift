import SwiftUI
import AppKit

/// Entry point. Normally launches the SwiftUI app, but a hidden
/// `--vm-smoke` flag runs the headless Phase-0 VM boot harness (VMSmoke)
/// instead — it needs to run from THIS signed, virtualization-entitled
/// binary because a `swift run` binary can't start a VZVirtualMachine.
@main
enum AppMain {
    static func main() {
        let args = CommandLine.arguments
        #if canImport(Virtualization)
        if let idx = args.firstIndex(of: "--vm-smoke") {
            MainActor.assumeIsolated {
                VMSmoke.run(Array(args[(idx + 1)...]))
            }
        }
        #endif
        FlagshipBuilderApp.main()
    }
}

struct FlagshipBuilderApp: App {
    // Owned at the app level so the native menu bar can drive it (New Server,
    // appearance) — the window and the menu share one model.
    @StateObject private var model = WizardModel()

    var body: some Scene {
        WindowGroup("Flagship Studio", id: "main") {
            WizardView(model: model)
        }
        .windowResizability(.contentSize)
        .commands { BuilderCommands(model: model) }

        MenuBarExtra {
            MenuBarContent()
        } label: {
            MenuBarLabel()
        }
    }
}

/// Native menu-bar commands. Keeps appearance (Auto/Light/Dark) out of the
/// window chrome and in the standard place, plus a New Server item and Help
/// links. Appearance is stored under the same `builder.theme` AppStorage key
/// WizardView reads to apply `preferredColorScheme`.
struct BuilderCommands: Commands {
    let model: WizardModel
    @AppStorage("builder.theme") private var theme = ""

    var body: some Commands {
        CommandGroup(replacing: .newItem) {
            Button("New Server") { model.selectedHostedServer = nil }
                .keyboardShortcut("n", modifiers: .command)
        }
        CommandMenu("View") {
            Picker("Appearance", selection: $theme) {
                Text("Auto (System)").tag("")
                Text("Light").tag("light")
                Text("Dark").tag("dark")
            }
            .pickerStyle(.inline)
        }
        CommandGroup(replacing: .help) {
            Button("Flagship Studio Help") {
                NSWorkspace.shared.open(URL(string: "https://flagshipserver.com/docs")!)
            }
            Button("Report an Issue…") {
                NSWorkspace.shared.open(URL(string: "https://flagshipserver.com/security/report.html")!)
            }
        }
    }
}

/// The menu-bar (status) icon. Uses the Flagship mark as a template image
/// so it tints to the menu bar's appearance; falls back to an SF Symbol
/// when run outside the packaged .app (dev `swift run`).
private struct MenuBarLabel: View {
    var body: some View {
        if let img = Self.templateImage {
            Image(nsImage: img)
        } else {
            Image(systemName: "externaldrive.fill")
        }
    }

    static let templateImage: NSImage? = {
        guard let url = Bundle.main.url(forResource: "menubar", withExtension: "png"),
              let img = NSImage(contentsOf: url) else { return nil }
        img.size = NSSize(width: 18, height: 18)
        img.isTemplate = true
        return img
    }()
}

private struct MenuBarContent: View {
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        Button("Open Flagship Studio") {
            NSApp.activate(ignoringOtherApps: true)
            openWindow(id: "main")
        }
        Divider()
        Button("Quit Flagship Studio") { NSApp.terminate(nil) }
    }
}
