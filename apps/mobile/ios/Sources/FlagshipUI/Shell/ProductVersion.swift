import Foundation

/// The one product version every Flagship surface shows (release/version.json).
/// The App Store version has to keep climbing past 1.0, so About reads
/// "Flagship 0.2 Beta (iOS 1.1, build 5)". `scripts/check-versions.mjs --write`
/// keeps these constants in step with the file.
enum ProductVersion {
    static let product = "0.2"
    static let label = "Beta"

    static var display: String { "\(product) \(label)" }

    /// "Flagship 0.2 Beta (iOS 1.1, build 5)"; without a readable bundle,
    /// just "Flagship 0.2 Beta".
    static func aboutLine(short: String?, build: String?) -> String {
        guard let short, let build else { return "Flagship \(display)" }
        return "Flagship \(display) (iOS \(short), build \(build))"
    }
}
