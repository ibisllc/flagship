using System;
using System.IO;
using System.Linq;
using Xunit;
using Flagship.Burner.VM;

namespace Flagship.Burner.Tests;

/// <summary>Direct port of apps/burner-mac VMInventoryStoreTests.swift
/// (Windows-native layout: disk.qcow2 + efi-vars.fd).</summary>
public sealed class VMInventoryStoreTests : IDisposable
{
    private readonly string _root;
    private readonly VMInventoryStore _store;

    public VMInventoryStoreTests()
    {
        _root = Path.Combine(Path.GetTempPath(), $"vm-store-tests-{Guid.NewGuid()}");
        Directory.CreateDirectory(_root);
        _store = new VMInventoryStore(new VMBundleLayout(_root));
    }

    public void Dispose()
    {
        try { Directory.Delete(_root, recursive: true); } catch { }
    }

    private static VMRecord Record(string name) => new()
    {
        Config = new VMConfig
        {
            Name = name,
            ServerDomain = name,
            Username = "harry",
            ServerName = name.Split('.').FirstOrDefault() ?? "srv",
            CpuCount = 4,
            MemoryBytes = 6 * VMResourcePlan.GiB,
            MainDiskSizeBytes = VMResourcePlan.DefaultMainDiskSizeBytes,
            NetworkMode = VMNetworkMode.Nat,
            SerialConsoleEnabled = false,
            BootUnlockMode = "auto",
            DiskEncrypted = true,
        },
        State = VMState.Created,
        CreatedAt = DateTimeOffset.FromUnixTimeSeconds(1_750_000_000),
        Tier = ServerTier.HostedVM,
    };

    // ---- Layout ----

    [Fact]
    public void BundleLayoutPaths()
    {
        var layout = new VMBundleLayout(_root);
        Assert.Equal(Path.Combine(_root, "home.harry.flagship.services"),
                     layout.BundleDir("home.harry.flagship.services"));
        Assert.Equal("config.json", Path.GetFileName(layout.ConfigPath("a.b")));
        Assert.Equal("disk.qcow2", Path.GetFileName(layout.DiskImagePath("a.b")));
        Assert.Equal("installer.iso", Path.GetFileName(layout.InstallerIsoPath("a.b")));
        Assert.Equal("efi-vars.fd", Path.GetFileName(layout.EfiVariableStorePath("a.b")));
        Assert.Equal("console.log", Path.GetFileName(layout.ConsoleLogPath("a.b")));
    }

    // ---- CRUD ----

    [Fact]
    public void CreateLoadRoundTrip()
    {
        var rec = Record("home.harry.flagship.services");
        _store.Create(rec);
        var back = _store.Load("home.harry.flagship.services");
        Assert.Equal(rec, back);
        Assert.True(File.Exists(_store.Layout.ConfigPath(rec.Config.Name)));
    }

    [Fact]
    public void CreateRefusesToClobber()
    {
        var rec = Record("home.harry.flagship.services");
        _store.Create(rec);
        var ex = Assert.Throws<VMStoreException>(() => _store.Create(rec));
        Assert.Equal(VMStoreErrorKind.AlreadyExists, ex.Kind);
        Assert.Equal("home.harry.flagship.services", ex.Name);
    }

    [Fact]
    public void SavePersistsAStateChange()
    {
        var rec = Record("home.harry.flagship.services");
        _store.Create(rec);
        _store.Save(rec with { State = VMState.AwaitingPhoneUnlock });
        Assert.Equal(VMState.AwaitingPhoneUnlock, _store.Load(rec.Config.Name).State);
    }

    [Fact]
    public void SaveWithoutCreateFails()
    {
        var ex = Assert.Throws<VMStoreException>(() => _store.Save(Record("ghost.x.flagship.services")));
        Assert.Equal(VMStoreErrorKind.NotFound, ex.Kind);
    }

    [Fact]
    public void FailedStateRoundTripsWithItsReason()
    {
        var rec = Record("home.harry.flagship.services");
        _store.Create(rec);
        var failed = VMState.Failed(VMFailurePhase.Install, "stopped after 12s");
        _store.Save(rec with { State = failed });
        Assert.Equal(failed, _store.Load(rec.Config.Name).State);
    }

    [Fact]
    public void DeleteRemovesTheWholeBundle()
    {
        var rec = Record("home.harry.flagship.services");
        _store.Create(rec);
        // Simulate a disk image sitting in the bundle.
        File.WriteAllBytes(_store.Layout.DiskImagePath(rec.Config.Name), new byte[] { 0 });
        _store.Delete(rec.Config.Name);
        Assert.False(Directory.Exists(_store.Layout.BundleDir(rec.Config.Name)));
        Assert.Throws<VMStoreException>(() => _store.Load(rec.Config.Name));
    }

    [Fact]
    public void DeleteMissingFails()
    {
        var ex = Assert.Throws<VMStoreException>(() => _store.Delete("nope.flagship.services"));
        Assert.Equal(VMStoreErrorKind.NotFound, ex.Kind);
    }

    // ---- Listing (multi-server per spec) ----

    [Fact]
    public void ListReturnsAllRecordsSortedByName()
    {
        _store.Create(Record("b.bob.flagship.services"));
        _store.Create(Record("a.alice.flagship.services"));
        var names = _store.List().Select(r => r.Config.Name).ToArray();
        // Different owners on one machine is a supported posture.
        Assert.Equal(new[] { "a.alice.flagship.services", "b.bob.flagship.services" }, names);
    }

    [Fact]
    public void ListSkipsCorruptEntriesWithoutFailingTheRest()
    {
        _store.Create(Record("good.harry.flagship.services"));
        var badDir = Path.Combine(_root, "bad.harry.flagship.services");
        Directory.CreateDirectory(badDir);
        File.WriteAllText(Path.Combine(badDir, "config.json"), "not json");
        var names = _store.List().Select(r => r.Config.Name).ToArray();
        Assert.Equal(new[] { "good.harry.flagship.services" }, names);
    }

    [Fact]
    public void ListOnEmptyOrMissingRootIsEmpty()
    {
        Assert.Empty(_store.List());
        var missing = new VMInventoryStore(new VMBundleLayout(Path.Combine(_root, "does-not-exist")));
        Assert.Empty(missing.List());
    }

    // ---- Name validation ----

    [Fact]
    public void HostileNamesAreRejected()
    {
        foreach (var bad in new[] { "", ".", "..", "../escape", "..\\escape", "a/b", "a\\b", ".hidden", "UPPER.case", "spa ce", "trailing." })
        {
            var rec = Record("ok.flagship.services");
            rec = rec with { Config = rec.Config with { Name = bad, ServerDomain = bad } };
            var ex = Assert.Throws<VMStoreException>(() => _store.Create(rec));
            Assert.Equal(VMStoreErrorKind.InvalidName, ex.Kind);
        }
    }
}
