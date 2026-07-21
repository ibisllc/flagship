import Foundation

/// A removable, external disk that the user could write a Flagship ISO to.
///
/// We deliberately surface only whole disks (`diskN`, not `diskNsM`), and
/// only ones flagged both `Removable` and `External` by `diskutil`. The
/// internal boot disk and the recovery partitions must NEVER appear in
/// the picker — the CLI's `dd` step is destructive.
public struct USBDisk: Equatable, Identifiable, Sendable {
    public let id: String                 // "disk6"
    public let deviceNode: String         // "/dev/disk6"
    public let mediaName: String          // "Generic Mass Storage"
    public let volumeName: String         // "Untitled" (often "")
    public let sizeBytes: Int64
    public let isRemovable: Bool
    public let isExternal: Bool
    public let busProtocol: String        // "USB", "Thunderbolt", "Disk Image", ...
    public let isWholeDisk: Bool

    public init(id: String,
                deviceNode: String,
                mediaName: String,
                volumeName: String,
                sizeBytes: Int64,
                isRemovable: Bool,
                isExternal: Bool,
                busProtocol: String,
                isWholeDisk: Bool) {
        self.id = id
        self.deviceNode = deviceNode
        self.mediaName = mediaName
        self.volumeName = volumeName
        self.sizeBytes = sizeBytes
        self.isRemovable = isRemovable
        self.isExternal = isExternal
        self.busProtocol = busProtocol
        self.isWholeDisk = isWholeDisk
    }

    public var humanSize: String {
        let f = ByteCountFormatter()
        f.allowedUnits = [.useGB, .useMB]
        f.countStyle = .file
        return f.string(fromByteCount: sizeBytes)
    }

    public var displayName: String {
        let label = volumeName.isEmpty ? mediaName : "\(volumeName) – \(mediaName)"
        return "\(label) (\(humanSize), \(busProtocol))"
    }
}

/// Why a candidate disk was rejected. Kept around because the wizard's
/// debug toggle wants to explain "I know you plugged in something — here's
/// why the picker is empty".
public enum DiskRejection: Equatable, Sendable {
    case notWholeDisk
    case notRemovableAndNotExternal
    case internalMedia
    case zeroSize
}

public enum DiskEnumeratorError: Error, Equatable {
    case diskutilFailed(String)
    case plistMalformed(String)
}

/// Pure parser. The integration boundary (`diskutil` invocation) is a
/// separate function so tests can feed in canned plist bytes.
public enum DiskEnumerator {

    /// Run `diskutil info -plist <id>` for every entry in the list `diskutil
    /// list -plist` returns, filter, and return the survivors. This is the
    /// production entry point used by the SwiftUI app.
    ///
    /// Synchronous wrapper around two subprocess calls — call it off the
    /// main thread.
    public static func enumerate() throws -> [USBDisk] {
        let listOutput = try Self.runDiskutil(["list", "-plist"])
        let ids = try parseAllDisksTopLevel(plist: listOutput)
        var disks: [USBDisk] = []
        for id in ids {
            let info: Data
            do { info = try Self.runDiskutil(["info", "-plist", id]) }
            catch { continue }
            if let parsed = try? parseDiskInfo(plist: info, fallbackId: id),
               accept(parsed).isEmpty {
                disks.append(parsed)
            }
        }
        return disks
    }

    /// Reject reasons for a candidate. Empty array == accepted.
    public static func accept(_ d: USBDisk) -> [DiskRejection] {
        var reasons: [DiskRejection] = []
        if !d.isWholeDisk { reasons.append(.notWholeDisk) }
        if !d.isRemovable && !d.isExternal { reasons.append(.notRemovableAndNotExternal) }
        if d.sizeBytes == 0 { reasons.append(.zeroSize) }
        return reasons
    }

    /// Parse the top-level `AllDisks` array out of `diskutil list -plist`,
    /// and return only whole-disk entries (no `sN` partition suffix).
    public static func parseAllDisksTopLevel(plist: Data) throws -> [String] {
        let p: Any
        do { p = try PropertyListSerialization.propertyList(from: plist, options: [], format: nil) }
        catch { throw DiskEnumeratorError.plistMalformed("\(error)") }
        guard let root = p as? [String: Any] else {
            throw DiskEnumeratorError.plistMalformed("root is not a dict")
        }
        guard let all = root["AllDisks"] as? [String] else {
            throw DiskEnumeratorError.plistMalformed("AllDisks missing or wrong type")
        }
        return all.filter { isWholeDiskID($0) }
    }

    /// Parse `diskutil info -plist <diskN>` into a `USBDisk`.
    public static func parseDiskInfo(plist: Data, fallbackId: String) throws -> USBDisk {
        let p: Any
        do { p = try PropertyListSerialization.propertyList(from: plist, options: [], format: nil) }
        catch { throw DiskEnumeratorError.plistMalformed("\(error)") }
        guard let dict = p as? [String: Any] else {
            throw DiskEnumeratorError.plistMalformed("info plist root not a dict")
        }
        let id = (dict["DeviceIdentifier"] as? String) ?? fallbackId
        let node = (dict["DeviceNode"] as? String) ?? "/dev/\(id)"
        let mediaName = (dict["MediaName"] as? String) ?? ""
        let volumeName = (dict["VolumeName"] as? String) ?? ""
        let sizeBytes = (dict["TotalSize"] as? NSNumber)?.int64Value
            ?? (dict["Size"] as? NSNumber)?.int64Value
            ?? 0
        let removable = (dict["Removable"] as? NSNumber)?.boolValue
            ?? (dict["RemovableMedia"] as? NSNumber)?.boolValue
            ?? false
        let external = !((dict["Internal"] as? NSNumber)?.boolValue ?? true)
        let busProto = (dict["BusProtocol"] as? String) ?? "Unknown"
        let whole = (dict["WholeDisk"] as? NSNumber)?.boolValue ?? false
        return USBDisk(
            id: id,
            deviceNode: node,
            mediaName: mediaName,
            volumeName: volumeName,
            sizeBytes: sizeBytes,
            isRemovable: removable,
            isExternal: external,
            busProtocol: busProto,
            isWholeDisk: whole
        )
    }

    /// `diskN` matches; `diskNsM` does not.
    public static func isWholeDiskID(_ s: String) -> Bool {
        guard s.hasPrefix("disk") else { return false }
        let suffix = s.dropFirst(4)
        return !suffix.isEmpty && suffix.allSatisfy { $0.isNumber }
    }

    // MARK: - Subprocess

    /// Indirection so tests can stub this if anyone wants to add an
    /// integration test later. The default impl shells out.
    public static var runDiskutil: ([String]) throws -> Data = { args in
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/sbin/diskutil")
        p.arguments = args
        let outPipe = Pipe()
        let errPipe = Pipe()
        p.standardOutput = outPipe
        p.standardError = errPipe
        try p.run()
        p.waitUntilExit()
        let data = outPipe.fileHandleForReading.readDataToEndOfFile()
        if p.terminationStatus != 0 {
            let err = String(data: errPipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
            throw DiskEnumeratorError.diskutilFailed("status=\(p.terminationStatus) stderr=\(err)")
        }
        return data
    }
}
