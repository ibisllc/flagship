using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;

namespace Flagship.Burner.VM;

/// <summary>
/// Locates the QEMU toolchain + UEFI firmware on this machine. Mirrors
/// CliLocator's philosophy: env override first, then well-known install
/// locations, then PATH. Pure path logic is injectable for tests.
/// </summary>
public sealed record QemuToolchain(
    string SystemBinary,     // qemu-system-x86_64.exe
    string ImgBinary,        // qemu-img.exe
    string UefiCodePath,     // share/edk2-x86_64-code.fd (readonly pflash)
    string UefiVarsTemplate) // share/edk2-i386-vars.fd (per-VM copy template)
{
    /// <summary>The vars template is copied per-VM so each guest keeps its own
    /// NVRAM (boot entries etc.) — the analog of VZEFIVariableStore.</summary>
    public const string VarsTemplateFileName = "edk2-i386-vars.fd";
    public const string CodeFileName = "edk2-x86_64-code.fd";
}

public sealed class QemuLocatorException : Exception
{
    public QemuLocatorException(string message) : base(message) { }
}

public static class QemuLocator
{
    /// <summary>Env override for a non-standard QEMU install root (the dir
    /// holding qemu-system-x86_64.exe).</summary>
    public const string EnvOverride = "FLAGSHIP_QEMU_ROOT";

    public static QemuToolchain Locate() => Locate(Environment.GetEnvironmentVariable(EnvOverride), DefaultRoots());

    /// <summary>Injectable core for tests.</summary>
    public static QemuToolchain Locate(string? envRoot, IEnumerable<string> candidateRoots)
    {
        var roots = new List<string>();
        if (!string.IsNullOrEmpty(envRoot)) roots.Add(envRoot);
        roots.AddRange(candidateRoots);

        foreach (var root in roots)
        {
            var sys = Path.Combine(root, "qemu-system-x86_64.exe");
            if (!File.Exists(sys)) continue;
            var img = Path.Combine(root, "qemu-img.exe");
            var code = Path.Combine(root, "share", QemuToolchain.CodeFileName);
            var vars = Path.Combine(root, "share", QemuToolchain.VarsTemplateFileName);
            if (!File.Exists(img))
                throw new QemuLocatorException($"Found QEMU at {root} but qemu-img.exe is missing — reinstall QEMU.");
            if (!File.Exists(code) || !File.Exists(vars))
                throw new QemuLocatorException(
                    $"Found QEMU at {root} but the bundled UEFI firmware (share\\{QemuToolchain.CodeFileName}) is missing — reinstall QEMU.");
            return new QemuToolchain(sys, img, code, vars);
        }

        throw new QemuLocatorException(
            "QEMU is not installed. Install it with: winget install SoftwareFreedomConservancy.QEMU " +
            $"(or set {EnvOverride} to your QEMU folder).");
    }

    private static IEnumerable<string> DefaultRoots()
    {
        var pf = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
        if (!string.IsNullOrEmpty(pf)) yield return Path.Combine(pf, "qemu");
        // PATH entries that contain the binary.
        var path = Environment.GetEnvironmentVariable("PATH") ?? "";
        foreach (var dir in path.Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries))
        {
            string full;
            try { full = Path.GetFullPath(dir.Trim()); } catch { continue; }
            yield return full;
        }
    }
}
