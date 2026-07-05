using System;
using System.Collections.Generic;
using System.Globalization;

namespace Flagship.Burner.VM;

/// <summary>
/// PURE argv builder: a VMConfig (all decisions already made) + bundle layout
/// → the qemu-system-x86_64 argument vector. The analog of the Mac's
/// VZHost.makeConfiguration — deliberately dumb, fully unit-testable without
/// QEMU. QemuHost spawns the process; this file never touches one.
/// </summary>
public static class QemuCommandLine
{
    /// <summary>
    /// uefiCodePath: the shared readonly edk2 code image from the located
    /// toolchain (only the VARS half is per-VM).
    ///
    /// attachInstallerISO mirrors the lifecycle's attach/detach effects: true
    /// during the install phase, false for every boot from disk. It also sets
    /// -no-reboot so a completed-install reboot surfaces as a clean process
    /// exit — which the duration-gated verdict then classifies
    /// (VMLifecycle.VerdictForCleanInstallStop).
    ///
    /// qmpPort: loopback TCP port for the QMP control socket (clean shutdown +
    /// guest-stop events). serialPort: loopback TCP port for the serial
    /// console — ONLY used when the pure layer said so (debug grant present in
    /// the recipe). A production VM gets `-serial none`: no console endpoint
    /// of any kind, and the host app must never mount its disk or inject
    /// users to work around that (the gate is the recipe's phone-signed
    /// consent, not a UI preference).
    ///
    /// accel: "whpx" in production; tests / CI without a hypervisor may pass
    /// "tcg".
    /// </summary>
    public static string[] Build(VMConfig config,
                                 VMBundleLayout layout,
                                 string uefiCodePath,
                                 bool attachInstallerISO,
                                 int qmpPort,
                                 int serialPort,
                                 int sshHostPort = 0,
                                 string accel = "whpx")
    {
        if (config.NetworkMode != VMNetworkMode.Nat)
            throw new ArgumentException("Unsupported network mode for this VM.");
        // The SSH host-forward is gated on the SAME debug grant as the serial
        // console: a production VM gets neither. Never forward :22 for a box
        // the owner didn't authorize for debug.
        if (sshHostPort > 0 && !config.SerialConsoleEnabled)
            throw new ArgumentException("Refusing to forward SSH for a production (non-debug) VM.");

        var name = config.Name;
        // WHPX quirks, found empirically on real hardware (Win11 Home, QEMU 11):
        //   - `-cpu max` exposes VMX and SGX; OVMF then writes
        //     IA32_FEATURE_CONTROL (MSR 0x3A), which WHPX doesn't emulate →
        //     #GP in PlatformPei and the firmware never boots. Mask BOTH
        //     (vmx=off alone still leaves OVMF locking the SGX bits).
        //   - kernel-irqchip=off is the stable WHPX APIC configuration.
        var accelArg = accel == "whpx" ? "whpx,kernel-irqchip=off" : accel;
        var cpuArg = accel == "whpx" ? "max,vmx=off,sgx=off,sgxlc=off" : "max";
        var args = new List<string>
        {
            "-name", name,
            "-machine", "q35",
            "-accel", accelArg,
            "-cpu", cpuArg,
            "-smp", config.CpuCount.ToString(CultureInfo.InvariantCulture),
            "-m", (config.MemoryBytes / (1024 * 1024)).ToString(CultureInfo.InvariantCulture) + "M",

            // EFI firmware + per-VM persistent variable store (the analog of
            // VZEFIBootLoader + VZEFIVariableStore). The remastered Debian
            // netinst is UEFI-bootable; edk2 reads its El Torito/UEFI entry
            // directly, so the remaster's grub.cfg preseed cmdline is honored.
            "-drive", $"if=pflash,format=raw,readonly=on,file={uefiCodePath}",
            "-drive", $"if=pflash,format=raw,file={layout.EfiVariableStorePath(name)}",

            // Main disk on the q35 built-in AHCI so the guest sees /dev/sda —
            // METAL-IDENTICAL naming. The preseed's partman/early_command
            // targets `list-devices disk | head -n1`; with a virtio main disk
            // (vda) the USB installer stick becomes sda and d-i tries to
            // install onto the 755MB stick ("failed to partition: too small",
            // found live). SATA main + USB installer reproduces the metal
            // order: sda = system disk, sdb = installer.
            "-drive", $"id=flagship-main,if=none,format=qcow2,file={layout.DiskImagePath(name)}",
            "-device", "ide-hd,drive=flagship-main",
        };

        if (attachInstallerISO)
        {
            // USB mass storage matches how the ISO boots on real hardware
            // (the burner writes it to a USB stick) — the same isohybrid
            // image, the same EFI boot entry.
            args.AddRange(new[]
            {
                "-device", "qemu-xhci",
                "-drive", $"id=flagship-installer,if=none,format=raw,readonly=on,file={layout.InstallerIsoPath(name)}",
                "-device", "usb-storage,drive=flagship-installer",
                // A completed install ends in poweroff OR reboot; -no-reboot
                // turns both into a clean exit for the duration-gated verdict.
                "-no-reboot",
            });
        }

        // User-mode NAT: outbound-only is all the appliance needs (it dials
        // out to .com/.services; user traffic arrives over the tunnel). For a
        // debug VM we additionally forward a loopback host port to the guest's
        // :22 so "Open in SSH" can reach it without hunting a LAN IP — the
        // metal debug affordance, host-driven.
        var netdev = sshHostPort > 0
            ? $"user,id=net0,hostfwd=tcp:127.0.0.1:{sshHostPort}-:22"
            : "user,id=net0";
        args.AddRange(new[]
        {
            "-netdev", netdev,
            "-device", "virtio-net-pci,netdev=net0",
            "-device", "virtio-rng-pci",
        });

        // QMP control socket (loopback only): clean system_powerdown + the
        // SHUTDOWN event stream.
        args.AddRange(new[]
        {
            "-qmp", $"tcp:127.0.0.1:{qmpPort},server=on,wait=off",
        });

        if (config.SerialConsoleEnabled)
        {
            // Interactive console over loopback TCP + a persistent transcript
            // in console.log (chardev logfile captures output even when no
            // client is attached).
            args.AddRange(new[]
            {
                "-chardev", $"socket,id=ser0,host=127.0.0.1,port={serialPort},server=on,wait=off,logfile={layout.ConsoleLogPath(name)},logappend=on",
                "-serial", "chardev:ser0",
            });
        }
        else
        {
            args.AddRange(new[] { "-serial", "none" });
        }

        // Headless: the appliance has no GUI; all interaction is phone/web.
        args.AddRange(new[] { "-display", "none" });

        return args.ToArray();
    }
}
