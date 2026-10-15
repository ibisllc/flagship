using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Flagship.Builder;
using Flagship.Builder.VM;
using Xunit;

namespace Flagship.Builder.Tests;

/// <summary>
/// Hosting from the published appliance: download + per-part and
/// whole-archive verification, cache reuse, offline reuse, installer
/// fallback, disk-space refusal, pruning that never deletes a base a server
/// still reads from, the seed every port writes, and turning a base into a
/// server. Mirrors the Mac ApplianceCacheTests and the Linux
/// test_appliance_cache.py. No network and no qemu-img: both are fakes.
/// </summary>
public sealed class ApplianceCacheTests : IDisposable
{
    private static readonly byte[] PartA = new byte[] { 0x51, 0x46, 0x49, 0xfb }
        .Concat(Enumerable.Repeat((byte)'a', 1000)).ToArray();
    private static readonly byte[] PartB = Enumerable.Repeat((byte)'b', 777).ToArray();
    private readonly string _root = Path.Combine(Path.GetTempPath(), $"appliance-tests-{Guid.NewGuid():N}");

    public ApplianceCacheTests() => Directory.CreateDirectory(_root);

    public void Dispose()
    {
        try { Directory.Delete(_root, recursive: true); } catch { }
    }

    private static string Sha(byte[] b) => Convert.ToHexString(SHA256.HashData(b)).ToLowerInvariant();

    private static byte[] Manifest(string gitRef = "main", string arch = "amd64")
    {
        var whole = PartA.Concat(PartB).ToArray();
        return JsonSerializer.SerializeToUtf8Bytes(new Dictionary<string, object>
        {
            ["version"] = 1, ["arch"] = arch, ["installerGitRef"] = gitRef, ["format"] = "qcow2",
            ["sha256"] = Sha(whole), ["sizeBytes"] = whole.Length,
            ["parts"] = new[]
            {
                new Dictionary<string, object> { ["name"] = "part-00", ["sizeBytes"] = PartA.Length, ["sha256"] = Sha(PartA) },
                new Dictionary<string, object> { ["name"] = "part-01", ["sizeBytes"] = PartB.Length, ["sha256"] = Sha(PartB) },
            },
            ["rawSha256"] = new string('0', 64), ["rawSizeBytes"] = 8L * 1024 * 1024 * 1024,
        });
    }

    private sealed class Fakes
    {
        public byte[] Body = Manifest();
        public int Status = 200;
        public string? Corrupt;
        public bool Offline;
        public long? Free;
        public readonly List<string> Downloads = new();

        public Task<(byte[], int)> Fetch(string url, CancellationToken ct)
            => Offline ? throw new HttpRequestException("network unreachable") : Task.FromResult((Body, Status));

        public async Task<int> Download(string url, Stream sink, CancellationToken ct)
        {
            Downloads.Add(url);
            var name = url[(url.LastIndexOf('.') + 1)..];
            var data = name switch { "part-00" => PartA, "part-01" => PartB, _ => null };
            if (data is null) return 404;
            data = (byte[])data.Clone();
            if (name == Corrupt) data[0] ^= 0xff;
            await sink.WriteAsync(data.AsMemory(0, 100), ct);
            await sink.WriteAsync(data.AsMemory(100), ct);
            return 200;
        }
    }

    private ApplianceCache Cache(Fakes f, Func<ISet<string>>? inUse = null) =>
        new("amd64", Path.Combine(_root, "Appliances"), "https://example.test",
            f.Fetch, f.Download, _ => f.Free, inUse);

    [Fact]
    public async Task DownloadsVerifiesAndServesFromCache()
    {
        var f = new Fakes();
        var phases = new List<string>();
        var basePath = await Cache(f).EnsureAsync("main", (p, _) => phases.Add(p));
        Assert.Equal(PartA.Concat(PartB).ToArray(), File.ReadAllBytes(basePath));
        var m = ApplianceBaseManifest.TryLoad(basePath)!;
        Assert.Equal(new ApplianceBaseManifest(1, "amd64", "main", Sha(PartA.Concat(PartB).ToArray()),
                                               PartA.Length + PartB.Length, 8L * 1024 * 1024 * 1024), m);
        var dist = ApplianceDistribution.Parse(Manifest());
        Assert.Equal(new[]
        {
            $"https://example.test/build/iso/{dist.KeyPrefix}.part-00",
            $"https://example.test/build/iso/{dist.KeyPrefix}.part-01",
        }, f.Downloads);
        Assert.Equal("download", phases.First());
        Assert.Contains("verify", phases);
        Assert.Equal("ready", phases.Last());
        Assert.False(File.Exists(basePath + ".partial"));

        Assert.Equal(basePath, await Cache(f).EnsureAsync("main"));
        Assert.Equal(2, f.Downloads.Count);
    }

    [Fact]
    public async Task UsesTheCachedBaseWhenOffline()
    {
        var basePath = await Cache(new Fakes()).EnsureAsync("main");
        Assert.Equal(basePath, await Cache(new Fakes { Offline = true }).EnsureAsync("main"));
        var e = await Assert.ThrowsAsync<ApplianceCacheException>(() => Cache(new Fakes { Offline = true }).EnsureAsync("release-2"));
        Assert.Equal("offline", e.Kind);
        Assert.False(e.FallsBackToInstaller);
    }

    [Fact]
    public async Task RefusesACorruptPartAndKeepsTheVerifiedOneForTheRetry()
    {
        var e = await Assert.ThrowsAsync<ApplianceCacheException>(() => Cache(new Fakes { Corrupt = "part-01" }).EnsureAsync("main"));
        Assert.Equal("checksum", e.Kind);
        Assert.Contains("part-01", e.Message);
        var retry = new Fakes();
        await Cache(retry).EnsureAsync("main");
        Assert.Equal(new[] { "part-01" }, retry.Downloads.Select(u => u[(u.LastIndexOf('.') + 1)..]));
    }

    [Theory]
    [InlineData("404", "unavailable")]
    [InlineData("ref", "ref-mismatch")]
    [InlineData("junk", "invalid-manifest")]
    [InlineData("arm64", "invalid-manifest")]
    public async Task FallsBackWhenNoImageFits(string scenario, string kind)
    {
        var f = scenario switch
        {
            "404" => new Fakes { Body = Array.Empty<byte>(), Status = 404 },
            "ref" => new Fakes { Body = Manifest(gitRef: "release-1") },
            "junk" => new Fakes { Body = Encoding.UTF8.GetBytes("{not json") },
            _ => new Fakes { Body = Manifest(arch: "arm64") },
        };
        var e = await Assert.ThrowsAsync<ApplianceCacheException>(() => Cache(f).EnsureAsync("main"));
        Assert.Equal(kind, e.Kind);
        Assert.True(e.FallsBackToInstaller);
        Assert.Empty(f.Downloads);
        Assert.Null(await ApplianceHosting.EnsurePublishedAsync(Cache(f), "main", (_, _) => { }, _ => { }, default));
    }

    [Fact]
    public async Task StopsBeforeDownloadingWhenTheDiskIsTooFull()
    {
        var f = new Fakes { Free = 1000 };
        var e = await Assert.ThrowsAsync<ApplianceCacheException>(() => Cache(f).EnsureAsync("main"));
        Assert.Equal("insufficient-space", e.Kind);
        Assert.Empty(f.Downloads);
    }

    [Fact]
    public async Task ServerErrorsStopTheRun()
    {
        var f = new Fakes { Body = Array.Empty<byte>(), Status = 503 };
        var e = await Assert.ThrowsAsync<ApplianceCacheException>(
            () => ApplianceHosting.EnsurePublishedAsync(Cache(f), "main", (_, _) => { }, _ => { }, default));
        Assert.Equal("http-status", e.Kind);
    }

    [Fact]
    public async Task ANewReleasePrunesTheOldBaseUnlessAServerReadsFromIt()
    {
        var current = await Cache(new Fakes()).EnsureAsync("main");
        var stale = Path.Combine(Path.GetDirectoryName(Path.GetDirectoryName(current))!, new string('0', 16));
        Directory.CreateDirectory(stale);
        var staleBase = Path.Combine(stale, "base.qcow2");
        File.WriteAllBytes(staleBase, new byte[] { 1 });
        await Cache(new Fakes(), () => new HashSet<string> { Path.GetFullPath(staleBase) }).EnsureAsync("main");
        Assert.True(Directory.Exists(stale));
        await Cache(new Fakes()).EnsureAsync("main");
        Assert.False(Directory.Exists(stale));
        Assert.True(File.Exists(current));
    }

    [Fact]
    public void KeyPrefixMatchesTheFactoryWorkflow()
    {
        var dist = ApplianceDistribution.Parse(Manifest(gitRef: "feat/x y"));
        Assert.Equal($"flagship-vm-appliance-amd64-feat-x-y-{dist.Sha256[..12]}.qcow2", dist.KeyPrefix);
    }

    [Theory]
    [InlineData("amd64")]
    [InlineData("arm64")]
    public void PublishedManifestsParse(string arch)
    {
        var path = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory,
            $"../../../../../../apps/web/public/downloads/FlagshipVMAppliance-{arch}.json"));
        Assert.Equal(arch, ApplianceDistribution.Parse(File.ReadAllBytes(path)).Arch);
    }

    // ---- the seed ----

    [Fact]
    public void SeedMatchesTheSharedVector()
    {
        var path = Path.Combine(AppContext.BaseDirectory, "Resources", "vm-core-vectors.json");
        using var doc = JsonDocument.Parse(File.ReadAllBytes(path));
        var v = doc.RootElement.GetProperty("applianceSeed");
        var seed = ApplianceSeed.Encode(Encoding.UTF8.GetBytes(v.GetProperty("recipe").GetString()!),
                                        v.GetProperty("bootstrap").GetString()!);
        Assert.Equal(v.GetProperty("sizeBytes").GetInt32(), seed.Length);
        Assert.Equal(v.GetProperty("header").GetString(), Encoding.ASCII.GetString(seed, 0, ApplianceSeed.HeaderBytes));
        var body = Encoding.UTF8.GetBytes(v.GetProperty("body").GetString()!);
        Assert.Equal(body, seed.AsSpan(ApplianceSeed.HeaderBytes, body.Length).ToArray());
        Assert.All(seed.Skip(ApplianceSeed.HeaderBytes + body.Length), b => Assert.Equal(0, b));
    }

    // ---- turning a base into a server ----

    private static VMConfig Config(ulong disk = 64UL * 1024 * 1024 * 1024) => new()
    {
        Name = "home.harry.flagship.services",
        ServerDomain = "home.harry.flagship.services",
        Username = "harry",
        ServerName = "home",
        CpuCount = 2,
        MemoryBytes = 4 * VMResourcePlan.GiB,
        MainDiskSizeBytes = disk,
        NetworkMode = VMNetworkMode.Nat,
        SerialConsoleEnabled = false,
        BootUnlockMode = "auto",
        DiskEncrypted = true,
        ProvisioningMode = VMProvisioningMode.PrebuiltAppliance,
    };

    [Fact]
    public async Task VerifyChecksTheBaseAgainstItsManifest()
    {
        var basePath = await Cache(new Fakes()).EnsureAsync("main");
        Assert.Equal("main", ApplianceProvisioner.Verify(basePath, "amd64", "main").InstallerGitRef);
        Assert.Contains("release-1", Assert.Throws<InvalidDataException>(() => ApplianceProvisioner.Verify(basePath, "amd64", "release-1")).Message);
        Assert.Contains("arm64", Assert.Throws<InvalidDataException>(() => ApplianceProvisioner.Verify(basePath, "arm64", "main")).Message);
        var bytes = File.ReadAllBytes(basePath);
        bytes[^1] ^= 0xff;
        File.WriteAllBytes(basePath, bytes);
        Assert.Contains("integrity", Assert.Throws<InvalidDataException>(() => ApplianceProvisioner.Verify(basePath, "amd64", "main")).Message);
    }

    [Fact]
    public async Task CreatesTheServerOnAnOverlayWithItsSeed()
    {
        var basePath = await Cache(new Fakes()).EnsureAsync("main");
        var vm = new VMManager(new VMInventoryStore(new VMBundleLayout(Path.Combine(_root, "VMs"))), null, "tests");
        var config = Config();
        string[]? ran = null;
        var vector = JsonDocument.Parse(EmbeddedVectors()).RootElement.GetProperty("vectors")[0];
        var recipeJson = Encoding.UTF8.GetBytes(vector.GetProperty("recipeJson").GetString()!);
        await ApplianceHosting.CreateServerAsync(vm, config, basePath, new Recipe { InstallerGitRef = "main" },
            recipeJson, new NativePreseedEngine(), (args, _) => { ran = args; return Task.CompletedTask; }, default);

        var disk = vm.Store.Layout.DiskImagePath(config.Name);
        Assert.Equal(new[]
        {
            "create", "-f", "qcow2", "-F", "qcow2", "-b", Path.GetFullPath(basePath), disk,
            (64UL * 1024 * 1024 * 1024).ToString(),
        }, ran);
        var seed = File.ReadAllBytes(vm.Store.Layout.ApplianceSeedPath(config.Name));
        Assert.Equal(ApplianceSeed.SizeBytes, seed.Length);
        var header = Encoding.ASCII.GetString(seed, 0, ApplianceSeed.HeaderBytes);
        Assert.StartsWith(ApplianceSeed.Magic, header);
        var length = Convert.ToInt32(header.Substring(8, 8), 16);
        using var payload = JsonDocument.Parse(seed.AsMemory(ApplianceSeed.HeaderBytes, length));
        var blob = JsonDocument.Parse(Convert.FromBase64String(payload.RootElement.GetProperty("recipeBase64").GetString()!));
        Assert.True(blob.RootElement.TryGetProperty("serverDomain", out _), "the seed carries the install blob");
        var bootstrap = Encoding.UTF8.GetString(Convert.FromBase64String(payload.RootElement.GetProperty("bootstrapBase64").GetString()!));
        Assert.StartsWith("#!", bootstrap);
        Assert.Single(vm.Servers);
    }

    [Fact]
    public async Task AFailedOverlayLeavesNoServerBehind()
    {
        var basePath = await Cache(new Fakes()).EnsureAsync("main");
        var vm = new VMManager(new VMInventoryStore(new VMBundleLayout(Path.Combine(_root, "VMs"))), null, "tests");
        var vector = JsonDocument.Parse(EmbeddedVectors()).RootElement.GetProperty("vectors")[0];
        var recipeJson = Encoding.UTF8.GetBytes(vector.GetProperty("recipeJson").GetString()!);
        await Assert.ThrowsAsync<IOException>(() => ApplianceHosting.CreateServerAsync(
            vm, Config(), basePath, new Recipe { InstallerGitRef = "main" }, recipeJson, new NativePreseedEngine(),
            (_, _) => throw new IOException("qemu-img create failed"), default));
        Assert.Empty(vm.Servers);
        Assert.False(Directory.Exists(vm.Store.Layout.BundleDir(Config().Name)));

        await Assert.ThrowsAsync<InvalidDataException>(() => ApplianceHosting.CreateServerAsync(
            vm, Config(disk: 1024), basePath, new Recipe { InstallerGitRef = "main" }, recipeJson, new NativePreseedEngine(),
            (_, _) => Task.CompletedTask, default));
        Assert.Empty(vm.Servers);
    }

    [Fact]
    public void ReadsTheBackingFileAServerDiskNames()
    {
        var backing = Path.GetFullPath(Path.Combine(_root, "Appliances", "appliance-amd64", "abc", "base.qcow2"));
        var name = Encoding.UTF8.GetBytes(backing);
        var disk = Path.Combine(_root, "disk.qcow2");
        var image = new byte[512 + name.Length];
        new byte[] { 0x51, 0x46, 0x49, 0xfb, 0, 0, 0, 3 }.CopyTo(image, 0);
        System.Buffers.Binary.BinaryPrimitives.WriteInt64BigEndian(image.AsSpan(8), 512);
        System.Buffers.Binary.BinaryPrimitives.WriteInt32BigEndian(image.AsSpan(16), name.Length);
        name.CopyTo(image, 512);
        File.WriteAllBytes(disk, image);
        var raw = Path.Combine(_root, "raw.img");
        File.WriteAllBytes(raw, new byte[64]);
        Assert.Equal(backing, ApplianceProvisioner.Qcow2BackingFile(disk));
        Assert.Null(ApplianceProvisioner.Qcow2BackingFile(raw));
        Assert.Null(ApplianceProvisioner.Qcow2BackingFile(Path.Combine(_root, "missing")));
        Assert.Equal(new[] { backing }, ApplianceProvisioner.BackingFilesInUse(new[] { disk, raw }).ToArray());
        Assert.True(ApplianceProvisioner.IsQcow2(disk));
        Assert.False(ApplianceProvisioner.IsQcow2(raw));
    }

    private static string EmbeddedVectors()
    {
        using var s = typeof(ApplianceCacheTests).Assembly.GetManifestResourceStream("Flagship.Builder.Tests.Resources.preseed-vectors.json")!;
        using var r = new StreamReader(s);
        return r.ReadToEnd();
    }
}
