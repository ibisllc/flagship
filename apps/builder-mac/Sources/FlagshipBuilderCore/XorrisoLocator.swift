import Foundation

/// Resolve the `xorriso` binary. Prefers the copy bundled inside the .app
/// (Contents/Helpers/xorriso) so a shipped build needs nothing installed;
/// falls back to common Homebrew/system locations for dev runs.
public enum XorrisoLocator {
    public static func resolve(bundle: Bundle = .main) -> String? {
        if let res = bundle.resourceURL {
            // Contents/Resources/../Helpers/xorriso
            let bundled = res.deletingLastPathComponent()
                .appendingPathComponent("Helpers/xorriso")
            if FileManager.default.isExecutableFile(atPath: bundled.path) {
                return bundled.path
            }
        }
        for c in ["/opt/homebrew/bin/xorriso", "/usr/local/bin/xorriso", "/usr/bin/xorriso"] {
            if FileManager.default.isExecutableFile(atPath: c) { return c }
        }
        return nil
    }
}
