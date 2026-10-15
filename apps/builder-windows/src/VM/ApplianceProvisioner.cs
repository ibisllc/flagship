using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace Flagship.Builder.VM;

/// <summary>
/// The one-use specialization seed a new hosted server reads: an 80-byte
/// ASCII header (magic, body length, body SHA-256), the compact JSON body,
/// then zeros to a fixed size. Byte-identical to the reference
/// packages/flagship-builder appliance.ts encodeApplianceSeed, pinned by the
/// shared vm-core-vectors.json "applianceSeed" section.
/// </summary>
public static class ApplianceSeed
{
    public const string Magic = "FLSHSD01";
    public const int HeaderBytes = 80;
    public const int SizeBytes = 8 * 1024 * 1024;

    public static byte[] Encode(byte[] recipe, string bootstrap)
    {
        var body = Encoding.UTF8.GetBytes(
            "{\"version\":1,\"recipeBase64\":\"" + Convert.ToBase64String(recipe)
            + "\",\"bootstrapBase64\":\"" + Convert.ToBase64String(Encoding.UTF8.GetBytes(bootstrap))
            + "\",\"recipeSha256\":\"" + Sha256Hex(recipe) + "\"}");
        if (body.Length > SizeBytes - HeaderBytes)
            throw new InvalidDataException("appliance seed payload is too large");
        var header = Encoding.ASCII.GetBytes(Magic + body.Length.ToString("x8") + Sha256Hex(body));
        var seed = new byte[SizeBytes];
        header.CopyTo(seed, 0);
        body.CopyTo(seed, HeaderBytes);
        return seed;
    }

    internal static string Sha256Hex(byte[] data) => Convert.ToHexString(SHA256.HashData(data)).ToLowerInvariant();
}

/// <summary>
/// Turns a verified base into one new server: a thin qcow2 overlay that
/// reads from the base, plus the seed carrying the install blob and the
/// canonical bootstrap. Nothing owner-specific is ever written to the base.
/// Mirrors the Mac ApplianceProvisioner and the CLI's appliance-provision.
/// </summary>
public static class ApplianceProvisioner
{
    private static readonly byte[] Qcow2Magic = { 0x51, 0x46, 0x49, 0xfb };

    /// <summary>Check a base against its runtime manifest: arch, installer
    /// ref, size and SHA-256. Throws InvalidDataException with the reason.</summary>
    public static ApplianceBaseManifest Verify(string basePath, string expectedArch, string installerGitRef)
    {
        if (!File.Exists(basePath)) throw new InvalidDataException($"The prebuilt server image is missing: {basePath}");
        var m = ApplianceBaseManifest.TryLoad(basePath)
            ?? throw new InvalidDataException("The prebuilt server image's manifest is missing or malformed.");
        if (m.Version != 1 || m.SizeBytes <= 0 || m.VirtualSizeBytes < m.SizeBytes
            || m.Sha256.Length != 64)
            throw new InvalidDataException("The prebuilt server image's manifest is malformed.");
        if (m.Arch != expectedArch)
            throw new InvalidDataException($"The prebuilt server image is for {m.Arch}, but this PC needs {expectedArch}.");
        if (m.InstallerGitRef != installerGitRef)
            throw new InvalidDataException($"The prebuilt server image contains installer ref {m.InstallerGitRef}, but this recipe requires {installerGitRef}.");
        var size = new FileInfo(basePath).Length;
        if (size != m.SizeBytes)
            throw new InvalidDataException($"The prebuilt server image has {size} bytes, but its manifest declares {m.SizeBytes}.");
        var got = ApplianceCache.RangeSha256(basePath, 0, size);
        if (got != m.Sha256)
            throw new InvalidDataException("The prebuilt server image failed its integrity check.");
        return m;
    }

    /// <summary>The qemu-img arguments for the server's overlay disk.</summary>
    public static string[] OverlayArgs(string basePath, string diskPath, long sizeBytes) =>
        new[]
        {
            "create", "-f", "qcow2", "-F", IsQcow2(basePath) ? "qcow2" : "raw",
            "-b", Path.GetFullPath(basePath), diskPath, sizeBytes.ToString(System.Globalization.CultureInfo.InvariantCulture),
        };

    /// <summary>Write the seed and the overlay. runQemuImg runs qemu-img
    /// with the given arguments (tests pass a fake). A failure leaves neither
    /// behind.</summary>
    public static async Task ProvisionAsync(VMConfig config, VMBundleLayout layout, string basePath,
                                            ApplianceBaseManifest manifest, byte[] installBlob, string bootstrap,
                                            Func<string[], CancellationToken, Task> runQemuImg,
                                            CancellationToken ct = default)
    {
        if (config.MainDiskSizeBytes < (ulong)manifest.VirtualSizeBytes)
            throw new InvalidDataException(
                $"The hosted-server disk is too small for this image (needs {manifest.VirtualSizeBytes} bytes; configured for {config.MainDiskSizeBytes}).");
        var seedPath = layout.ApplianceSeedPath(config.Name);
        var diskPath = layout.DiskImagePath(config.Name);
        await File.WriteAllBytesAsync(seedPath, ApplianceSeed.Encode(installBlob, bootstrap), ct);
        try
        {
            await runQemuImg(OverlayArgs(basePath, diskPath, (long)config.MainDiskSizeBytes), ct);
        }
        catch
        {
            try { File.Delete(seedPath); } catch { }
            try { File.Delete(diskPath); } catch { }
            throw;
        }
    }

    public static async Task RunQemuImgAsync(string imgBinary, string[] args, CancellationToken ct)
    {
        var psi = new ProcessStartInfo
        {
            FileName = imgBinary,
            RedirectStandardError = true,
            RedirectStandardOutput = true,
            UseShellExecute = false,
            CreateNoWindow = true,
        };
        foreach (var a in args) psi.ArgumentList.Add(a);
        using var p = Process.Start(psi) ?? throw new IOException("qemu-img spawn failed");
        var stderr = p.StandardError.ReadToEndAsync(ct);
        _ = p.StandardOutput.ReadToEndAsync(ct);
        await p.WaitForExitAsync(ct);
        if (p.ExitCode != 0)
            throw new IOException($"qemu-img create failed ({p.ExitCode}): {(await stderr).Trim()}");
    }

    public static bool IsQcow2(string path)
    {
        try
        {
            using var fs = File.OpenRead(path);
            var magic = new byte[4];
            return fs.Read(magic, 0, 4) == 4 && magic.AsSpan().SequenceEqual(Qcow2Magic);
        }
        catch { return false; }
    }

    /// <summary>The backing file a qcow2 image names in its header, or null.</summary>
    public static string? Qcow2BackingFile(string path)
    {
        try
        {
            using var fs = File.OpenRead(path);
            var header = new byte[20];
            if (fs.Read(header, 0, 20) != 20 || !header.AsSpan(0, 4).SequenceEqual(Qcow2Magic)) return null;
            var offset = System.Buffers.Binary.BinaryPrimitives.ReadInt64BigEndian(header.AsSpan(8, 8));
            var size = System.Buffers.Binary.BinaryPrimitives.ReadInt32BigEndian(header.AsSpan(16, 4));
            if (offset <= 0 || size <= 0 || size > 4096) return null;
            fs.Seek(offset, SeekOrigin.Begin);
            var name = new byte[size];
            return fs.Read(name, 0, size) == size ? Encoding.UTF8.GetString(name) : null;
        }
        catch { return null; }
    }

    /// <summary>Full paths of the bases the given server disks read from.</summary>
    public static ISet<string> BackingFilesInUse(IEnumerable<string> disks)
    {
        var used = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var disk in disks)
        {
            if (Qcow2BackingFile(disk) is not { } backing) continue;
            used.Add(Path.GetFullPath(Path.IsPathRooted(backing)
                ? backing
                : Path.Combine(Path.GetDirectoryName(disk) ?? "", backing)));
        }
        return used;
    }
}
