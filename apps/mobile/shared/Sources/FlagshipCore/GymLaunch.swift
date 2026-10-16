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
public enum GymLaunch {
    public static var usesMocks: Bool {
        let args = ProcessInfo.processInfo.arguments
        return args.contains("-smoke-mode") || args.contains("-smoke-onboarding")
    }

    /// Retarget `Endpoints` from `-apex-host <host>`, before any client is
    /// built (the live clients capture their base URL at init).
    public static func applyApexHostArg() {
        let args = ProcessInfo.processInfo.arguments
        guard let i = args.firstIndex(of: "-apex-host"), i + 1 < args.count else { return }
        let host = args[i + 1].trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !host.isEmpty, !host.hasPrefix("-") else { return }
        if host == Endpoints.prodControlHost {
            Endpoints.setOverride(nil)
        } else {
            Endpoints.setOverride(controlHost: host)
        }
    }
}
#endif
