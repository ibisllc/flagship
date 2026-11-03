import Foundation

/// The USB/ISO installer stops before erasing anything when it can't tell which disk to install on
/// (none, or several candidates, or a named disk that matches none or several), and reports one of
/// four English sentences as the `error` detail (packages/flagship-builder/src/preseed.ts
/// resolveTargetDisk). This recognises them so the apps say it in the owner's language, with the
/// fix: make the installer again naming the disk ("Disk to install on"). Vectors:
/// test-vectors/install-disk-stop.json.
public enum InstallDiskStop: Equatable, Sendable {
    case several(count: String, sizes: String)
    case noDisk
    case missing(disk: String)
    case ambiguous(disk: String)

    public var kind: String {
        switch self {
        case .several: return "several"
        case .noDisk: return "none"
        case .missing: return "missing"
        case .ambiguous: return "ambiguous"
        }
    }

    public static func parse(_ detail: String?) -> InstallDiskStop? {
        let t = (detail ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard t.contains("Nothing was erased.") else { return nil }
        if let m = groups(#"^This machine has ([0-9]+) disks that could be erased \((.*)\)\. Nothing was erased\."#, t), m.count == 2 {
            return .several(count: m[0], sizes: m[1])
        }
        if t.hasPrefix("This machine has no fixed disk of 8 GB or more to install on. Nothing was erased.") {
            return .noDisk
        }
        if let m = groups(#"^The disk this installer was made for \((.+)\) is not in this machine\. Nothing was erased\."#, t), m.count == 1 {
            return .missing(disk: m[0])
        }
        if let m = groups(#"^The disk this installer was made for \((.+)\) matches more than one disk\. Nothing was erased\."#, t), m.count == 1 {
            return .ambiguous(disk: m[0])
        }
        return nil
    }

    public var sentence: String {
        switch self {
        case .several(let count, let sizes):
            return String(localized: "This computer has \(count) disks the installer could erase (\(sizes)), so it stopped. Nothing was erased.")
        case .noDisk:
            return String(localized: "This computer has no built-in disk of 8 GB or more to install on, so the installer stopped. Nothing was erased.")
        case .missing(let disk):
            return String(localized: "The disk this installer was made for (\(disk)) isn't in this computer. Nothing was erased.")
        case .ambiguous(let disk):
            return String(localized: "The disk this installer was made for (\(disk)) matches more than one disk in this computer. Nothing was erased.")
        }
    }

    public static var advice: String {
        String(localized: "Make the installer again with the same recipe and fill in Disk to install on with one of the disks the computer listed on its screen, then start the computer from it.")
    }

    /// The text the install screens show for this stop.
    public var message: String { sentence + " " + Self.advice }

    private static func groups(_ pattern: String, _ s: String) -> [String]? {
        guard let re = try? NSRegularExpression(pattern: pattern),
              let m = re.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)) else { return nil }
        return (1..<m.numberOfRanges).compactMap { i in
            Range(m.range(at: i), in: s).map { String(s[$0]) }
        }
    }
}
