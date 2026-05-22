import Foundation

/// Native raw-disk write (pure-Swift port of write.ts's writer). Runs in the
/// privileged helper: unmount the disk's volumes, then stream the prepared
/// image to the raw character device /dev/rdiskN. The remastered ISO is a
/// multiple of the 2048-byte ISO sector, so 1 MiB chunks stay block-aligned.

public enum DiskWriteError: LocalizedError {
    case imageTooSmall(Int)
    case badDevice(String)
    case cannotOpen(String, String)
    case unmountFailed(String)

    public var errorDescription: String? {
        switch self {
        case .imageTooSmall(let n): return "Image too small (\(n) bytes); refusing to write."
        case .badDevice(let d): return "Refusing non-/dev/disk device: \(d)"
        case .cannotOpen(let path, let why): return "Can't open \(path): \(why)"
        case .unmountFailed(let err): return "Couldn't unmount the disk: \(err)"
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
        guard let out = FileHandle(forWritingAtPath: raw) else {
            throw DiskWriteError.cannotOpen(raw, "permission denied or busy")
        }
        defer { try? out.close() }

        var written = 0
        var lastPct = -1
        let chunkSize = 1024 * 1024
        while true {
            let data = inp.readData(ofLength: chunkSize)
            if data.isEmpty { break }
            try out.write(contentsOf: data)
            written += data.count
            let pct = Int(Double(written) / Double(size) * 100)
            if pct != lastPct {
                lastPct = pct
                progress(min(1.0, Double(written) / Double(size)))
            }
        }
        try out.synchronize()
        progress(1.0)
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
