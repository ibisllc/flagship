#if canImport(Virtualization)
import Foundation
import Virtualization
import FlagshipBuilderCore

/// The ONE file that touches Virtualization.framework. Deliberately dumb: it
/// translates a pure `VMConfig` (all decisions already made) into a
/// VZVirtualMachineConfiguration and starts/stops the machine. Unit tests
/// never instantiate it — the pure layer is what's tested; this adapter is
/// exercised by a manual `swift run` smoke test.
///
/// BOOT-LOADER CHOICE: VZEFIBootLoader + VZGenericMachinePlatform (+ an
/// on-disk VZEFIVariableStore). This is the standard, best-documented path
/// for booting a stock distro installer ISO on macOS 13+ — the EFI firmware
/// reads the ISO's El Torito/UEFI boot entry directly, and the remastered
/// Debian netinst is UEFI-bootable (Remaster.swift patches the UEFI
/// grub.cfg). The alternative, VZLinuxBootLoader, boots a kernel/initrd
/// EXTRACTED from the ISO — no firmware needed, but it bypasses the ISO's own
/// GRUB (where the remaster injects the preseed cmdline), so we'd have to
/// re-implement the cmdline injection host-side and re-extract on every base
/// ISO bump. If the EFI path proves unreliable for a given base ISO, that is
/// the documented fallback.
@MainActor
final class VZHost: NSObject {

    enum VZHostError: LocalizedError {
        case unsupportedNetworkMode
        case diskMissing(String)

        var errorDescription: String? {
            switch self {
            case .unsupportedNetworkMode:
                return "Unsupported network mode for this VM."
            case .diskMissing(let p):
                return "VM disk image missing: \(p)"
            }
        }
    }

    private(set) var machine: VZVirtualMachine?
    /// Write end the UI can send console input to; nil unless the recipe
    /// carried a debug grant (production VMs get no console device at all).
    private(set) var consoleInput: FileHandle?
    /// Read end carrying console output. Same gating.
    private(set) var consoleOutput: FileHandle?

    /// Invoked (on the main actor) when the guest stops on its own — install
    /// completion (the preseed powers the guest off) or a crash. The pure
    /// lifecycle decides what it means.
    var onGuestStopped: ((Error?) -> Void)?

    // MARK: - Configuration (pure VMConfig → VZ objects)

    /// `attachInstallerISO` mirrors the lifecycle's attach/detach effects:
    /// true during the install phase, false for every boot from disk.
    static func makeConfiguration(config: VMConfig,
                                  layout: VMBundleLayout,
                                  attachInstallerISO: Bool,
                                  consolePipes: (input: Pipe, output: Pipe)?) throws -> VZVirtualMachineConfiguration {
        let name = config.name
        let vz = VZVirtualMachineConfiguration()
        vz.cpuCount = config.cpuCount
        vz.memorySize = config.memoryBytes
        vz.platform = VZGenericPlatformConfiguration()

        // EFI firmware + persistent variable store (see the header comment).
        let bootLoader = VZEFIBootLoader()
        let varStoreURL = layout.efiVariableStoreURL(name)
        if FileManager.default.fileExists(atPath: varStoreURL.path) {
            bootLoader.variableStore = VZEFIVariableStore(url: varStoreURL)
        } else {
            bootLoader.variableStore = try VZEFIVariableStore(creatingVariableStoreAt: varStoreURL)
        }
        vz.bootLoader = bootLoader

        // Main disk first so it stays the stable primary device.
        let diskURL = layout.diskImageURL(name)
        guard FileManager.default.fileExists(atPath: diskURL.path) else {
            throw VZHostError.diskMissing(diskURL.path)
        }
        let mainDisk = try VZDiskImageStorageDeviceAttachment(url: diskURL, readOnly: false)
        var storage: [VZStorageDeviceConfiguration] = [VZVirtioBlockDeviceConfiguration(attachment: mainDisk)]
        // Default: attach the installer as USB mass storage (matches how the
        // ISO boots on real hardware — the builder writes it to a USB stick).
        // `FLAGSHIP_VM_ISO_MODE=block` is a documented fallback that attaches it
        // as a virtio-block device instead, for a base ISO whose EFI entry the
        // USB path won't boot. Both booted a native-arch (arm64) Debian netinst
        // in Phase-0 bring-up.
        let isoMode = ProcessInfo.processInfo.environment["FLAGSHIP_VM_ISO_MODE"] ?? "usb"
        if attachInstallerISO {
            let iso = try VZDiskImageStorageDeviceAttachment(
                url: layout.installerISOURL(name), readOnly: true)
            if isoMode == "block" {
                storage.append(VZVirtioBlockDeviceConfiguration(attachment: iso))
            } else {
                storage.append(VZUSBMassStorageDeviceConfiguration(attachment: iso))
            }
        }
        vz.storageDevices = storage
        if isoMode != "block", #available(macOS 15.0, *) {
            // VZUSBMassStorageDeviceConfiguration needs an XHCI controller to be
            // enumerated by the guest firmware (macOS 15+).
            vz.usbControllers = [VZXHCIControllerConfiguration()]
        }

        // NAT: outbound-only is all the appliance needs (it dials out to
        // .com/.services; user traffic arrives over the tunnel). Bridged mode
        // needs the com.apple.vm.networking entitlement — future work.
        guard config.networkMode == .nat else { throw VZHostError.unsupportedNetworkMode }
        let net = VZVirtioNetworkDeviceConfiguration()
        net.attachment = VZNATNetworkDeviceAttachment()
        vz.networkDevices = [net]

        vz.entropyDevices = [VZVirtioEntropyDeviceConfiguration()]
        vz.memoryBalloonDevices = [VZVirtioTraditionalMemoryBalloonDeviceConfiguration()]

        // Serial console — ONLY when the pure layer said so (debug grant
        // present in the recipe). A production VM gets NO console device;
        // and the host app must never mount a production VM's disk or inject
        // users to work around that. This gate is the recipe's phone-signed
        // consent, not a UI preference.
        if config.serialConsoleEnabled, let pipes = consolePipes {
            let serial = VZVirtioConsoleDeviceSerialPortConfiguration()
            serial.attachment = VZFileHandleSerialPortAttachment(
                fileHandleForReading: pipes.input.fileHandleForReading,
                fileHandleForWriting: pipes.output.fileHandleForWriting)
            vz.serialPorts = [serial]
        }

        try vz.validate()
        return vz
    }

    // MARK: - Control

    func start(config: VMConfig, layout: VMBundleLayout, attachInstallerISO: Bool) async throws {
        var pipes: (input: Pipe, output: Pipe)? = nil
        if config.serialConsoleEnabled {
            let p = (input: Pipe(), output: Pipe())
            pipes = p
            consoleInput = p.input.fileHandleForWriting
            consoleOutput = p.output.fileHandleForReading
        } else {
            consoleInput = nil
            consoleOutput = nil
        }
        let vzConfig = try Self.makeConfiguration(config: config,
                                                  layout: layout,
                                                  attachInstallerISO: attachInstallerISO,
                                                  consolePipes: pipes)
        let vm = VZVirtualMachine(configuration: vzConfig)
        vm.delegate = self
        machine = vm
        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
            vm.start { result in
                switch result {
                case .success: cont.resume()
                case .failure(let error): cont.resume(throwing: error)
                }
            }
        }
    }

    func stop() async throws {
        guard let vm = machine else { return }
        if vm.state == .running && vm.canRequestStop {
            // Ask the guest first (ACPI power button) — the daemon flushes.
            try vm.requestStop()
        } else if vm.canStop {
            try await vm.stop()
        }
    }

    func forceStop() async throws {
        guard let vm = machine, vm.canStop else { return }
        try await vm.stop()
    }

    func pause() async throws {
        guard let vm = machine, vm.canPause else { return }
        try await vm.pause()
    }

    func resume() async throws {
        guard let vm = machine, vm.canResume else { return }
        try await vm.resume()
    }

    /// Create the sparse main disk if it doesn't exist yet (APFS keeps it
    /// thin; the guest grows into it).
    static func ensureMainDisk(config: VMConfig, layout: VMBundleLayout) throws {
        let url = layout.diskImageURL(config.name)
        guard !FileManager.default.fileExists(atPath: url.path) else { return }
        FileManager.default.createFile(atPath: url.path, contents: nil)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
        let handle = try FileHandle(forWritingTo: url)
        defer { try? handle.close() }
        try handle.truncate(atOffset: config.mainDiskSizeBytes)
    }
}

extension VZHost: VZVirtualMachineDelegate {
    nonisolated func guestDidStop(_ virtualMachine: VZVirtualMachine) {
        Task { @MainActor in
            self.machine = nil
            self.onGuestStopped?(nil)
        }
    }

    nonisolated func virtualMachine(_ virtualMachine: VZVirtualMachine, didStopWithError error: Error) {
        Task { @MainActor in
            self.machine = nil
            self.onGuestStopped?(error)
        }
    }
}
#endif
