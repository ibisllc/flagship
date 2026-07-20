using System;
using System.Linq;
using Xunit;
using Flagship.Builder.VM;

namespace Flagship.Builder.Tests;

/// <summary>
/// The pure argv builder — the Windows analog of VZHost.makeConfiguration.
/// Pins the security-relevant shape: the debug-grant console gate, the
/// install-phase ISO attach + -no-reboot, UEFI pflash wiring, NAT-only.
/// </summary>
public class QemuCommandLineTests
{
    private static VMConfig Config(bool console = false) => new()
    {
        Name = "home.harry.flagship.services",
        ServerDomain = "home.harry.flagship.services",
        Username = "harry",
        ServerName = "home",
        CpuCount = 4,
        MemoryBytes = 6 * VMResourcePlan.GiB,
        MainDiskSizeBytes = VMResourcePlan.DefaultMainDiskSizeBytes,
        NetworkMode = VMNetworkMode.Nat,
        SerialConsoleEnabled = console,
        BootUnlockMode = "auto",
        DiskEncrypted = true,
    };

    private static readonly VMBundleLayout Layout = new(@"C:\vms");
    private const string Code = @"C:\qemu\share\edk2-x86_64-code.fd";

    private static string Joined(string[] args) => string.Join(" ", args);

    // ---- Resources + machine shape ----

    [Fact]
    public void CarriesCpuMemoryAndMachineType()
    {
        var args = QemuCommandLine.Build(Config(), Layout, Code, false, 4444, 0);
        var s = Joined(args);
        Assert.Contains("-machine q35", s);
        // The stable WHPX APIC configuration.
        Assert.Contains("-accel whpx,kernel-irqchip=off", s);
        Assert.Contains("-smp 4", s);
        Assert.Contains("-m 6144M", s);
        Assert.Contains("-display none", s);
    }

    [Fact]
    public void WhpxMasksVmxAndSgxSoOvmfBoots()
    {
        // `-cpu max` under WHPX exposes VMX+SGX; OVMF then writes
        // IA32_FEATURE_CONTROL (MSR 0x3A), unimplemented by WHPX → #GP in
        // PlatformPei, firmware never boots. Found live on this box.
        var s = Joined(QemuCommandLine.Build(Config(), Layout, Code, false, 4444, 0));
        Assert.Contains("-cpu max,vmx=off,sgx=off,sgxlc=off", s);
    }

    [Fact]
    public void WiresUefiCodeReadonlyAndPerVmVars()
    {
        var args = QemuCommandLine.Build(Config(), Layout, Code, false, 4444, 0);
        var s = Joined(args);
        Assert.Contains($"if=pflash,format=raw,readonly=on,file={Code}", s);
        Assert.Contains(@"if=pflash,format=raw,file=C:\vms\home.harry.flagship.services\efi-vars.fd", s);
    }

    [Fact]
    public void MainDiskIsSataSoTheGuestSeesMetalIdenticalSda()
    {
        // The preseed targets `list-devices disk | head -n1`. A virtio main
        // disk is vda, which sorts AFTER the USB installer stick's sda — d-i
        // then installs onto the 755MB stick and fails. AHCI reproduces the
        // metal order (sda = system disk, sdb = installer). Found live.
        var s = Joined(QemuCommandLine.Build(Config(), Layout, Code, false, 4444, 0));
        Assert.Contains(@"id=flagship-main,if=none,format=qcow2,file=C:\vms\home.harry.flagship.services\disk.qcow2", s);
        Assert.Contains("ide-hd,drive=flagship-main", s);
        Assert.DoesNotContain("if=virtio,format=qcow2", s);
    }

    // ---- The install seam ----

    [Fact]
    public void InstallPhaseAttachesIsoAsUsbAndSetsNoReboot()
    {
        var s = Joined(QemuCommandLine.Build(Config(), Layout, Code, attachInstallerISO: true, 4444, 0));
        Assert.Contains("qemu-xhci", s);
        Assert.Contains(@"installer.iso", s);
        Assert.Contains("usb-storage,drive=flagship-installer", s);
        Assert.Contains("readonly=on", s);
        // A completed install ends in poweroff OR reboot; -no-reboot turns
        // both into a clean exit for the duration-gated verdict.
        Assert.Contains("-no-reboot", s);
    }

    [Fact]
    public void BootFromDiskHasNoIsoAndAllowsReboot()
    {
        var s = Joined(QemuCommandLine.Build(Config(), Layout, Code, attachInstallerISO: false, 4444, 0));
        Assert.DoesNotContain("installer.iso", s);
        Assert.DoesNotContain("usb-storage", s);
        Assert.DoesNotContain("-no-reboot", s);
    }

    // ---- The debug-console hard guardrail ----

    [Fact]
    public void ProductionVmGetsNoSerialDevice()
    {
        var args = QemuCommandLine.Build(Config(console: false), Layout, Code, false, 4444, 0);
        var s = Joined(args);
        Assert.Contains("-serial none", s);
        Assert.DoesNotContain("chardev:ser0", s);
        Assert.DoesNotContain("console.log", s);
    }

    [Fact]
    public void DebugVmGetsSerialSocketWithTranscript()
    {
        var s = Joined(QemuCommandLine.Build(Config(console: true), Layout, Code, false, 4444, 5555));
        Assert.Contains("port=5555", s);
        Assert.Contains("-serial chardev:ser0", s);
        Assert.Contains(@"logfile=C:\vms\home.harry.flagship.services\console.log", s);
        Assert.Contains("host=127.0.0.1", s);
    }

    // ---- Control + networking ----

    [Fact]
    public void QmpIsLoopbackOnly()
    {
        var s = Joined(QemuCommandLine.Build(Config(), Layout, Code, false, 4444, 0));
        Assert.Contains("-qmp tcp:127.0.0.1:4444,server=on,wait=off", s);
    }

    [Fact]
    public void NetworkingIsUserModeNat()
    {
        var s = Joined(QemuCommandLine.Build(Config(), Layout, Code, false, 4444, 0));
        Assert.Contains("-netdev user,id=net0", s);
        Assert.Contains("virtio-net-pci,netdev=net0", s);
    }

    [Fact]
    public void AccelIsOverridableForCi()
    {
        var s = Joined(QemuCommandLine.Build(Config(), Layout, Code, false, 4444, 0, accel: "tcg"));
        Assert.Contains("-accel tcg", s);
        Assert.DoesNotContain("whpx", s);
    }

    // ---- SSH host-forward (debug VMs only) ----

    [Fact]
    public void DebugVmGetsSshHostForward()
    {
        var s = Joined(QemuCommandLine.Build(Config(console: true), Layout, Code,
            attachInstallerISO: false, 4444, 5555, sshHostPort: 2222));
        Assert.Contains("-netdev user,id=net0,hostfwd=tcp:127.0.0.1:2222-:22", s);
    }

    [Fact]
    public void NoSshForwardWhenPortIsZero()
    {
        var s = Joined(QemuCommandLine.Build(Config(console: true), Layout, Code, false, 4444, 5555, sshHostPort: 0));
        Assert.Contains("-netdev user,id=net0 ", s + " ");
        Assert.DoesNotContain("hostfwd", s);
    }

    [Fact]
    public void RefusesSshForwardForAProductionVm()
    {
        // The SSH forward is gated on the same debug grant as the console — a
        // production VM must never expose :22.
        Assert.Throws<ArgumentException>(() =>
            QemuCommandLine.Build(Config(console: false), Layout, Code, false, 4444, 0, sshHostPort: 2222));
    }
}
