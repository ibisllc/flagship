import SwiftUI
import AppKit

@main
struct FlagshipBurnerApp: App {
    var body: some Scene {
        WindowGroup("Flagship Assembler", id: "main") {
            WizardView()
        }
        .windowResizability(.contentSize)

        MenuBarExtra {
            MenuBarContent()
        } label: {
            MenuBarLabel()
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
        Button("Open Flagship Assembler") {
            NSApp.activate(ignoringOtherApps: true)
            openWindow(id: "main")
        }
        Divider()
        Button("Quit Flagship Assembler") { NSApp.terminate(nil) }
    }
}
