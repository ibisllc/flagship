import AppIntents
import Foundation
import UIKit

/// Intents the system exposes via Siri, Spotlight, Shortcuts, and
/// (on supported devices) Action Button / Focus filters.
///
/// All three intents open the app at the right destination via the
/// existing flagship:// deep-link scheme — the actual work (BAK
/// signing, network round-trip) stays in the app so the Secure
/// Enclave never has to be reached from an extension's process.
///
/// The deep-link layer (DeepLinker) re-routes on the next view cycle,
/// so even a backgrounded app picks up the intent's destination as
/// soon as the user returns to focus.

// MARK: - Approve unlock

/// Siri: "Approve unlock with Flagship" / Shortcut: Approve Unlock.
/// Opens the Unlock Approvals queue; the user authorizes the latest
/// pending request with Face ID. (Doing the actual approval headless
/// from Siri would need a passcode prompt every time, which is worse
/// UX than just opening the app.)
struct ApproveUnlockIntent: AppIntent {
    static var title: LocalizedStringResource = "Approve unlock"
    static var description = IntentDescription(
        "Open Flagship at the pending unlock-approval queue for your server."
    )

    /// Opening the app keeps Secure-Enclave-backed BAK signing in
    /// the foreground process — Apple won't let extensions trigger
    /// LocalAuthentication-gated keys without UI.
    static var openAppWhenRun: Bool = true

    func perform() async throws -> some IntentResult {
        await MainActor.run {
            let url = URL(string: "flagship://unlock-approve?requestId=latest")!
            UIApplication.shared.open(url)
        }
        return .result()
    }
}

// MARK: - Show pod

/// Siri: "Show home with Flagship" — opens the named pod's detail
/// page. Uses the App Group snapshot so the entity list reflects the
/// user's actual pods (Spotlight surfaces these as suggestions).
struct ShowPodIntent: AppIntent {
    static var title: LocalizedStringResource = "Show pod"
    static var description = IntentDescription(
        "Open the detail page for a specific Flagship server."
    )

    static var openAppWhenRun: Bool = true

    @Parameter(title: "Pod")
    var pod: PodEntity

    func perform() async throws -> some IntentResult {
        await MainActor.run {
            let url = URL(string: "flagship://server?podId=\(pod.id)")!
            UIApplication.shared.open(url)
        }
        return .result()
    }
}

/// AppEntity exposing each known pod to Siri + Shortcuts. Backed by
/// the App Group PodStatusSnapshot so the entity catalog stays in
/// sync with the user's actual servers without the intent extension
/// having to load FlagshipCore.
struct PodEntity: AppEntity {
    static var typeDisplayRepresentation: TypeDisplayRepresentation = "Flagship Pod"
    static var defaultQuery = PodEntityQuery()

    var id: String
    var name: String
    var fqdn: String
    var statusRaw: String

    var displayRepresentation: DisplayRepresentation {
        DisplayRepresentation(
            title: "\(name)",
            subtitle: "\(fqdn) — \(statusRaw)"
        )
    }

    init(id: String, name: String, fqdn: String, statusRaw: String) {
        self.id = id; self.name = name; self.fqdn = fqdn; self.statusRaw = statusRaw
    }

    init(snapshotPod p: PodStatusSnapshot.Pod) {
        self.id = p.podId
        self.name = p.name
        self.fqdn = p.fqdn
        self.statusRaw = p.statusRaw
    }
}

struct PodEntityQuery: EntityQuery {
    func entities(for identifiers: [PodEntity.ID]) async throws -> [PodEntity] {
        let snapshot = PodStatusSnapshot.read()
        return snapshot.pods
            .filter { identifiers.contains($0.podId) }
            .map(PodEntity.init(snapshotPod:))
    }

    func suggestedEntities() async throws -> [PodEntity] {
        PodStatusSnapshot.read().pods.map(PodEntity.init(snapshotPod:))
    }
}

// MARK: - Pod status (returns a string for Siri to read aloud)

/// Siri: "What's the status of my Flagship server?" — returns a
/// short Speakable summary without opening the app. The data comes
/// from the App Group snapshot, so a momentary network blip doesn't
/// stall the response.
struct PodStatusIntent: AppIntent {
    static var title: LocalizedStringResource = "Pod status"
    static var description = IntentDescription(
        "Speak the current online/offline state of your Flagship servers."
    )

    static var openAppWhenRun: Bool = false

    func perform() async throws -> some IntentResult & ReturnsValue<String> & ProvidesDialog {
        let snap = PodStatusSnapshot.read()
        if snap.pods.isEmpty {
            return .result(value: "no pods", dialog: "You don't have any Flagship pods yet.")
        }
        let online  = snap.pods.filter { $0.statusRaw == "online"  }.count
        let offline = snap.pods.filter { $0.statusRaw == "offline" }.count
        let total = snap.pods.count
        let speak: String
        if offline == 0 {
            speak = "All \(total) pod\(total == 1 ? "" : "s") are online."
        } else if online == 0 {
            speak = "All \(total) pod\(total == 1 ? "" : "s") are offline."
        } else {
            speak = "\(online) of \(total) pods online, \(offline) offline."
        }
        return .result(value: speak, dialog: "\(speak)")
    }
}

// MARK: - Shortcuts surfacing

struct FlagshipAppShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: PodStatusIntent(),
            phrases: [
                "Get pod status with \(.applicationName)",
                "What's my \(.applicationName) status",
            ],
            shortTitle: "Pod status",
            systemImageName: "server.rack"
        )
        AppShortcut(
            intent: ApproveUnlockIntent(),
            phrases: [
                "Approve unlock with \(.applicationName)",
                "Show pending approvals in \(.applicationName)",
            ],
            shortTitle: "Approve unlock",
            systemImageName: "lock.open.fill"
        )
        AppShortcut(
            intent: ShowPodIntent(),
            phrases: [
                "Show my \(.applicationName) pod",
                "Open \(\.$pod) on \(.applicationName)",
            ],
            shortTitle: "Show pod",
            systemImageName: "house.fill"
        )
    }
}
