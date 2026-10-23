import Foundation
import Darwin

/// What the root helper will and will not touch (SEC-MAC-001, SEC-MAC-002). The
/// helper runs as root and takes input from a client, so it validates every
/// object itself before using it: who the client is and which disk may be
/// overwritten (the image arrives as a descriptor and is staged by HelperState; the disk is
/// described by Disk Arbitration and the I/O Registry, DiskArbitrationProbe). Pure decision
/// code lives here so it is testable without root.
public enum HelperPolicy {
    /// Flagship's Apple Developer Team ID (the Developer ID signing identity).
    public static let teamID = "8G8RHBU9BN"

    /// The code-signing requirement the connecting app must satisfy: Apple's
    /// anchor, our bundle id, our Developer ID certificate chain and OUR team.
    /// An identifier under `anchor apple generic` alone admits any Apple
    /// developer who names a bundle `com.flagshipserver.Builder`.
    public static func clientRequirement(bundleID: String = kFlagshipAppBundleID,
                                         teamID: String = HelperPolicy.teamID) -> String {
        "anchor apple generic"
            + " and identifier \"\(bundleID)\""
            + " and certificate leaf[subject.OU] = \"\(teamID)\""
            + " and certificate 1[field.1.2.840.113635.100.6.2.6]"
            + " and certificate leaf[field.1.2.840.113635.100.6.1.13]"
    }

    /// The smallest and largest image the helper will write, and the largest
    /// disk it will overwrite (a USB stick, not a data drive).
    public static let minImageBytes: Int64 = 1024
    public static let maxImageBytes: Int64 = 16 * 1024 * 1024 * 1024
    public static let maxDiskBytes: Int64 = 2 * 1024 * 1024 * 1024 * 1024

    public enum Refusal: LocalizedError, Equatable {
        case notAWholeDiskNode(String)
        case diskInfoUnavailable(String)
        case notThatDisk
        case notExternalWholeDisk
        case notRemovable
        case virtualDisk
        case systemDisk
        case diskTooSmall
        case diskTooLarge
        case diskChanged

        public var errorDescription: String? {
            switch self {
            case .notAWholeDiskNode(let d): return "Refusing \(d): only a whole disk such as /dev/disk4 can be written."
            case .diskInfoUnavailable(let w): return "Couldn't read the disk's details (\(w)); refusing to write."
            case .notThatDisk: return "The disk that answered is not the one that was asked for; refusing to write."
            case .notExternalWholeDisk: return "Refusing: that is not an external whole disk."
            case .notRemovable: return "Refusing: that disk is not removable media."
            case .virtualDisk: return "Refusing: that is a virtual disk or disk image."
            case .systemDisk: return "Refusing: that is the disk this Mac runs from."
            case .diskTooSmall: return "Refusing: the image does not fit on that disk."
            case .diskTooLarge: return "Refusing: that disk is larger than a USB stick this tool will erase."
            case .diskChanged: return "The disk changed while it was being prepared; refusing to write."
            }
        }
    }

    // MARK: - Device

    /// `/dev/diskN` (and nothing else) → `diskN`.
    public static func wholeDiskID(fromNode node: String) throws -> String {
        guard node.hasPrefix("/dev/") else { throw Refusal.notAWholeDiskNode(node) }
        let id = String(node.dropFirst("/dev/".count))
        guard DiskEnumerator.isWholeDiskID(id) else { throw Refusal.notAWholeDiskNode(node) }
        return id
    }

    /// What the helper learned about a disk. Compared at registration, before
    /// the unmount and immediately before the raw device is opened: a different
    /// registry entry ID means another IOMedia object answers to that diskN
    /// (a reconnect, or another stick given the same number).
    public struct DiskFacts: Equatable {
        public let id: String
        public let totalSize: Int64
        public let mediaName: String
        public let busProtocol: String
        public let uuid: String
        public let registryEntryID: UInt64
    }

    /// Decide whether a disk Disk Arbitration describes may be overwritten with
    /// an image of `imageBytes`.
    public static func assess(_ d: DiskDescription,
                              wantedID: String,
                              systemDisks: Set<String>,
                              imageBytes: Int64) throws -> DiskFacts {
        guard d.bsdName == wantedID else { throw Refusal.notThatDisk }
        guard d.whole, d.internalDevice == false else { throw Refusal.notExternalWholeDisk }
        guard d.removable || d.ejectable else { throw Refusal.notRemovable }
        guard !d.isVirtual else { throw Refusal.virtualDisk }
        guard !systemDisks.contains(wantedID) else { throw Refusal.systemDisk }
        guard d.size >= imageBytes, d.size > 0 else { throw Refusal.diskTooSmall }
        guard d.size <= maxDiskBytes else { throw Refusal.diskTooLarge }
        guard d.registryEntryID != 0 else { throw Refusal.diskInfoUnavailable("I/O Registry") }
        return DiskFacts(id: wantedID,
                         totalSize: d.size,
                         mediaName: d.mediaName,
                         busProtocol: d.busProtocol,
                         uuid: d.mediaUUID,
                         registryEntryID: d.registryEntryID)
    }

    /// `disk0s2` → `disk0`.
    public static func wholeID(ofSlice s: String) -> String {
        guard s.hasPrefix("disk") else { return s }
        let digits = s.dropFirst(4).prefix { $0.isNumber }
        return "disk" + digits
    }
}
