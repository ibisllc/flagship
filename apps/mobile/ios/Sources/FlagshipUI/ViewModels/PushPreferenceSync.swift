import Foundation
import FlagshipAPI

public enum PushPreferenceCopy {
    public static let title = "Push notifications"
    public static let detail = "When this is off, nothing from Flagship is pushed to this device, so Apple and Google never see when your servers need you. You'll have to open Flagship to approve unlocks and see requests."
}

/// The owner's one push switch (Settings → Privacy → "Push notifications",
/// docs/ai-privacy-and-staging.md §3a). Off: every box this device manages is
/// told to push no access-request alert, this device drops its push
/// registration on `.com`, and it unregisters from APNs, so nothing reaches
/// Flagship, Apple or Google and nothing can be delivered. On: the boxes may
/// alert again and the device asks APNs for a new token, which registers with
/// `.com` when it arrives. The value lives on the device; a box that disagrees
/// (reset, restored, or offline when it changed) is put right on the next
/// start or return to the foreground. An older box without the setting (404)
/// is skipped, as is any box that can't be reached.
@MainActor
public final class PushPreferenceSync {
    /// How this device is reachable by push. The app wires the real
    /// `PushRegistrar` and `UIApplication`; tests inject their own.
    public struct Registration {
        /// Ask APNs for a token (its arrival registers it with `.com`).
        public var registerAPNs: @MainActor () async -> Void
        /// Stop APNs delivering anything to this device.
        public var unregisterAPNs: @MainActor () -> Void
        /// Drop this device's push registration on `.com` (IRK-signed; it may
        /// fail offline or when Face ID is cancelled).
        public var unregisterServer: @MainActor () async -> Void
        /// Whether `.com` or APNs may still hold a registration.
        public var isRegistered: @MainActor () -> Bool

        public init(registerAPNs: @escaping @MainActor () async -> Void,
                    unregisterAPNs: @escaping @MainActor () -> Void,
                    unregisterServer: @escaping @MainActor () async -> Void,
                    isRegistered: @escaping @MainActor () -> Bool) {
            self.registerAPNs = registerAPNs
            self.unregisterAPNs = unregisterAPNs
            self.unregisterServer = unregisterServer
            self.isRegistered = isRegistered
        }
    }

    private let boxes: @MainActor () async -> [AppAccessAlertCenter.Box]
    private let isEnabled: @MainActor () -> Bool
    private let registration: Registration
    public private(set) var isSyncing = false

    public init(boxes: @escaping @MainActor () async -> [AppAccessAlertCenter.Box],
                isEnabled: @escaping @MainActor () -> Bool,
                registration: Registration) {
        self.boxes = boxes
        self.isEnabled = isEnabled
        self.registration = registration
    }

    /// The switch moved: write the value to every box, then register or
    /// unregister this device.
    public func changed() async {
        let on = isEnabled()
        for box in await boxes() {
            _ = try? await box.client.setAccessAlerts(enabled: on)
        }
        if on { await registration.registerAPNs() } else { await unregister() }
    }

    /// App start / foreground: write the device's value to each box that
    /// holds another, and finish an unregister that didn't complete.
    public func resync() async {
        guard !isSyncing else { return }
        isSyncing = true
        defer { isSyncing = false }
        let on = isEnabled()
        for box in await boxes() {
            guard let current = try? await box.client.accessAlertsSetting() else { continue }
            if current.enabled != on {
                _ = try? await box.client.setAccessAlerts(enabled: on)
            }
        }
        if !on && registration.isRegistered() { await unregister() }
    }

    /// APNs is dropped whatever `.com` answered: a revoke that failed is
    /// retried on the next start, and nothing is delivered meanwhile.
    private func unregister() async {
        await registration.unregisterServer()
        registration.unregisterAPNs()
    }
}
