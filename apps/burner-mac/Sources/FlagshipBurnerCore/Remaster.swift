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

    // MARK: - Debian (debian-installer / d-i) preseed remaster

    /// The d-i kernel cmdline that drives an unattended preseed install from a
    /// preseed.cfg placed at the ISO root (mounted at /cdrom). Mirrors
    /// remasterIso.ts DEBIAN_PRESEED_CMDLINE.
    public static let debianPreseedCmdline =
        "auto=true priority=critical preseed/file=/cdrom/preseed.cfg"

    /// Patch a Debian netinst UEFI grub.cfg for unattended preseed: append the
    /// preseed cmdline to every d-i kernel line + drop the timeout. Pure.
    /// Mirrors remasterIso.ts editGrubCfgForPreseed.
    public static func editGrubCfgForPreseed(_ cfg: String) -> String {
        let linuxLine = try! NSRegularExpression(pattern: "^\\s*linux\\b")
        // The installer dir is arch-tagged: `/install.amd/` on amd64,
        // `/install.a64/` on arm64 (the Apple-silicon VM path), etc. Match any
        // `.<arch>` suffix (or none) so the preseed cmdline is injected on every
        // architecture, not just amd64.
        let kTok = try! NSRegularExpression(
            pattern: "linux\\s+/install(?:\\.[a-z0-9]+)?/(?:gtk/)?(?:vmlinuz|linux)\\S*")
        let isInstaller = try! NSRegularExpression(
            pattern: "/install(\\.[a-z0-9]+)?/(gtk/)?(vmlinuz|linux)")

        let patched = cfg.components(separatedBy: "\n").map { line -> String in
            let full = NSRange(line.startIndex..., in: line)
            guard linuxLine.firstMatch(in: line, range: full) != nil,
                  isInstaller.firstMatch(in: line, range: full) != nil else { return line }
            if line.contains("preseed/file=/cdrom/preseed.cfg") { return line }
            guard let m = kTok.firstMatch(in: line, range: full),
                  let r = Range(m.range, in: line) else { return line }
            var out = line
            out.insert(contentsOf: " \(debianPreseedCmdline)", at: r.upperBound)
            return out
        }.joined(separator: "\n")

        var out = patched
        if out.range(of: "set\\s+timeout=\\d+", options: .regularExpression) != nil {
            out = out.replacingOccurrences(
                of: "set\\s+timeout=\\d+", with: "set timeout=1", options: .regularExpression)
        } else {
            out = "set timeout=1\n" + out
        }
        out = out.replacingOccurrences(
            of: "set\\s+timeout_style=\\w+", with: "set timeout_style=menu", options: .regularExpression)
        return out
    }

    /// Patch a Debian netinst BIOS isolinux/syslinux config for unattended
    /// preseed: insert the cmdline after initrd= on every append line, force a
    /// near-zero timeout + prompt 0. Pure. Mirrors editIsolinuxCfgForPreseed.
    public static func editIsolinuxCfgForPreseed(_ cfg: String) -> String {
        let appendLine = try! NSRegularExpression(pattern: "^\\s*append\\b")
        let initrdTok = try! NSRegularExpression(pattern: "initrd=\\S*initrd\\.gz")

        var out = cfg.components(separatedBy: "\n").map { line -> String in
            let full = NSRange(line.startIndex..., in: line)
            guard appendLine.firstMatch(in: line, range: full) != nil,
                  let m = initrdTok.firstMatch(in: line, range: full),
                  let r = Range(m.range, in: line) else { return line }
            if line.contains("preseed/file=/cdrom/preseed.cfg") { return line }
            var l = line
            l.insert(contentsOf: " \(debianPreseedCmdline)", at: r.upperBound)
            return l
        }.joined(separator: "\n")

        if out.range(of: "(?m)^\\s*timeout\\s+\\d+", options: .regularExpression) != nil {
            out = out.replacingOccurrences(
                of: "(?m)^(\\s*timeout\\s+)\\d+", with: "$11", options: .regularExpression)
        } else {
            out = "timeout 1\n" + out
        }
        out = out.replacingOccurrences(
            of: "(?m)^\\s*prompt\\s+\\d+", with: "prompt 0", options: .regularExpression)
        return out
    }

    /// Classify a volume id / directory listing as ubuntu vs debian. Pure;
    /// mirrors remasterIso.ts classifyIsoText. Defaults to the proven Ubuntu
    /// path when ambiguous (the burn never refuses an ISO).
    public static func classifyIsoText(_ text: String) -> String {
        let t = text.lowercased()
        let hasDI = t.range(of: "install\\.amd|/d-i/|debian-installer|\\bdebian\\b",
                            options: .regularExpression) != nil
        if hasDI {
            let casperOnly = t.range(of: "\\bcasper\\b|\\bubuntu\\b", options: .regularExpression) != nil
                && t.range(of: "install\\.amd|/d-i/", options: .regularExpression) == nil
            return casperOnly ? "ubuntu" : "debian"
        }
        if t.range(of: "\\bubuntu\\b|\\bcasper\\b|subiquity", options: .regularExpression) != nil {
            return "ubuntu"
        }
        return "ubuntu"
    }

    /// Detect whether a source ISO is Ubuntu (subiquity) or Debian (d-i). Reads
    /// the ISO volume id; falls back to a directory probe. Mirrors
    /// remasterIso.ts detectIsoFamily. Returns "ubuntu" | "debian".
    public static func detectIsoFamily(srcISO: URL, xorrisoPath: String? = nil) -> String {
        guard let xorriso = xorrisoPath ?? XorrisoLocator.resolve() else { return "ubuntu" }
        let toc = (try? runCapture(xorriso, ["-indev", srcISO.path, "-toc"])) ?? ""
        if let m = toc.range(of: "Volume id\\s*:\\s*'([^']*)'", options: .regularExpression) {
            let vol = String(toc[m])
            if vol.range(of: "debian", options: .caseInsensitive) != nil { return "debian" }
            if vol.range(of: "ubuntu", options: .caseInsensitive) != nil { return "ubuntu" }
        }
        let listing = (try? runCapture(
            xorriso, ["-indev", srcISO.path, "-find", "/", "-maxdepth", "2", "-type", "d"])) ?? ""
        return classifyIsoText(toc + "\n" + listing)
    }

    /// Remaster a stock Debian netinst ISO into an unattended preseed ISO: bake
    /// preseed.cfg at the root + patch grub.cfg (UEFI) and isolinux configs
    /// (BIOS), preserving boot via `-boot_image any replay`. Mirrors
    /// remasterIso.ts remasterIsoWithPreseed.
    public static func remasterPreseed(srcISO: URL, outISO: URL, preseedCfg: String,
                                       xorrisoPath: String? = nil) throws {
        let st = try? FileManager.default.attributesOfItem(atPath: srcISO.path)
        let size = (st?[.size] as? Int) ?? 0
        if size < 1024 { throw RemasterError.sourceTooSmall(size) }
        guard let xorriso = xorrisoPath ?? XorrisoLocator.resolve() else {
            throw RemasterError.xorrisoNotFound
        }

        let work = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("flagship-remaster-deb-\(UUID().uuidString)")
        try? FileManager.default.removeItem(at: work)
        try FileManager.default.createDirectory(at: work, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: work) }

        let preseedOut = work.appendingPathComponent("preseed.cfg")
        try preseedCfg.write(to: preseedOut, atomically: true, encoding: .utf8)

        // Patch whichever boot configs the ISO ships (set varies by release).
        let targets: [(iso: String, edit: (String) -> String)] = [
            ("/boot/grub/grub.cfg", editGrubCfgForPreseed),
            ("/EFI/boot/grub.cfg", editGrubCfgForPreseed),
            ("/isolinux/isolinux.cfg", editIsolinuxCfgForPreseed),
            ("/isolinux/txt.cfg", editIsolinuxCfgForPreseed),
            ("/isolinux/gtk.cfg", editIsolinuxCfgForPreseed),
        ]
        var mapArgs: [String] = []
        var patchedAny = false
        for (i, t) in targets.enumerated() {
            let local = work.appendingPathComponent("bootcfg-\(i)")
            guard extractOptional(xorriso, srcISO.path, t.iso, local.path) else { continue }
            try? FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: local.path)
            let edited = t.edit((try? String(contentsOf: local, encoding: .utf8)) ?? "")
            try edited.write(to: local, atomically: true, encoding: .utf8)
            mapArgs += ["-map", local.path, t.iso]
            patchedAny = true
        }
        guard patchedAny else {
            throw RemasterError.commandFailed(
                "preseed", 1,
                "no Debian boot config found on ISO (grub.cfg + isolinux/*.cfg); is this a Debian netinst/DVD image?")
        }

        try? FileManager.default.removeItem(at: outISO)
        try run(xorriso, ["-indev", srcISO.path, "-outdev", outISO.path,
                          "-boot_image", "any", "replay",
                          "-map", preseedOut.path, "/preseed.cfg"] + mapArgs)
    }

    /// Family-aware remaster. Detects (or takes) the ISO family and routes to
    /// the Ubuntu autoinstall or Debian preseed path. Returns the family used.
    /// Mirrors remasterIso.ts remasterIsoWithInstaller.
    @discardableResult
    public static func remasterInstaller(srcISO: URL, outISO: URL,
                                         userDataYAML: String? = nil,
                                         preseedCfg: String? = nil,
                                         family forced: String? = nil,
                                         xorrisoPath: String? = nil) throws -> String {
        let family = forced ?? detectIsoFamily(srcISO: srcISO, xorrisoPath: xorrisoPath)
        if family == "debian" {
            guard let preseed = preseedCfg else {
                throw RemasterError.commandFailed("preseed", 1, "Debian ISO detected but no preseedCfg provided")
            }
            try remasterPreseed(srcISO: srcISO, outISO: outISO, preseedCfg: preseed, xorrisoPath: xorrisoPath)
            return "debian"
        }
        guard let yaml = userDataYAML else {
            throw RemasterError.commandFailed("autoinstall", 1, "Ubuntu ISO detected but no userDataYAML provided")
        }
        try remaster(srcISO: srcISO, outISO: outISO, userDataYAML: yaml, xorrisoPath: xorrisoPath)
        return "ubuntu"
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

    /// Run a command and capture stdout+stderr (for ISO introspection). Never
    /// throws on a non-zero exit — xorriso writes its report to stderr and some
    /// builds exit non-zero on -toc even when the volid printed. Mirrors
    /// remasterIso.ts shCapture.
    static func runCapture(_ launchPath: String, _ args: [String]) throws -> String {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: launchPath)
        p.arguments = args
        let outPipe = Pipe()
        let errPipe = Pipe()
        p.standardOutput = outPipe
        p.standardError = errPipe
        try p.run()
        let outData = outPipe.fileHandleForReading.readDataToEndOfFile()
        let errData = errPipe.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        let out = String(data: outData, encoding: .utf8) ?? ""
        let err = String(data: errData, encoding: .utf8) ?? ""
        return out + "\n" + err
    }

    /// Extract a file from the ISO if present; true on success, false if absent
    /// (so callers patch only the boot configs that ship). Mirrors
    /// remasterIso.ts extractOptional.
    static func extractOptional(_ xorriso: String, _ srcIso: String, _ isoPath: String, _ outPath: String) -> Bool {
        do {
            try run(xorriso, ["-osirrox", "on", "-indev", srcIso, "-extract", isoPath, outPath])
            let st = try FileManager.default.attributesOfItem(atPath: outPath)
            return ((st[.size] as? Int) ?? 0) > 0
        } catch {
            return false
        }
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
