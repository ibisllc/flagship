#if canImport(Virtualization)
import Foundation
import Virtualization
import FlagshipBurnerCore

/// Headless VM boot harness — Phase-0 hardware validation of the Host-here
/// appliance path (docs/desktop-vm-appliance.md). NOT part of the shipping GUI:
/// it is reachable only via `FlagshipAssembler --vm-smoke …` so the SIGNED,
/// entitled binary (`com.apple.security.virtualization`) can actually boot a
/// VZVirtualMachine — a `swift run` binary lacks the entitlement and VZ refuses
/// to start.
///
/// It exercises the REAL impure layer (`VZHost.makeConfiguration`/`start`, the
/// EFI boot loader, NAT, the install→detach→boot-from-disk seam) and the REAL
/// pure `VMLifecycle`, logging every VZ delegate callback + serial output so the
/// reboot-vs-poweroff question is answered from observed behavior rather than
/// assumed.
///
/// Usage:
///   FlagshipAssembler --vm-smoke \
///       --recipe <recipe.json> --base-iso <debian-netinst.iso> \
///       [--root <bundle-root>] [--preseed real|reboot-early|poweroff-early] \
///       [--timeout <seconds>]
///
/// The serial console is FORCED on here (the harness always wants visibility);
/// production gating on the debug grant is unchanged in the GUI path.
@MainActor
enum VMSmoke {

    static func run(_ args: [String]) -> Never {
        do {
            try main(args)
        } catch {
            FileHandle.standardError.write(Data("vm-smoke: \(error)\n".utf8))
            exit(2)
        }
        // main() drives its own run loop and calls exit(); unreachable.
        exit(0)
    }

    struct Options {
        var recipe: URL
        var baseISO: URL
        var root: URL
        var preseedMode: String
        var timeout: TimeInterval
    }

    static func parse(_ args: [String]) throws -> Options {
        var map: [String: String] = [:]
        var i = 0
        while i < args.count {
            let a = args[i]
            if a.hasPrefix("--") {
                let key = String(a.dropFirst(2))
                let val = (i + 1 < args.count && !args[i + 1].hasPrefix("--")) ? args[i + 1] : ""
                map[key] = val
                i += val.isEmpty ? 1 : 2
            } else { i += 1 }
        }
        guard let recipe = map["recipe"] else { throw Err.usage("--recipe is required") }
        guard let base = map["base-iso"] else { throw Err.usage("--base-iso is required") }
        let root = map["root"].map { URL(fileURLWithPath: $0) }
            ?? URL(fileURLWithPath: NSTemporaryDirectory())
                .appendingPathComponent("flagship-vm-smoke", isDirectory: true)
        return Options(
            recipe: URL(fileURLWithPath: recipe),
            baseISO: URL(fileURLWithPath: base),
            root: root,
            preseedMode: map["preseed"] ?? "real",
            timeout: TimeInterval(map["timeout"] ?? "1800") ?? 1800)
    }

    enum Err: Error, CustomStringConvertible {
        case usage(String)
        var description: String { switch self { case .usage(let s): return s } }
    }

    static let t0 = Date()
    static func log(_ s: String) {
        let dt = String(format: "%7.3f", Date().timeIntervalSince(t0))
        print("[+\(dt)s] \(s)")
        fflush(stdout)
    }

    static func main(_ args: [String]) throws {
        // Diagnostic: direct VZLinuxBootLoader boot (the VZHost header's
        // documented fallback for when EFI won't boot a given ISO). Proves VZ +
        // the ISO's kernel/initrd work and gives serial visibility.
        var kv: [String: String] = [:]
        var i = 0
        while i < args.count {
            if args[i].hasPrefix("--") {
                let k = String(args[i].dropFirst(2))
                let v = (i + 1 < args.count && !args[i+1].hasPrefix("--")) ? args[i+1] : ""
                kv[k] = v; i += v.isEmpty ? 1 : 2
            } else { i += 1 }
        }
        if let kernel = kv["linux-kernel"] {
            try linuxBoot(kernel: URL(fileURLWithPath: kernel),
                          initrd: kv["linux-initrd"].map { URL(fileURLWithPath: $0) },
                          iso: kv["base-iso"].map { URL(fileURLWithPath: $0) },
                          cmdline: kv["cmdline"] ?? "console=hvc0",
                          timeout: TimeInterval(kv["timeout"] ?? "120") ?? 120)
            RunLoop.main.run()
            exit(0)
        }

        let opts = try parse(args)
        log("vm-smoke start · recipe=\(opts.recipe.lastPathComponent) baseISO=\(opts.baseISO.lastPathComponent) preseed=\(opts.preseedMode) root=\(opts.root.path)")

        // 1. Load + verify the recipe (same path runHostHere uses).
        let recipeData = try Data(contentsOf: opts.recipe)
        let recipe = try RecipeLoader.load(data: recipeData)
        log("recipe verified · domain=\(recipe.serverDomain) encryptsDisk=\(recipe.encryptsDisk) bootUnlock=\(recipe.effectiveBootUnlockMode)")

        // 2. Plan the VM config, but FORCE the serial console on for the harness.
        let host = HostResources.current()
        let planned = VMConfig.plan(recipe: recipe, recipeJSON: recipeData, host: host)
        let config = VMConfig(
            name: planned.name,
            serverDomain: planned.serverDomain,
            username: planned.username,
            serverName: planned.serverName,
            cpuCount: planned.cpuCount,
            memoryBytes: planned.memoryBytes,
            mainDiskSizeBytes: planned.mainDiskSizeBytes,
            networkMode: planned.networkMode,
            serialConsoleEnabled: true,
            bootUnlockMode: planned.bootUnlockMode,
            diskEncrypted: planned.diskEncrypted)
        log("config · \(config.cpuCount) vCPU · \(config.memoryBytes / VMResourcePlan.gib) GiB · disk \(config.mainDiskSizeBytes / VMResourcePlan.gib) GiB")

        // 3. Build the preseed and remaster the installer into the bundle.
        let layout = VMBundleLayout(root: opts.root)
        let store = VMInventoryStore(layout: layout)
        try? store.delete(name: config.name) // fresh each run
        try store.create(VMRecord(config: config, state: .created, createdAt: Date()))

        let outISO = layout.installerISOURL(config.name)
        if opts.preseedMode == "none" {
            // Boot the stock, unmodified base ISO — isolates whether the xorriso
            // remaster (not VZ/EFI) is what breaks bootability.
            log("copying stock \(opts.baseISO.lastPathComponent) → \(outISO.lastPathComponent) (no remaster) …")
            try? FileManager.default.removeItem(at: outISO)
            try FileManager.default.copyItem(at: opts.baseISO, to: outISO)
            log("stock ISO in place · \(sizeMB(outISO)) MB")
        } else {
            let basePreseed = try UserData.debianPreseed(
                recipeJSON: recipeData,
                installerGitRef: recipe.installerGitRef,
                encryptRoot: recipe.encryptsDisk,
                bootUnlockMode: recipe.effectiveBootUnlockMode)
            let preseed = mutatePreseed(basePreseed, mode: opts.preseedMode)
            log("remastering \(opts.baseISO.lastPathComponent) → \(outISO.lastPathComponent) …")
            let family = try Remaster.remasterInstaller(
                srcISO: opts.baseISO, outISO: outISO, preseedCfg: preseed)
            log("remaster done · family=\(family) · installer \(sizeMB(outISO)) MB")
        }

        // 4. Drive the lifecycle on the real VZHost.
        let driver = Driver(config: config, layout: layout, timeout: opts.timeout)
        driver.begin()
        // VZ callbacks arrive on the main run loop.
        RunLoop.main.run(until: Date(timeIntervalSinceNow: opts.timeout + 60))
        log("run loop exited (hard cap) · final state=\(driver.lifecycle.state.label)")
        exit(driver.exitCode)
    }

    /// Fast reboot/poweroff probes: replace the preseed's early_command so the
    /// guest reboots/poweroffs seconds into d-i (before partitioning), giving a
    /// clean read of VZ's guest-stop delegate behavior without a 15-min install.
    /// "real" leaves the shipping preseed untouched (full install → poweroff).
    static func mutatePreseed(_ preseed: String, mode: String) -> String {
        switch mode {
        case "real-nolate":
            // Full real install (partition + LUKS + base + GRUB + poweroff) but
            // with the heavy first-boot bootstrap (clone main + build the daemon)
            // neutralized — lets a boot-loop run finish in minutes and stop
            // exactly where an unregistered box does: sealed in the initramfs
            // (awaiting-phone-unlock). Strips the `late_command` logical line
            // (which may span `\`-continued physical lines).
            var lines = preseed.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
            if let start = lines.firstIndex(where: { $0.hasPrefix("d-i preseed/late_command string") }) {
                var end = start
                while end < lines.count && lines[end].hasSuffix("\\") { end += 1 }
                lines.replaceSubrange(start...min(end, lines.count - 1),
                                      with: ["d-i preseed/late_command string in-target /bin/true"])
            }
            return lines.joined(separator: "\n")
        case "reboot-early", "poweroff-early":
            let verb = mode == "reboot-early" ? "reboot" : "poweroff"
            var out = preseed.split(separator: "\n", omittingEmptySubsequences: false)
                .map(String.init)
                .filter { !$0.contains("preseed/early_command") }
                .joined(separator: "\n")
            out += "\n### vm-smoke probe: stop the guest immediately.\n"
            out += "d-i preseed/early_command string sleep 3; \(verb) -f || \(verb)\n"
            return out
        default:
            return preseed
        }
    }

    /// Direct VZLinuxBootLoader boot — bypasses EFI entirely. Diagnostic only.
    static var linuxConsole: FileHandle?
    static var linuxVM: VZVirtualMachine?
    static var linuxDelegate: LinuxDelegate?
    static func linuxBoot(kernel: URL, initrd: URL?, iso: URL?, cmdline: String, timeout: TimeInterval) throws {
        log("linux-boot · kernel=\(kernel.lastPathComponent) initrd=\(initrd?.lastPathComponent ?? "none") iso=\(iso?.lastPathComponent ?? "none") cmdline=\"\(cmdline)\"")
        let vz = VZVirtualMachineConfiguration()
        vz.cpuCount = 2
        vz.memorySize = 4 * 1024 * 1024 * 1024
        vz.platform = VZGenericPlatformConfiguration()
        let boot = VZLinuxBootLoader(kernelURL: kernel)
        boot.commandLine = cmdline
        if let initrd { boot.initialRamdiskURL = initrd }
        vz.bootLoader = boot

        if let iso {
            let a = try VZDiskImageStorageDeviceAttachment(url: iso, readOnly: true)
            vz.storageDevices = [VZVirtioBlockDeviceConfiguration(attachment: a)]
        }
        let net = VZVirtioNetworkDeviceConfiguration()
        net.attachment = VZNATNetworkDeviceAttachment()
        vz.networkDevices = [net]
        vz.entropyDevices = [VZVirtioEntropyDeviceConfiguration()]

        let inPipe = Pipe(), outPipe = Pipe()
        let serial = VZVirtioConsoleDeviceSerialPortConfiguration()
        serial.attachment = VZFileHandleSerialPortAttachment(
            fileHandleForReading: inPipe.fileHandleForReading,
            fileHandleForWriting: outPipe.fileHandleForWriting)
        vz.serialPorts = [serial]
        linuxConsole = outPipe.fileHandleForReading
        linuxConsole?.readabilityHandler = { fh in
            let d = fh.availableData
            if !d.isEmpty { FileHandle.standardOutput.write(d) }
        }

        try vz.validate()
        let vm = VZVirtualMachine(configuration: vz)
        let del = LinuxDelegate()
        linuxDelegate = del
        vm.delegate = del
        linuxVM = vm
        vm.start { result in
            switch result {
            case .success: log("linux VZ start OK")
            case .failure(let e): log("linux VZ start FAILED: \(e)"); exit(3)
            }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + timeout) {
            log("linux-boot timeout reached (\(Int(timeout))s) · vm.state=\(vzStateName(linuxVM?.state))")
            exit(0)
        }
    }

    final class LinuxDelegate: NSObject, VZVirtualMachineDelegate {
        func guestDidStop(_ vm: VZVirtualMachine) { print(">>> linux guestDidStop (clean)"); fflush(stdout); exit(0) }
        func virtualMachine(_ vm: VZVirtualMachine, didStopWithError e: Error) { print(">>> linux didStopWithError: \(e)"); fflush(stdout); exit(0) }
    }

    static func sizeMB(_ url: URL) -> Int {
        let n = (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
        return n / (1024 * 1024)
    }

    /// Drives one VM through the real VZHost + pure VMLifecycle, mirroring
    /// VMManager's install/boot orchestration and logging the seam decisions.
    @MainActor
    final class Driver {
        let config: VMConfig
        let layout: VMBundleLayout
        let timeout: TimeInterval
        var lifecycle: VMLifecycle
        var vzHost: VZHost?
        var attachISO = false
        var exitCode: Int32 = 0
        private var consoleReader: FileHandle?
        private var deadline: Date

        init(config: VMConfig, layout: VMBundleLayout, timeout: TimeInterval) {
            self.config = config
            self.layout = layout
            self.timeout = timeout
            self.lifecycle = VMLifecycle(state: .created,
                                         sealedAtBoot: config.awaitsPhoneUnlockAtBoot)
            self.deadline = Date(timeIntervalSinceNow: timeout)
        }

        func begin() {
            drive(.startInstall)
        }

        /// Feed an event through the pure lifecycle, log it, run the effects.
        func drive(_ event: VMEvent) {
            let before = lifecycle.state
            let effects: [VMEffect]
            do { effects = try lifecycle.handle(event) }
            catch { VMSmoke.log("lifecycle REJECTED \(event) in \(before.label): \(error)"); return }
            VMSmoke.log("event \(event) · \(before.label) → \(lifecycle.state.label) · effects=\(effects)")
            for e in effects { run(effect: e) }
            checkTerminal()
        }

        func run(effect: VMEffect) {
            switch effect {
            case .attachInstallerISO: attachISO = true
            case .detachInstallerISO: attachISO = false
            case .startVirtualMachine: startVM()
            case .stopVirtualMachine:
                if let h = vzHost { Task { try? await h.forceStop() } }
                vzHost = nil
            }
        }

        func startVM() {
            do { try VZHost.ensureMainDisk(config: config, layout: layout) }
            catch { VMSmoke.log("ensureMainDisk failed: \(error)"); return }
            let h = VZHost()
            vzHost = h
            h.onGuestStopped = { [weak self] err in
                Task { @MainActor in self?.guestStopped(err) }
            }
            Task { @MainActor in
                do {
                    try await h.start(config: config, layout: layout,
                                      attachInstallerISO: attachISO)
                    VMSmoke.log("VZVirtualMachine.start OK · attachISO=\(attachISO) · state=\(vzStateName(h.machine?.state))")
                    self.attachConsole(h)
                    self.observeState(h)
                } catch {
                    VMSmoke.log("VZ start FAILED: \(error)")
                    self.exitCode = 3
                    switch self.lifecycle.state {
                    case .installing: self.drive(.installFailed("\(error)"))
                    case .awaitingPhoneUnlock, .running: self.drive(.runtimeFailed("\(error)"))
                    default: break
                    }
                }
            }
        }

        /// The seam under test — mirror of VMManager.guestStopped.
        func guestStopped(_ error: Error?) {
            vzHost = nil
            consoleReader?.readabilityHandler = nil
            consoleReader = nil
            VMSmoke.log(">>> GUEST STOPPED · error=\(error.map { "\($0)" } ?? "nil") · phase=\(lifecycle.state.label)")
            switch lifecycle.state {
            case .installing:
                if let error { drive(.installFailed("\(error)")) }
                else {
                    switch VMLifecycle.verdictForCleanInstallStop(
                        installStartedAt: lifecycle.stateChangedAt, now: Date()) {
                    case .installed:
                        drive(.installSucceeded)
                        drive(.powerOn) // first boot from disk
                    case .failedTooFast(let elapsed):
                        VMSmoke.log("clean stop after \(String(format: "%.2f", elapsed))s — TOO FAST, not a real install")
                        drive(.installFailed("stopped after \(String(format: "%.2f", elapsed))s before install could run (wrong-arch base image or not bootable)"))
                    }
                }
            case .awaitingPhoneUnlock, .running:
                if let error { drive(.runtimeFailed("\(error)")) }
                else { drive(.powerOff) }
            default:
                break
            }
        }

        private var stateObs: NSKeyValueObservation?
        func observeState(_ h: VZHost) {
            guard let vm = h.machine else { return }
            stateObs = vm.observe(\.state, options: [.new]) { vm, _ in
                Task { @MainActor in VMSmoke.log("VZ state → \(vzStateName(vm.state))") }
            }
        }

        func attachConsole(_ h: VZHost) {
            guard let out = h.consoleOutput else { return }
            consoleReader = out
            out.readabilityHandler = { fh in
                let d = fh.availableData
                guard !d.isEmpty, let s = String(data: d, encoding: .utf8) else { return }
                FileHandle.standardOutput.write(Data(s.utf8))
            }
        }

        func checkTerminal() {
            switch lifecycle.state {
            case .running:
                VMSmoke.log("*** REACHED RUNNING — appliance booted through to serving state.")
                // Give the tunnel/daemon a moment, then stop cleanly.
                Task { @MainActor in
                    try? await Task.sleep(nanoseconds: 5_000_000_000)
                    exit(self.exitCode)
                }
            case .stopped:
                VMSmoke.log("*** STOPPED.")
                Task { @MainActor in exit(self.exitCode) }
            case .failed(let f):
                VMSmoke.log("*** FAILED (\(f.phase)): \(f.reason)")
                exitCode = 4
                Task { @MainActor in exit(self.exitCode) }
            default:
                break
            }
        }
    }
}

private func vzStateName(_ s: VZVirtualMachine.State?) -> String {
    switch s {
    case .some(.stopped): return "stopped"
    case .some(.running): return "running"
    case .some(.paused): return "paused"
    case .some(.error): return "error"
    case .some(.starting): return "starting"
    case .some(.pausing): return "pausing"
    case .some(.resuming): return "resuming"
    case .some(.stopping): return "stopping"
    case .some(.saving): return "saving"
    case .some(.restoring): return "restoring"
    case .none: return "nil"
    @unknown default: return "unknown"
    }
}
#endif
