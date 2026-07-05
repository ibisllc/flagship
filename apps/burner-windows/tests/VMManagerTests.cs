using System;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using Xunit;
using Flagship.Burner.VM;

namespace Flagship.Burner.Tests;

/// <summary>
/// The orchestrator's pure-ish behavior: launch normalization (mirrors the
/// Mac's loadAndNormalize), capacity math passthrough, and creation/deletion
/// bookkeeping. No QEMU is ever spawned here (no VM is started; the toolchain
/// is a stub path).
/// </summary>
public sealed class VMManagerTests : IDisposable
{
    private readonly string _root;
    private readonly VMInventoryStore _store;

    public VMManagerTests()
    {
        _root = Path.Combine(Path.GetTempPath(), $"vm-manager-tests-{Guid.NewGuid()}");
        Directory.CreateDirectory(_root);
        _store = new VMInventoryStore(new VMBundleLayout(_root));
    }

    public void Dispose()
    {
        try { Directory.Delete(_root, recursive: true); } catch { }
    }

    private static VMConfig Config(string name) => new()
    {
        Name = name,
        ServerDomain = name,
        Username = "harry",
        ServerName = name.Split('.')[0],
        CpuCount = 2,
        MemoryBytes = 4 * VMResourcePlan.GiB,
        MainDiskSizeBytes = VMResourcePlan.DefaultMainDiskSizeBytes,
        NetworkMode = VMNetworkMode.Nat,
        SerialConsoleEnabled = false,
        BootUnlockMode = "auto",
        DiskEncrypted = true,
    };

    private void Seed(string name, VMState state)
    {
        _store.Create(new VMRecord
        {
            Config = Config(name),
            State = state,
            CreatedAt = DateTimeOffset.FromUnixTimeSeconds(1_750_000_000),
        });
    }

    private VMManager Manager() => new(_store, toolchain: null, toolchainError: "no qemu in tests");

    // ---- Launch normalization ----

    [Fact]
    public void StaleInstallingBecomesRetryableInstallFailure()
    {
        Seed("a.h.flagship.services", VMState.Installing);
        var m = Manager();
        var s = m.Servers.Single();
        Assert.Equal(VMStateKind.Failed, s.Record.State.Kind);
        Assert.Equal(VMFailurePhase.Install, s.Record.State.Failure!.Phase);
        // And it was PERSISTED, not just displayed.
        Assert.Equal(VMStateKind.Failed, _store.Load("a.h.flagship.services").State.Kind);
    }

    [Fact]
    public void StaleLiveStatesBecomeStopped()
    {
        Seed("a.h.flagship.services", VMState.Running);
        Seed("b.h.flagship.services", VMState.AwaitingPhoneUnlock);
        var m = Manager();
        Assert.All(m.Servers, s => Assert.Equal(VMStateKind.Stopped, s.Record.State.Kind));
    }

    [Fact]
    public void RestStatesLoadUntouched()
    {
        Seed("a.h.flagship.services", VMState.Stopped);
        Seed("b.h.flagship.services", VMState.Installed);
        Seed("c.h.flagship.services", VMState.Created);
        var m = Manager();
        Assert.Equal(new[] { VMStateKind.Stopped, VMStateKind.Installed, VMStateKind.Created },
                     m.Servers.Select(s => s.Record.State.Kind).ToArray());
    }

    // ---- Create / delete bookkeeping ----

    [Fact]
    public void CreateServerPersistsAndSortsIntoTheSidebar()
    {
        var m = Manager();
        m.CreateServer(Config("b.h.flagship.services"));
        m.CreateServer(Config("a.h.flagship.services"));
        Assert.Equal(new[] { "a.h.flagship.services", "b.h.flagship.services" },
                     m.Servers.Select(s => s.Name).ToArray());
        Assert.Equal(VMStateKind.Created, _store.Load("a.h.flagship.services").State.Kind);
        Assert.Equal(ServerTier.HostedVM, _store.Load("a.h.flagship.services").Tier);
    }

    [Fact]
    public async Task DeleteServerRemovesBundleAndRow()
    {
        var m = Manager();
        m.CreateServer(Config("a.h.flagship.services"));
        await m.DeleteServerAsync("a.h.flagship.services");
        Assert.Empty(m.Servers);
        Assert.False(Directory.Exists(_store.Layout.BundleDir("a.h.flagship.services")));
    }

    // ---- Guarded start without a toolchain ----

    [Fact]
    public async Task StartWithoutQemuFailsHonestlyIntoInstallFailed()
    {
        var m = Manager();
        m.CreateServer(Config("a.h.flagship.services"));
        await m.BeginInstallAsync("a.h.flagship.services");
        var s = m.Servers.Single();
        Assert.Equal(VMStateKind.Failed, s.Record.State.Kind);
        Assert.Equal(VMFailurePhase.Install, s.Record.State.Failure!.Phase);
        Assert.Contains("no qemu in tests", s.Record.State.Failure!.Reason);
    }

    // ---- Display mapping ----

    [Fact]
    public void HostedServerDisplayPropsFollowTheRecord()
    {
        Seed("home.harry.flagship.services", VMState.Stopped);
        var m = Manager();
        var s = m.Servers.Single();
        Assert.Equal("home.harry", s.DisplayName);
        Assert.Equal("Appliance (hosted VM)", s.BadgeLabel);
        Assert.True(s.CanStart);
        Assert.False(s.CanStop);
        s.Record = s.Record with { State = VMState.Running };
        Assert.False(s.CanStart);
        Assert.True(s.CanStop);
        Assert.Contains("https://home.harry.flagship.services/", s.StatusSubtitle);
    }
}
