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
}
