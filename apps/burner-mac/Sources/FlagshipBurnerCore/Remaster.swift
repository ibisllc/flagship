import Foundation

/// Remaster a stock Ubuntu Server ISO into an unattended autoinstall ISO —
/// pure-Swift port of packages/flagship-burner remasterIso.ts. Bakes the
/// NoCloud seed at /nocloud and patches grub for `autoinstall`, preserving
/// boot via `xorriso -boot_image any replay` so the result is dd-able.

public enum RemasterError: LocalizedError {
    case xorrisoNotFound
    case sourceTooSmall(Int)
    case commandFailed(String, Int32, String)

    public var errorDescription: String? {
        switch self {
        case .xorrisoNotFound:
            return "xorriso not found. Install it (brew install xorriso) or ship it in the app."
        case .sourceTooSmall(let n): return "Source ISO too small (\(n) bytes); not an ISO."
        case .commandFailed(let cmd, let code, let err):
            return "\(cmd) failed (exit \(code)): \(err)"
        }
    }
}

public enum Remaster {
    /// Insert the autoinstall + nocloud cmdline into casper kernel lines and
    /// shorten the menu timeout. Pure transform — unit-tested directly.
    public static func editGrubCfg(_ cfg: String) -> String {
        let seed = "autoinstall ds=nocloud\\;s=/cdrom/nocloud/"  // literal "\;" for grub
        let linuxLine = try! NSRegularExpression(pattern: "^\\s*linux\\b")
        let casperTok = try! NSRegularExpression(pattern: "/casper/vmlinuz\\S*")

        let patched = cfg.components(separatedBy: "\n").map { line -> String in
            let full = NSRange(line.startIndex..., in: line)
            guard linuxLine.firstMatch(in: line, range: full) != nil,
                  line.contains("/casper/vmlinuz") else { return line }
            if line.contains("autoinstall") { return line }
            guard let m = casperTok.firstMatch(in: line, range: full),
                  let r = Range(m.range, in: line) else { return line }
            var out = line
            out.insert(contentsOf: " \(seed)", at: r.upperBound)
            return out
        }.joined(separator: "\n")

        if patched.range(of: "set\\s+timeout=\\d+", options: .regularExpression) != nil {
            return patched.replacingOccurrences(
                of: "set\\s+timeout=\\d+", with: "set timeout=1", options: .regularExpression)
        }
        return "set timeout=1\n" + patched
    }

    /// Produce a flashable autoinstall ISO at `outISO` from `srcISO` + the
    /// cloud-init `userDataYAML`.
    public static func remaster(srcISO: URL, outISO: URL, userDataYAML: String,
                                xorrisoPath: String? = nil) throws {
        let st = try? FileManager.default.attributesOfItem(atPath: srcISO.path)
        let size = (st?[.size] as? Int) ?? 0
        if size < 1024 { throw RemasterError.sourceTooSmall(size) }

        guard let xorriso = xorrisoPath ?? XorrisoLocator.resolve() else {
            throw RemasterError.xorrisoNotFound
        }

        let work = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("flagship-remaster-\(UUID().uuidString)")
        try? FileManager.default.removeItem(at: work)
        try FileManager.default.createDirectory(at: work, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: work) }

        // 1. Extract grub.cfg.
        let grubOut = work.appendingPathComponent("grub.cfg")
        try run(xorriso, ["-osirrox", "on", "-indev", srcISO.path,
                          "-extract", "/boot/grub/grub.cfg", grubOut.path])
        // 2. osirrox preserves the ISO's read-only (0444) mode — make it writable.
        try? FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: grubOut.path)
        // 3. Patch + write back.
        let patched = editGrubCfg(try String(contentsOf: grubOut, encoding: .utf8))
        try patched.write(to: grubOut, atomically: true, encoding: .utf8)

        // 4. Build the NoCloud seed dir.
        let seed = work.appendingPathComponent("nocloud")
        try FileManager.default.createDirectory(at: seed, withIntermediateDirectories: true)
        try userDataYAML.write(to: seed.appendingPathComponent("user-data"), atomically: true, encoding: .utf8)
        try "instance-id: flagship-pod\nlocal-hostname: flagship\n"
            .write(to: seed.appendingPathComponent("meta-data"), atomically: true, encoding: .utf8)
        try "".write(to: seed.appendingPathComponent("vendor-data"), atomically: true, encoding: .utf8)

        // 5. Repack: replay boot equipment, overlay seed + grub. xorriso
        //    refuses to write when -indev differs from -outdev and the outdev
        //    already holds data, so clear a stale output first (e.g. re-running
        //    "save an ISO" over a previous <name>.flagship.iso).
        try? FileManager.default.removeItem(at: outISO)
        try run(xorriso, ["-indev", srcISO.path, "-outdev", outISO.path,
                          "-boot_image", "any", "replay",
                          "-map", seed.path, "/nocloud",
                          "-map", grubOut.path, "/boot/grub/grub.cfg"])
    }

    @discardableResult
    static func run(_ launchPath: String, _ args: [String]) throws -> String {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: launchPath)
        p.arguments = args
        let errPipe = Pipe()
        p.standardError = errPipe
        p.standardOutput = Pipe()
        try p.run()
        let errData = errPipe.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        if p.terminationStatus != 0 {
            let err = String(data: errData, encoding: .utf8) ?? ""
            throw RemasterError.commandFailed(
                (launchPath as NSString).lastPathComponent, p.terminationStatus, err.trimmingCharacters(in: .whitespacesAndNewlines))
        }
        return ""
    }
}
