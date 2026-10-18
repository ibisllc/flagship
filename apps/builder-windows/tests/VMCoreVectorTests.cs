using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using Xunit;
using Flagship.Builder.VM;

namespace Flagship.Builder.Tests;

/// <summary>
/// Drives the pure VM core against the SHARED golden vectors
/// (apps/desktop-shared/golden/vm-core-vectors.json) — the cross-language
/// contract that keeps this C# core and the Mac Swift core identical, the way
/// engine/golden/preseed-vectors.json pins the preseed engine. If a vector
/// fails here, the fix is byte-parity with the vectors, never editing the
/// vectors to match the code (unless BOTH platforms change together).
/// </summary>
public class VMCoreVectorTests
{
    private static readonly JsonElement Vectors = LoadVectors();

    private static JsonElement LoadVectors()
    {
        var path = Path.Combine(AppContext.BaseDirectory, "Resources", "vm-core-vectors.json");
        var doc = JsonDocument.Parse(File.ReadAllBytes(path));
        return doc.RootElement;
    }

    // ---- token codecs ----

    private static VMState ParseState(string token) => token switch
    {
        "created" => VMState.Created,
        "installing" => VMState.Installing,
        "installed" => VMState.Installed,
        "awaitingPhoneUnlock" => VMState.AwaitingPhoneUnlock,
        "running" => VMState.Running,
        "stopped" => VMState.Stopped,
        "failed:install" => VMState.Failed(VMFailurePhase.Install, "x"),
        "failed:run" => VMState.Failed(VMFailurePhase.Run, "x"),
        _ => throw new ArgumentException($"unknown state token '{token}'"),
    };

    private static VMEvent ParseEvent(string token, string? reason) => token switch
    {
        "startInstall" => VMEvent.StartInstall,
        "installSucceeded" => VMEvent.InstallSucceeded,
        "installFailed" => VMEvent.InstallFailed(reason ?? ""),
        "powerOn" => VMEvent.PowerOn,
        "guestUnlocked" => VMEvent.GuestUnlocked,
        "powerOff" => VMEvent.PowerOff,
        "runtimeFailed" => VMEvent.RuntimeFailed(reason ?? ""),
        _ => throw new ArgumentException($"unknown event token '{token}'"),
    };

    private static VMEffect ParseEffect(string token) => token switch
    {
        "attachInstallerISO" => VMEffect.AttachInstallerISO,
        "detachInstallerISO" => VMEffect.DetachInstallerISO,
        "startVirtualMachine" => VMEffect.StartVirtualMachine,
        "stopVirtualMachine" => VMEffect.StopVirtualMachine,
        _ => throw new ArgumentException($"unknown effect token '{token}'"),
    };

    /// <summary>Compare ignoring the placeholder failure reason baked into
    /// start-state tokens; a transition INTO failed pins the real reason.</summary>
    private static void AssertStateMatches(string expectedToken, string? expectedReason, VMState actual)
    {
        var expected = ParseState(expectedToken);
        Assert.Equal(expected.Kind, actual.Kind);
        if (expected.Kind == VMStateKind.Failed)
        {
            Assert.Equal(expected.Failure!.Phase, actual.Failure!.Phase);
            if (expectedReason != null) Assert.Equal(expectedReason, actual.Failure!.Reason);
        }
    }

    // ---- lifecycle ----

    [Fact]
    public void AllVectorTransitionsHold()
    {
        int count = 0;
        foreach (var t in Vectors.GetProperty("lifecycle").GetProperty("transitions").EnumerateArray())
        {
            var start = t.GetProperty("start").GetString()!;
            var ev = t.GetProperty("event").GetString()!;
            var reason = t.TryGetProperty("reason", out var r) ? r.GetString() : null;
            var next = t.GetProperty("next").GetString()!;
            var effects = t.GetProperty("effects").EnumerateArray()
                           .Select(e => ParseEffect(e.GetString()!)).ToArray();
            // No "sealed" key ⇒ the transition must hold for BOTH values.
            bool[] sealedValues = t.TryGetProperty("sealed", out var s)
                ? new[] { s.GetBoolean() } : new[] { true, false };

            foreach (var sealedAtBoot in sealedValues)
            {
                var lc = new VMLifecycle(sealedAtBoot, ParseState(start),
                                         () => DateTimeOffset.UnixEpoch);
                var got = lc.Handle(ParseEvent(ev, reason));
                AssertStateMatches(next, reason, lc.State);
                Assert.Equal(effects, got);
                count++;
            }
        }
        Assert.True(count >= 15, "vector file must actually contain transitions");
    }

    [Fact]
    public void AllVectorInvalidTransitionsThrowAndLeaveStateUntouched()
    {
        int count = 0;
        foreach (var t in Vectors.GetProperty("lifecycle").GetProperty("invalid").EnumerateArray())
        {
            var start = t.GetProperty("start").GetString()!;
            var ev = t.GetProperty("event").GetString()!;
            foreach (var sealedAtBoot in new[] { true, false })
            {
                var startState = ParseState(start);
                var lc = new VMLifecycle(sealedAtBoot, startState, () => DateTimeOffset.UnixEpoch);
                Assert.Throws<VMLifecycleException>(() => lc.Handle(ParseEvent(ev, "r")));
                Assert.Equal(startState, lc.State); // state must not change on a rejected event
                count++;
            }
        }
        Assert.True(count >= 20, "vector file must actually contain invalid cases");
    }

    // ---- duration-gated install verdict ----

    [Fact]
    public void InstallVerdictMatchesVectors()
    {
        var section = Vectors.GetProperty("installVerdict");
        Assert.Equal(section.GetProperty("minPlausibleInstallSeconds").GetDouble(),
                     VMLifecycle.MinPlausibleInstallDuration.TotalSeconds);
        foreach (var c in section.GetProperty("cases").EnumerateArray())
        {
            var elapsed = TimeSpan.FromSeconds(c.GetProperty("elapsedSeconds").GetDouble());
            var expected = c.GetProperty("verdict").GetString()!;
            var verdict = VMLifecycle.VerdictForCleanInstallStop(elapsed);
            Assert.Equal(expected == "installSucceeded" ? VMEventKind.InstallSucceeded : VMEventKind.InstallFailed,
                         verdict.Kind);
            if (verdict.Kind == VMEventKind.InstallFailed)
                Assert.False(string.IsNullOrWhiteSpace(verdict.Reason), "failure verdicts carry an actionable reason");
        }
    }

    // ---- resource plan ----

    [Fact]
    public void ResourcePlanMatchesVectors()
    {
        foreach (var c in Vectors.GetProperty("resourcePlan").GetProperty("cases").EnumerateArray())
        {
            var host = new HostResources(
                c.GetProperty("hostCpus").GetInt32(),
                c.GetProperty("hostRamGiB").GetUInt64() * VMResourcePlan.GiB);
            var label = $"cpus={host.CpuCount} ramGiB={c.GetProperty("hostRamGiB").GetUInt64()}";
            Assert.True(c.GetProperty("vmCpus").GetInt32() == VMResourcePlan.VmCpuCount(host), $"vmCpus mismatch for {label}");
            Assert.True(c.GetProperty("vmMemGiB").GetUInt64() * VMResourcePlan.GiB == VMResourcePlan.VmMemoryBytes(host), $"vmMemGiB mismatch for {label}");
            Assert.True(c.GetProperty("maxVMs").GetInt32() == VMResourcePlan.MaxVMCount(host), $"maxVMs mismatch for {label}");
        }
    }

    // ---- bundle-name validation ----

    [Fact]
    public void NameValidationMatchesVectors()
    {
        var section = Vectors.GetProperty("nameValidation");
        foreach (var n in section.GetProperty("valid").EnumerateArray())
            Assert.True(VMInventoryStore.IsValidName(n.GetString()!), $"'{n.GetString()}' should be valid");
        foreach (var n in section.GetProperty("invalid").EnumerateArray())
            Assert.False(VMInventoryStore.IsValidName(n.GetString()!), $"'{n.GetString()}' should be invalid");
    }

    // ---- server health ----

    [Fact]
    public void ServerHealthMatchesVectors()
    {
        var section = Vectors.GetProperty("serverHealth");
        var domain = section.GetProperty("serverDomain").GetString()!;
        var now = DateTimeOffset.FromUnixTimeMilliseconds(section.GetProperty("nowMs").GetInt64());
        foreach (var c in section.GetProperty("urlCases").EnumerateArray())
        {
            var serial = c.GetProperty("serial").GetString()!;
            var url = c.GetProperty("url");
            Assert.Equal(url.ValueKind == JsonValueKind.Null ? null : url.GetString(), VMServerHealth.OrderHealthUrl(serial));
        }
        int count = 0;
        foreach (var c in section.GetProperty("cases").EnumerateArray())
        {
            var name = c.GetProperty("name").GetString();
            var health = VMServerHealth.FromOrderHealth(c.GetProperty("response").GetString()!, domain);
            var expected = c.GetProperty("verdict");
            if (expected.ValueKind == JsonValueKind.Null)
            {
                Assert.True(health is null, name);
                continue;
            }
            Assert.True(health is not null, name);
            var v = health!.Verdict(now);
            Assert.True(expected.GetProperty("ok").GetBoolean() == v.Ok, name);
            Assert.Equal(expected.GetProperty("lines").EnumerateArray().Select(l => l.GetString()!).ToArray(), v.Lines.ToArray());
            count++;
        }
        Assert.True(count >= 5, "vector file must actually contain health cases");
    }

    [Fact]
    public void BootEvidenceMatchesVectors()
    {
        var section = Vectors.GetProperty("bootEvidence");
        int count = 0;
        foreach (var c in section.GetProperty("cases").EnumerateArray())
        {
            var name = c.GetProperty("name").GetString();
            var report = new VMServerHealth(
                UptimeS: c.GetProperty("uptimeS").GetInt64(), MemTotalMB: 3900, MemAvailMB: 800, OomKills: 0,
                DaemonState: c.GetProperty("daemonState").GetString()!, DaemonRestarts: 0, DaemonLastExit: 0,
                Tunnel: c.GetProperty("tunnel").GetBoolean(), DiskUsedPct: 10,
                ReceivedAtMs: c.GetProperty("receivedAtMs").GetInt64());
            var got = report.ProvesBoxIsUp(
                DateTimeOffset.FromUnixTimeMilliseconds(c.GetProperty("poweredOnAtMs").GetInt64()),
                DateTimeOffset.FromUnixTimeMilliseconds(c.GetProperty("nowMs").GetInt64()));
            Assert.True(c.GetProperty("provesBoxIsUp").GetBoolean() == got, name);
            count++;
        }
        Assert.True(count >= 6, "vector file must actually contain boot-evidence cases");
    }

    [Fact]
    public void AwaitingUnlockCopyMatchesVectors()
    {
        var section = Vectors.GetProperty("awaitingUnlockCopy");
        Assert.Equal(section.GetProperty("stalled").GetString(), HostedServer.AwaitingUnlockStalled);
        Assert.Equal(section.GetProperty("unlocksOnItsOwn").GetString(), HostedServer.AwaitingUnlockOnItsOwn);
        Assert.Equal(section.GetProperty("firstBoot").GetString(), HostedServer.AwaitingUnlockFirstBoot);
        Assert.Equal(section.GetProperty("approveEveryBoot").GetString(), HostedServer.AwaitingUnlockApproveEveryBoot);
    }

    // ---- disk durability ----

    [Fact]
    public void QemuMainDriveMatchesVectors()
    {
        var options = QemuCommandLine.MainDriveOptions.Split(',')
            .Select(kv => kv.Split('=', 2))
            .ToDictionary(kv => kv[0], kv => kv[1]);
        var expected = Vectors.GetProperty("diskDurability").GetProperty("qemuMainDrive");
        int count = 0;
        foreach (var kv in expected.EnumerateObject())
        {
            Assert.True(options.TryGetValue(kv.Name, out var got) && got == kv.Value.GetString(),
                        $"main drive {kv.Name}");
            count++;
        }
        Assert.True(count > 0, "vector file must pin the main drive options");
    }
}
