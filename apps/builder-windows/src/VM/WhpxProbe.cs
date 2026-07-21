using System;
using System.Diagnostics;
using System.Threading;
using System.Threading.Tasks;

namespace Flagship.Builder.VM;

/// <summary>
/// Whether this machine can actually host a VM under WHPX, with an HONEST,
/// actionable reason when it can't. Detection is empirical: spawn
/// qemu-system-x86_64 -accel whpx frozen at startup (-S) — a broken WHPX
/// setup exits within a second with a diagnostic on stderr; a working one
/// keeps running (and is killed). Classification is pure and unit-tested;
/// the spawn is the only impure part.
/// </summary>
public enum WhpxVerdictKind
{
    Available,
    /// <summary>The Windows Hypervisor Platform optional feature is off — one
    /// elevated enable + a reboot fixes it.</summary>
    HypervisorPlatformDisabled,
    /// <summary>CPU virtualization (VT-x / AMD-V) is disabled in firmware.</summary>
    VirtualizationDisabledInFirmware,
    /// <summary>QEMU missing or firmware files broken.</summary>
    QemuNotUsable,
    Unknown,
}

public sealed record WhpxVerdict(WhpxVerdictKind Kind, string Message)
{
    public bool IsAvailable => Kind == WhpxVerdictKind.Available;
}

public static class WhpxProbe
{
    /// <summary>Pure classifier over QEMU's stderr after a failed -accel whpx
    /// start. Kept separate from the spawn so it's unit-testable.</summary>
    public static WhpxVerdict Classify(int exitCode, string stderr)
    {
        if (exitCode == 0) return new WhpxVerdict(WhpxVerdictKind.Available, "WHPX is available.");
        var s = stderr.ToLowerInvariant();
        if (s.Contains("whpx") && (s.Contains("not present") || s.Contains("no accelerator") ||
                                   s.Contains("failed to setup") || s.Contains("initialization failed") ||
                                   s.Contains("whv_e_unknown_capability") || s.Contains("not installed")))
        {
            // WHPX itself refused. Distinguish "feature off" from "VT-x off"
            // where the message allows; both need owner action outside the app.
            if (s.Contains("vmx") || s.Contains("svm") || s.Contains("firmware") || s.Contains("bios"))
                return new WhpxVerdict(WhpxVerdictKind.VirtualizationDisabledInFirmware,
                    "CPU virtualization (Intel VT-x / AMD-V) is disabled in your PC's firmware. " +
                    "Enable it in BIOS/UEFI settings, then try again.");
            return new WhpxVerdict(WhpxVerdictKind.HypervisorPlatformDisabled,
                "The Windows Hypervisor Platform feature is turned off. Enable it under " +
                "\"Turn Windows features on or off\" → \"Windows Hypervisor Platform\", reboot, and try again.");
        }
        if (s.Contains("could not load") || s.Contains("no such file") || s.Contains("pflash"))
            return new WhpxVerdict(WhpxVerdictKind.QemuNotUsable,
                "QEMU is installed but its firmware files are missing or unreadable — reinstall QEMU.");
        return new WhpxVerdict(WhpxVerdictKind.Unknown,
            $"Could not start the virtual machine engine: {Truncate(stderr.Trim(), 300)}");
    }

    /// <summary>Live probe. graceMs: how long a surviving process counts as success.</summary>
    public static async Task<WhpxVerdict> RunAsync(QemuToolchain toolchain,
                                                   int graceMs = 4000,
                                                   CancellationToken cancellation = default)
    {
        var psi = new ProcessStartInfo
        {
            FileName = toolchain.SystemBinary,
            Arguments = "-accel whpx -display none -m 128 -S -monitor none -serial none -nodefaults",
            RedirectStandardError = true,
            RedirectStandardOutput = true,
            UseShellExecute = false,
            CreateNoWindow = true,
        };
        Process p;
        try { p = Process.Start(psi) ?? throw new InvalidOperationException("spawn returned null"); }
        catch (Exception e)
        {
            return new WhpxVerdict(WhpxVerdictKind.QemuNotUsable, $"Could not launch QEMU: {e.Message}");
        }

        using (p)
        {
            var stderrTask = p.StandardError.ReadToEndAsync(cancellation);
            var exited = await Task.Run(() => p.WaitForExit(graceMs), cancellation);
            if (!exited)
            {
                // Still running after the grace period ⇒ WHPX initialized.
                try { p.Kill(entireProcessTree: true); } catch { }
                try { p.WaitForExit(2000); } catch { }
                return new WhpxVerdict(WhpxVerdictKind.Available, "WHPX is available.");
            }
            var stderr = await stderrTask;
            return Classify(p.ExitCode, stderr);
        }
    }

    private static string Truncate(string s, int max) => s.Length <= max ? s : s[..max] + "…";
}
