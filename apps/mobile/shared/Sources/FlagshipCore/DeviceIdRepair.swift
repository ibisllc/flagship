import Foundation

/// Finds the device ID `.com` registered for this device when the app lost it. Builds before the
/// ID was saved invented a new one on every cold start, so every device-signed request named a
/// device `.com` never saw (403). The registered ID is one the device made keys for: try each
/// with a signed directory read until one is accepted. Mirror of Android `DeviceIdRepair`.
public enum DeviceIdRepair {
    public enum Verdict: Sendable { case accepted, refused, unreachable }

    /// Candidates, most likely first: the current ID, IDs whose PQ key `.com` bound, then the rest.
    public static func candidates(current: String?, boundPq: [String], otherPq: [String], kept: [String]) -> [String] {
        var seen = Set<String>()
        return ([current].compactMap { $0 } + boundPq + otherPq + kept)
            .map { $0.lowercased() }
            .filter { AccountMetadata.isDeviceId($0) && seen.insert($0).inserted }
    }

    /// The first accepted ID; nil when none is, or when `.com` can't be reached (try again later).
    public static func find(_ candidates: [String], read: (String) async -> Verdict) async -> String? {
        for id in candidates {
            switch await read(id) {
            case .accepted: return id
            case .refused: continue
            case .unreachable: return nil
            }
        }
        return nil
    }
}
