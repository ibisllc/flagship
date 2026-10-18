using System;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using Xunit;
using Flagship.Builder.VM;

namespace Flagship.Builder.Tests;

/// <summary>
/// A second 4 GiB VM started with under 5 GB free put the raw QEMU stderr
/// ("WHPX: failed to map GPA range" under repeated CPUID warnings) in the
/// sidebar (Windows, 2026-10-18). Studio now checks free RAM first and
/// otherwise shows only the last meaningful line. The cases are the shared
/// vm-core-vectors.json "qemuFailure" ones.
/// </summary>
public sealed class QemuFailureTests : IDisposable
{
    private static readonly JsonElement Section = VectorsFile.Root.GetProperty("qemuFailure");
    private readonly string _root = System.IO.Path.Combine(System.IO.Path.GetTempPath(), $"qemu-failure-tests-{Guid.NewGuid()}");

    public QemuFailureTests() => System.IO.Directory.CreateDirectory(_root);

    public void Dispose()
    {
        try { System.IO.Directory.Delete(_root, recursive: true); } catch { }
    }

    [Fact]
    public void MatchesTheSharedVectors()
    {
        foreach (var c in Section.GetProperty("memoryMessageCases").EnumerateArray())
            Assert.Equal(c.GetProperty("message").GetString(),
                         QemuFailure.NotEnoughMemoryMessage(c.GetProperty("needBytes").GetUInt64()));

        foreach (var c in Section.GetProperty("checkFreeCases").EnumerateArray())
        {
            var name = c.GetProperty("name").GetString();
            var need = c.GetProperty("needBytes").GetUInt64();
            var got = QemuFailure.CheckFreeMemory(need, c.GetProperty("availableBytes").GetUInt64(),
                                                  c.GetProperty("headroomBytes").GetUInt64());
            Assert.True(c.GetProperty("tooLittle").GetBoolean() == (got is not null), name);
            if (got is not null) Assert.Equal(QemuFailure.NotEnoughMemoryMessage(need), got);
        }

        var count = 0;
        foreach (var c in Section.GetProperty("describeCases").EnumerateArray())
        {
            Assert.Equal(c.GetProperty("text").GetString(),
                         QemuFailure.DescribeExit(c.GetProperty("exitCode").GetInt32(),
                                                  c.GetProperty("stderr").GetString()!,
                                                  c.GetProperty("memoryBytes").GetUInt64()));
            count++;
        }
        Assert.True(count >= 5, "vector file must actually contain failure cases");
    }

    [Fact]
    public void AnUnknownFreeMemoryNeverBlocksALaunch()
        => Assert.Null(QemuFailure.CheckFreeMemory(4 * VMResourcePlan.GiB, null, QemuFailure.WhpxHeadroomBytes));

    [Fact]
    public async Task AStartWithTooLittleFreeMemoryFailsWithThePlainSentence()
    {
        var store = new VMInventoryStore(new VMBundleLayout(_root));
        var config = new VMConfig
        {
            Name = "a.h.flagship.services", ServerDomain = "a.h.flagship.services", Username = "harry",
            ServerName = "a", CpuCount = 2, MemoryBytes = 4 * VMResourcePlan.GiB,
            MainDiskSizeBytes = VMResourcePlan.DefaultMainDiskSizeBytes, NetworkMode = VMNetworkMode.Nat,
            SerialConsoleEnabled = false, BootUnlockMode = "auto", DiskEncrypted = true,
        };
        store.Create(new VMRecord
        {
            Config = config, State = VMState.Stopped,
            CreatedAt = DateTimeOffset.FromUnixTimeSeconds(1_750_000_000),
        });
        var manager = new VMManager(store, new QemuToolchain("q.exe", "qi.exe", "code.fd", "vars.fd"),
                                    availableMemory: () => 4 * VMResourcePlan.GiB + VMResourcePlan.GiB / 2);

        await manager.PowerOnAsync("a.h.flagship.services");

        var state = manager.Server("a.h.flagship.services")!.Record.State;
        Assert.Equal(VMStateKind.Failed, state.Kind);
        Assert.Equal("Not enough free memory: this server needs 4 GiB. Close other apps and try again.",
                     state.Failure!.Reason);
    }
}

internal static class VectorsFile
{
    public static readonly JsonElement Root = Load();

    private static JsonElement Load()
    {
        var path = System.IO.Path.Combine(AppContext.BaseDirectory, "Resources", "vm-core-vectors.json");
        return JsonDocument.Parse(System.IO.File.ReadAllBytes(path)).RootElement;
    }
}
