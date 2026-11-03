import Foundation

/// The optional burn option naming the one disk the USB installer may erase on a computer with more
/// than one (`targetDisk` in the preseed engine's burn options; `TARGET_DISK_PATTERN` in
/// packages/flagship-builder/src/preseed.ts, vectors in test-vectors/install-disk-stop.json).
public enum TargetDisk {
    public static let pattern = "^(by-id:[A-Za-z0-9._:+@-]{1,200}|serial:[A-Za-z0-9._-]{1,100}|size:[1-9][0-9]{0,19})$"

    public enum Check: Equatable {
        case none
        case valid(String)
        case invalid
    }

    public static func check(_ raw: String) -> Check {
        let t = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if t.isEmpty { return .none }
        return t.range(of: pattern, options: .regularExpression) != nil ? .valid(t) : .invalid
    }

    public static var label: String { String(localized: "Disk to install on (optional)") }
    public static var help: String {
        String(localized: "Only needed when the computer has more than one disk. Without it, the installer stops on such a computer, erases nothing and lists its disks on the screen. Enter by-id: and a name from that list, serial: and the disk's serial number, or size: and its exact size in bytes.")
    }
    public static var invalidMessage: String {
        String(localized: "Start with by-id:, serial: or size:, followed by the disk's name, serial number or size in bytes, with no spaces.")
    }
}
