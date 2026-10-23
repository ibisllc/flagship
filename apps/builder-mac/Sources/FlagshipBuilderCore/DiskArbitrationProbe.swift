import Foundation
import DiskArbitration
import IOKit

/// What the root helper knows about a disk, read from Disk Arbitration and the
/// I/O Registry (SEC-MAC-002): no `diskutil` output is parsed and no other
/// process is trusted to describe the disk.
public struct DiskDescription: Equatable, Sendable {
    public var bsdName: String
    public var whole: Bool
    /// nil when the system does not say (a virtual device, for one).
    public var internalDevice: Bool?
    public var removable: Bool
    public var ejectable: Bool
    public var size: Int64
    public var mediaName: String
    public var busProtocol: String
    public var mediaUUID: String
    public var deviceModel: String
    /// The IOMedia object's registry entry ID. A new object (the stick unplugged
    /// and plugged back, or another stick given the same diskN) has a new ID.
    public var registryEntryID: UInt64

    public init(bsdName: String, whole: Bool, internalDevice: Bool?, removable: Bool, ejectable: Bool,
                size: Int64, mediaName: String, busProtocol: String, mediaUUID: String,
                deviceModel: String, registryEntryID: UInt64) {
        self.bsdName = bsdName
        self.whole = whole
        self.internalDevice = internalDevice
        self.removable = removable
        self.ejectable = ejectable
        self.size = size
        self.mediaName = mediaName
        self.busProtocol = busProtocol
        self.mediaUUID = mediaUUID
        self.deviceModel = deviceModel
        self.registryEntryID = registryEntryID
    }

    /// A disk image or another software-backed device, which is never a stick.
    public var isVirtual: Bool {
        busProtocol == "Disk Image" || busProtocol == "Virtual Interface" || deviceModel == "Disk Image"
    }
}

public enum DiskArbitrationProbe {
    public enum Failure: LocalizedError, Equatable {
        case noSession
        case noDisk(String)
        case noDescription(String)
        case unmount(String)

        public var errorDescription: String? {
            switch self {
            case .noSession: return "Disk Arbitration is not available."
            case .noDisk(let d): return "No disk named \(d)."
            case .noDescription(let d): return "Disk Arbitration has no description for \(d)."
            case .unmount(let why): return why
            }
        }
    }

    /// The description Disk Arbitration keeps for `bsdName`, with the IOMedia
    /// object's registry entry ID.
    public static func describe(bsdName: String) throws -> DiskDescription {
        guard let session = DASessionCreate(kCFAllocatorDefault) else { throw Failure.noSession }
        guard let disk = DADiskCreateFromBSDName(kCFAllocatorDefault, session, bsdName) else { throw Failure.noDisk(bsdName) }
        guard let raw = DADiskCopyDescription(disk) as NSDictionary? as? [String: Any] else { throw Failure.noDescription(bsdName) }
        let media = DADiskCopyIOMedia(disk)
        defer { if media != 0 { IOObjectRelease(media) } }
        var entryID: UInt64 = 0
        if media != 0 { IORegistryEntryGetRegistryEntryID(media, &entryID) }
        return description(from: raw, registryEntryID: entryID)
    }

    /// Map a Disk Arbitration description dictionary. Pure, for tests.
    public static func description(from d: [String: Any], registryEntryID: UInt64) -> DiskDescription {
        func flag(_ k: CFString) -> Bool? { (d[k as String] as? NSNumber)?.boolValue }
        func text(_ k: CFString) -> String { (d[k as String] as? String) ?? "" }
        var uuid = ""
        if let v = d[kDADiskDescriptionMediaUUIDKey as String] {
            let cf = v as CFTypeRef
            if CFGetTypeID(cf) == CFUUIDGetTypeID() {
                uuid = (CFUUIDCreateString(kCFAllocatorDefault, (cf as! CFUUID)) as String?) ?? ""
            } else if let s = v as? String {
                uuid = s
            }
        }
        return DiskDescription(
            bsdName: text(kDADiskDescriptionMediaBSDNameKey),
            whole: flag(kDADiskDescriptionMediaWholeKey) ?? false,
            internalDevice: flag(kDADiskDescriptionDeviceInternalKey),
            removable: flag(kDADiskDescriptionMediaRemovableKey) ?? false,
            ejectable: flag(kDADiskDescriptionMediaEjectableKey) ?? false,
            size: (d[kDADiskDescriptionMediaSizeKey as String] as? NSNumber)?.int64Value ?? 0,
            mediaName: text(kDADiskDescriptionMediaNameKey),
            busProtocol: text(kDADiskDescriptionDeviceProtocolKey),
            mediaUUID: uuid,
            deviceModel: text(kDADiskDescriptionDeviceModelKey),
            registryEntryID: registryEntryID)
    }

    /// Whole disks under the running system: for the root and data volumes,
    /// every whole IOMedia between the volume and the hardware (the APFS
    /// container and its physical store). Fails closed.
    public static func systemWholeDisks() throws -> Set<String> {
        guard let session = DASessionCreate(kCFAllocatorDefault) else { throw Failure.noSession }
        var out = Set<String>()
        for path in ["/", "/System/Volumes/Data"] {
            let url = URL(fileURLWithPath: path) as CFURL
            guard let volume = DADiskCreateFromVolumePath(kCFAllocatorDefault, session, url) else { continue }
            if let whole = DADiskCopyWholeDisk(volume), let name = DADiskGetBSDName(whole) {
                out.insert(String(cString: name))
            }
            var entry = DADiskCopyIOMedia(volume)
            while entry != 0 {
                if IOObjectConformsTo(entry, "IOMedia") != 0,
                   (property(entry, "Whole") as? Bool) == true,
                   let name = property(entry, "BSD Name") as? String {
                    out.insert(name)
                }
                var parent: io_registry_entry_t = 0
                let kr = IORegistryEntryGetParentEntry(entry, kIOServicePlane, &parent)
                IOObjectRelease(entry)
                entry = kr == KERN_SUCCESS ? parent : 0
            }
        }
        guard !out.isEmpty else { throw Failure.noDescription("the system volume") }
        return out
    }

    private static func property(_ entry: io_registry_entry_t, _ key: String) -> Any? {
        IORegistryEntryCreateCFProperty(entry, key as CFString, kCFAllocatorDefault, 0)?.takeRetainedValue()
    }

    /// Unmount every volume on the whole disk `bsdName` through Disk Arbitration
    /// (the same request Finder makes), waiting for the answer.
    public static func unmountWhole(bsdName: String, timeout: TimeInterval = 60) throws {
        guard let session = DASessionCreate(kCFAllocatorDefault) else { throw Failure.noSession }
        guard let disk = DADiskCreateFromBSDName(kCFAllocatorDefault, session, bsdName) else { throw Failure.noDisk(bsdName) }
        let queue = DispatchQueue(label: "flagship.helper.unmount")
        DASessionSetDispatchQueue(session, queue)
        defer { DASessionSetDispatchQueue(session, nil) }
        let box = UnmountResult()
        let ctx = Unmanaged.passRetained(box).toOpaque()
        DADiskUnmount(disk, DADiskUnmountOptions(kDADiskUnmountOptionWhole), { _, dissenter, context in
            let r = Unmanaged<UnmountResult>.fromOpaque(context!).takeRetainedValue()
            if let dissenter {
                let status = DADissenterGetStatus(dissenter)
                let why = (DADissenterGetStatusString(dissenter) as String?) ?? String(format: "status 0x%x", status)
                r.error = "Couldn't unmount the disk: \(why)"
            }
            r.done.signal()
        }, ctx)
        if box.done.wait(timeout: .now() + timeout) == .timedOut {
            throw Failure.unmount("Couldn't unmount the disk: no answer from Disk Arbitration")
        }
        if let e = box.error { throw Failure.unmount(e) }
    }

    private final class UnmountResult: @unchecked Sendable {
        let done = DispatchSemaphore(value: 0)
        var error: String?
    }
}
