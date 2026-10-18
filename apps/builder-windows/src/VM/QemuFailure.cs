using System;
using System.Linq;
using System.Text.RegularExpressions;

namespace Flagship.Builder.VM;

/// <summary>
/// Plain failure text for a hosted VM's QEMU. Studio checks free RAM before
/// launching and, when QEMU still dies, shows the memory sentence for an
/// out-of-memory failure and otherwise only the LAST meaningful stderr line:
/// blank lines and <c>warning:</c> lines (the repeated host-CPUID feature
/// warnings) are dropped and the <c>qemu-system-*</c> program prefix is
/// stripped. A second 4 GiB VM started with under 5 GB free showed the raw
/// stderr in the sidebar (2026-10-18). Mirrors apps/builder-linux
/// vm/qemu_failure.py; pinned by vm-core-vectors.json "qemuFailure".
/// </summary>
public static class QemuFailure
{
    /// <summary>WHPX maps the guest's whole RAM up front and QEMU needs some
    /// of its own on top: leave a GiB beyond the guest's memory.</summary>
    public const ulong WhpxHeadroomBytes = VMResourcePlan.GiB;

    private static readonly Regex ProgramPrefix = new(
        @"^.*?qemu-system-[A-Za-z0-9_]+(?:\.exe)?:\s*", RegexOptions.CultureInvariant);

    private static readonly string[] OutOfMemory =
    {
        "failed to map gpa range", "cannot allocate memory", "out of memory", "failed to allocate",
    };

    public static string NotEnoughMemoryMessage(ulong needBytes)
    {
        var gib = (needBytes + VMResourcePlan.GiB - 1) / VMResourcePlan.GiB;
        return $"Not enough free memory: this server needs {gib} GiB. Close other apps and try again.";
    }

    /// <summary>Null when the host has enough free RAM (or can't tell),
    /// otherwise the plain sentence to show instead of launching.</summary>
    public static string? CheckFreeMemory(ulong needBytes, ulong? availableBytes, ulong headroomBytes)
        => availableBytes is null || availableBytes.Value >= needBytes + headroomBytes
            ? null
            : NotEnoughMemoryMessage(needBytes);

    public static string LastMeaningfulLine(string stderr)
    {
        var last = stderr.Split('\n')
            .Select(l => l.Trim())
            .LastOrDefault(l => l.Length > 0 && !l.Contains("warning:", StringComparison.Ordinal));
        return last is null ? "" : ProgramPrefix.Replace(last, "", 1).Trim();
    }

    public static string DescribeExit(int exitCode, string stderr, ulong memoryBytes)
    {
        var lowered = stderr.ToLowerInvariant();
        if (OutOfMemory.Any(lowered.Contains)) return NotEnoughMemoryMessage(memoryBytes);
        var line = LastMeaningfulLine(stderr);
        return line.Length == 0
            ? $"QEMU stopped unexpectedly (exit {exitCode})."
            : $"QEMU stopped (exit {exitCode}): {line}";
    }
}
