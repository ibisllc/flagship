#if DEBUG
import Foundation
import FlagshipAPI

/// The gym's launch seams, compiled into Debug builds only (the UI gym runs
/// Debug builds). Release builds have no mock clients and no way to switch to
/// them: they always talk to flagshipserver.com and the account's servers.
///
///   - `-smoke-mode` / `-smoke-onboarding`: the mock gym. No backend; every
///     client is the in-process mock and the shell is seeded with fixtures.
///   - `-apex-host <host>`: the live gym. The live clients target that apex
///     (e.g. `gym.flagshipserver.com`) instead of production.
///   - `-sticky-apex-host <host>`: the same, remembered for later plain launches
///     (a dev build on the owner's phone for the hardware acceptance).
public enum GymLaunch {
    public static var usesMocks: Bool {
        let args = ProcessInfo.processInfo.arguments
        return args.contains("-smoke-mode") || args.contains("-smoke-onboarding")
    }

    public static var startsOnWelcome: Bool {
        ProcessInfo.processInfo.arguments.contains("-smoke-onboarding")
    }

    /// Retarget `Endpoints` from `-apex-host <host>`, before any client is
    /// built (the live clients capture their base URL at init).
    public static func applyApexHostArg() {
        let args = ProcessInfo.processInfo.arguments
        // `-sticky-apex-host <host>` (a dev build on a real phone): remembered, so a launch from the home screen
        // or a push keeps talking to the same backend. `-sticky-apex-host flagshipserver.com` forgets it. An explicit
        // `-apex-host` (the gym runs) wins for that launch and never touches what is remembered.
        if let host = argValue("-sticky-apex-host", args) {
            UserDefaults.standard.set(host == Endpoints.prodControlHost ? nil : host, forKey: stickyApexKey)
        }
        guard let host = argValue("-apex-host", args)
                ?? (usesMocks ? nil : UserDefaults.standard.string(forKey: stickyApexKey)) else { return }
        if host == Endpoints.prodControlHost {
            Endpoints.setOverride(nil)
        } else {
            Endpoints.setOverride(controlHost: host)
        }
    }

    static let stickyApexKey = "flagship.debug.stickyApexHost"

    private static func argValue(_ flag: String, _ args: [String]) -> String? {
        guard let i = args.firstIndex(of: flag), i + 1 < args.count else { return nil }
        let host = args[i + 1].trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return host.isEmpty || host.hasPrefix("-") ? nil : host
    }
}
#endif
