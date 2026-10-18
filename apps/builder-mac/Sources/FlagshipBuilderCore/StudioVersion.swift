import Foundation

/// What Studio's About shows: the one product version every Flagship surface
/// shares (release/version.json). The bundle carries the release number
/// ("0.2.0"); About reads "0.2 Beta". `scripts/check-versions.mjs --write`
/// keeps `label` in step with the file.
public enum StudioVersion {
    public static let label = "Beta"

    /// "0.2.0" -> "0.2 Beta". A dev build ("dev", "0.0.0-dev") is shown as is.
    public static func display(bundleVersion: String?) -> String {
        guard let v = bundleVersion, !v.isEmpty else { return "dev" }
        let parts = v.split(separator: ".")
        guard parts.count == 3, parts.allSatisfy({ Int($0) != nil }), parts[2] == "0" else { return v }
        return "\(parts[0]).\(parts[1]) \(label)"
    }

    public static var current: String {
        display(bundleVersion: Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String)
    }
}
