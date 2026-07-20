import Foundation
import Darwin

/// Native raw-disk write (pure-Swift port of write.ts's writer). Runs in the
/// privileged helper: unmount the disk's volumes, then stream the prepared
/// image to the raw character device /dev/rdiskN. The remastered ISO is a
/// multiple of the 2048-byte ISO sector, so 1 MiB chunks stay block-aligned.

public enum DiskWriteError: LocalizedError {
    case imageTooSmall(Int)
    case badDevice(String)
    case cannotOpen(String, String)
    case unmountFailed(String)
    case writeFailed(bytesWritten: Int, reason: String)

    public var errorDescription: String? {
        switch self {
        case .imageTooSmall(let n): return "Image too small (\(n) bytes); refusing to write."
        case .badDevice(let d): return "Refusing non-/dev/disk device: \(d)"
        case .cannotOpen(let path, let why): return "Can't open \(path): \(why)"
        case .unmountFailed(let err): return "Couldn't unmount the disk: \(err)"
        case .writeFailed(let n, let reason):
            return "Write failed \(n / (1024 * 1024)) MB in: \(reason)"
        }
    }
}

public enum DiskWrite {
    /// Write `imagePath` to `devicePath` (e.g. /dev/disk9), reporting a 0…1
    /// fraction roughly once per percent. Must run as root.
    public static func write(imagePath: String,
                             devicePath: String,
                             progress: (Double) -> Void) throws {
        let fm = FileManager.default
        let size = ((try? fm.attributesOfItem(atPath: imagePath))?[.size] as? Int) ?? 0
        guard size >= 1024 else { throw DiskWriteError.imageTooSmall(size) }
        guard devicePath.hasPrefix("/dev/disk") else { throw DiskWriteError.badDevice(devicePath) }

        // A mounted disk can't be opened for raw write — unmount its volumes.
        do {
            try unmount(devicePath)
        } catch {
            throw DiskWriteError.unmountFailed(error.localizedDescription)
        }

        // Raw character device: /dev/disk9 → /dev/rdisk9 (far faster).
        let raw = "/dev/r" + devicePath.dropFirst("/dev/".count)

        guard let inp = FileHandle(forReadingAtPath: imagePath) else {
            throw DiskWriteError.cannotOpen(imagePath, "no such file")
        }
        defer { try? inp.close() }
        let fd = raw.withCString { Darwin.open($0, O_WRONLY) }
        guard fd >= 0 else {
            throw DiskWriteError.cannotOpen(raw, openFailureReason(errno))
        }
        let out = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
        defer { try? out.close() }

        var written = 0
        var lastPct = -1
        let chunkSize = 1024 * 1024
        let sector = 512
        while true {
            var data = inp.readData(ofLength: chunkSize)
            if data.isEmpty { break }
            // Raw character devices require sector-aligned writes. Full 1 MiB
            // chunks are aligned; only the FINAL short chunk can be partial
            // (e.g. a personalized ISO = base + ~1 KB trailer). Pad it with
            // zeros to the next sector. The box finds the trailer by the ISO
            // volume size, not the device end, so trailing zeros are harmless —
            // and without this, `write()` fails EINVAL ("couldn't be saved").
            let rem = data.count % sector
            if rem != 0 { data.append(Data(count: sector - rem)) }
            do {
                try out.write(contentsOf: data)
            } catch {
                throw DiskWriteError.writeFailed(bytesWritten: written,
                                                 reason: writeFailureReason(error))
            }
            written += data.count
            let pct = Int(Double(written) / Double(size) * 100)
            if pct != lastPct {
                lastPct = pct
                progress(min(1.0, Double(written) / Double(size)))
            }
        }
        do {
            try out.synchronize()
        } catch {
            throw DiskWriteError.writeFailed(bytesWritten: written,
                                             reason: writeFailureReason(error))
        }
        progress(1.0)
    }

    /// Foundation surfaces a failed raw-device write as the useless generic
    /// "The file couldn't be saved." — dig the POSIX errno out of the
    /// underlying-error chain and name the actual failure mode.
    static func writeFailureReason(_ error: Error) -> String {
        guard let code = posixCode(of: error) else { return error.localizedDescription }
        switch code {
        case ENXIO, ENODEV, ENOTCONN:
            return "the USB stick disconnected mid-write — it may be failing; try another stick or port"
        case EIO:
            return "the USB stick reported an I/O error — it may be failing; try another stick or port"
        case EROFS, EPERM, EACCES:
            return "the device refused the write — check for a write-protect switch"
        case EINVAL:
            return "unaligned write (EINVAL) — the device may use a sector size this writer doesn't handle"
        default:
            return "\(String(cString: strerror(code))) (errno \(code))"
        }
    }

    static func openFailureReason(_ code: Int32) -> String {
        switch code {
        case EPERM, EACCES:
            return "macOS denied removable-volume access — enable Flagship Studio in System Settings → Privacy & Security → Files & Folders → Removable Volumes, then try again"
        case EBUSY:
            return "the device is busy — close Disk Utility and any app using the drive, unplug and reconnect it, then try again"
        case EROFS:
            return "the device is read-only — check for a write-protect switch"
        default:
            return "\(String(cString: strerror(code))) (errno \(code))"
        }
    }

    private static func posixCode(of error: Error) -> Int32? {
        var next: NSError? = error as NSError
        while let e = next {
            if e.domain == NSPOSIXErrorDomain { return Int32(e.code) }
            next = e.userInfo[NSUnderlyingErrorKey] as? NSError
        }
        return nil
    }

    private static func unmount(_ devicePath: String) throws {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/sbin/diskutil")
        p.arguments = ["unmountDisk", devicePath]
        let err = Pipe()
        p.standardError = err
        p.standardOutput = Pipe()
        try p.run()
        let errData = err.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        if p.terminationStatus != 0 {
            throw DiskWriteError.unmountFailed(
                String(data: errData, encoding: .utf8) ?? "exit \(p.terminationStatus)")
        }
    }
}
