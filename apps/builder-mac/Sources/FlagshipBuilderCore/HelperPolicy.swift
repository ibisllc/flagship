import Foundation
import Darwin

/// What the root helper will and will not touch (SEC-MAC-001). The helper runs
/// as root and takes strings from a client, so it validates every object itself
/// before using it: who the client is, which file is the image, where the log
/// goes, and which disk may be overwritten. Pure decision code lives here so it
/// is testable without root.
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
        case badImage(String)
        case badLog(String)

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
            case .badImage(let w): return "Refusing the image: \(w)."
            case .badLog(let w): return "Refusing the log file: \(w)."
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

    /// What the helper learned about a disk. Compared before and after the
    /// unmount, immediately before the raw device is opened.
    public struct DiskFacts: Equatable {
        public let id: String
        public let totalSize: Int64
        public let mediaName: String
        public let busProtocol: String
        public let uuid: String
    }

    /// Decide whether `diskutil info -plist` output describes a disk that may
    /// be overwritten with an image of `imageBytes`.
    public static func assess(plist: Data,
                              wantedID: String,
                              systemDisks: Set<String>,
                              imageBytes: Int64) throws -> DiskFacts {
        guard let d = (try? PropertyListSerialization.propertyList(from: plist, options: [], format: nil))
                as? [String: Any] else { throw Refusal.diskInfoUnavailable("unreadable") }
        func flag(_ k: String) -> Bool? { (d[k] as? NSNumber)?.boolValue }

        guard (d["DeviceIdentifier"] as? String) == wantedID else { throw Refusal.notThatDisk }
        guard flag("WholeDisk") == true, flag("Internal") == false else { throw Refusal.notExternalWholeDisk }
        guard flag("RemovableMedia") == true
                || flag("RemovableMediaOrExternalDevice") == true
                || flag("Ejectable") == true else { throw Refusal.notRemovable }
        let bus = (d["BusProtocol"] as? String) ?? ""
        guard (d["VirtualOrPhysical"] as? String) != "Virtual", bus != "Disk Image" else { throw Refusal.virtualDisk }
        guard !systemDisks.contains(wantedID) else { throw Refusal.systemDisk }
        let size = (d["TotalSize"] as? NSNumber)?.int64Value ?? (d["Size"] as? NSNumber)?.int64Value ?? 0
        guard size >= imageBytes, size > 0 else { throw Refusal.diskTooSmall }
        guard size <= maxDiskBytes else { throw Refusal.diskTooLarge }
        return DiskFacts(id: wantedID,
                         totalSize: size,
                         mediaName: (d["MediaName"] as? String) ?? "",
                         busProtocol: bus,
                         uuid: (d["DiskUUID"] as? String) ?? (d["MediaUUID"] as? String) ?? "")
    }

    /// Whole disks that hold the running system (the root volume and the data
    /// volume, through any APFS container to its physical store). Fails closed.
    public static func systemWholeDisks(run: ([String]) throws -> Data = DiskEnumerator.runDiskutil) throws -> Set<String> {
        var out = Set<String>()
        for mount in ["/", "/System/Volumes/Data"] {
            let data: Data
            do { data = try run(["info", "-plist", mount]) }
            catch { throw Refusal.diskInfoUnavailable("system volume") }
            guard let d = (try? PropertyListSerialization.propertyList(from: data, options: [], format: nil))
                    as? [String: Any] else { throw Refusal.diskInfoUnavailable("system volume") }
            if let p = d["ParentWholeDisk"] as? String { out.insert(p) }
            for store in (d["APFSPhysicalStores"] as? [[String: Any]]) ?? [] {
                if let s = store["APFSPhysicalStore"] as? String { out.insert(wholeID(ofSlice: s)) }
            }
        }
        guard !out.isEmpty else { throw Refusal.diskInfoUnavailable("system volume") }
        return out
    }

    /// `disk0s2` → `disk0`.
    public static func wholeID(ofSlice s: String) -> String {
        guard s.hasPrefix("disk") else { return s }
        let digits = s.dropFirst(4).prefix { $0.isNumber }
        return "disk" + digits
    }

    // MARK: - Image

    /// Open the image once, without following a symlink, and accept it only if
    /// it is a plain, single-link file the client itself owns that others
    /// cannot write. The helper then reads this descriptor, never the path, so
    /// the file cannot be swapped and a root-only file cannot be named.
    public static func openImage(path: String, clientUID: uid_t) throws -> (handle: FileHandle, size: Int64) {
        guard path.hasPrefix("/"), !path.utf8.contains(0) else { throw Refusal.badImage("not an absolute path") }
        let fd = path.withCString { Darwin.open($0, O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK | O_NOCTTY) }
        guard fd >= 0 else { throw Refusal.badImage("can't open it (\(String(cString: strerror(errno))))") }
        var st = stat()
        guard fstat(fd, &st) == 0 else { Darwin.close(fd); throw Refusal.badImage("can't inspect it") }
        let kind = st.st_mode & S_IFMT
        guard kind == S_IFREG else { Darwin.close(fd); throw Refusal.badImage("not a regular file") }
        guard st.st_nlink == 1 else { Darwin.close(fd); throw Refusal.badImage("it has other links") }
        guard st.st_uid == clientUID else { Darwin.close(fd); throw Refusal.badImage("it is not yours") }
        guard st.st_mode & (S_IWGRP | S_IWOTH) == 0 else { Darwin.close(fd); throw Refusal.badImage("others can write it") }
        // Opened non-blocking so a FIFO or device cannot hang the helper; a plain file reads normally.
        _ = fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) & ~O_NONBLOCK)
        let size = Int64(st.st_size)
        guard size >= minImageBytes, size <= maxImageBytes else { Darwin.close(fd); throw Refusal.badImage("unreasonable size") }
        return (FileHandle(fileDescriptor: fd, closeOnDealloc: true), size)
    }

    // MARK: - Log

    private static let logName = try! NSRegularExpression(pattern: "^flagship-builder-[0-9A-Fa-f-]{36}\\.log$")

    /// Create the progress log fresh (never truncate or follow anything that
    /// exists), only under /tmp or the user's temporary folder, under the one
    /// name the app uses, and hand it to the client.
    public static func createLog(path: String, clientUID: uid_t) throws -> FileHandle {
        let url = URL(fileURLWithPath: path)
        let name = url.lastPathComponent
        guard logName.firstMatch(in: name, range: NSRange(name.startIndex..., in: name)) != nil else {
            throw Refusal.badLog("unexpected name")
        }
        guard let resolved = realpath(url.deletingLastPathComponent().path, nil) else {
            throw Refusal.badLog("folder not found")
        }
        defer { free(resolved) }
        let dir = String(cString: resolved)
        guard dir == "/private/tmp" || dir.hasPrefix("/private/var/folders/") else {
            throw Refusal.badLog("not a temporary folder")
        }
        let full = dir + "/" + name
        let fd = full.withCString { Darwin.open($0, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o644) }
        guard fd >= 0 else { throw Refusal.badLog("can't create it (\(String(cString: strerror(errno))))") }
        _ = fchown(fd, clientUID, gid_t.max)
        return FileHandle(fileDescriptor: fd, closeOnDealloc: true)
    }
}
