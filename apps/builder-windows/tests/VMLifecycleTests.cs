using System;
using System.Collections.Generic;
using Xunit;
using Flagship.Builder.VM;

namespace Flagship.Builder.Tests;

/// <summary>
/// Direct port of apps/builder-mac VMLifecycleTests.swift: every transition of
/// the pure VM state machine, the install→first-boot ISO-detach seam, the
/// sealed "waiting for you to unlock" state, the injected clock, plus the
/// Windows-side tests for the duration-gated install verdict. The full
/// transition table is ALSO pinned by VMCoreVectorTests (shared vectors);
/// these keep the intent readable test-by-test.
/// </summary>
public class VMLifecycleTests
{
    private static VMLifecycle Sealed(VMState? state = null)
        => new(sealedAtBoot: true, state, () => DateTimeOffset.UnixEpoch);

    private static VMLifecycle Unsealed(VMState? state = null)
        => new(sealedAtBoot: false, state, () => DateTimeOffset.UnixEpoch);

    // ---- Install phase ----

    [Fact]
    public void StartInstallAttachesISOAndStarts()
    {
        var lc = Sealed();
        var effects = lc.Handle(VMEvent.StartInstall);
        Assert.Equal(VMState.Installing, lc.State);
        Assert.Equal(new[] { VMEffect.AttachInstallerISO, VMEffect.StartVirtualMachine }, effects);
    }

    [Fact]
    public void InstallSucceededDetachesTheISO()
    {
        // The seam the spec calls out: after the unattended install the ISO
        // comes OFF, so every later boot is from the guest's own disk.
        var lc = Sealed(VMState.Installing);
        var effects = lc.Handle(VMEvent.InstallSucceeded);
        Assert.Equal(VMState.Installed, lc.State);
        Assert.Equal(new[] { VMEffect.DetachInstallerISO }, effects);
    }

    [Fact]
    public void InstallFailureStopsAndDetaches()
    {
        var lc = Sealed(VMState.Installing);
        var effects = lc.Handle(VMEvent.InstallFailed("guest error"));
        Assert.Equal(VMState.Failed(VMFailurePhase.Install, "guest error"), lc.State);
        Assert.Equal(new[] { VMEffect.StopVirtualMachine, VMEffect.DetachInstallerISO }, effects);
    }

    [Fact]
    public void FailedInstallIsRetryable()
    {
        var lc = Sealed(VMState.Failed(VMFailurePhase.Install, "x"));
        var effects = lc.Handle(VMEvent.StartInstall);
        Assert.Equal(VMState.Installing, lc.State);
        Assert.Equal(new[] { VMEffect.AttachInstallerISO, VMEffect.StartVirtualMachine }, effects);
    }

    // ---- Boot: the sealed state ----

    [Fact]
    public void EncryptedGuestBootsIntoAwaitingPhoneUnlock()
    {
        var lc = Sealed(VMState.Installed);
        var effects = lc.Handle(VMEvent.PowerOn);
        Assert.Equal(VMState.AwaitingPhoneUnlock, lc.State);
        Assert.Equal(new[] { VMEffect.StartVirtualMachine }, effects);
    }

    [Fact]
    public void UnencryptedGuestBootsStraightToRunning()
    {
        var lc = Unsealed(VMState.Installed);
        var effects = lc.Handle(VMEvent.PowerOn);
        Assert.Equal(VMState.Running, lc.State);
        Assert.Equal(new[] { VMEffect.StartVirtualMachine }, effects);
    }

    [Fact]
    public void PhoneUnlockCompletesTheBoot()
    {
        var lc = Sealed(VMState.AwaitingPhoneUnlock);
        var effects = lc.Handle(VMEvent.GuestUnlocked);
        Assert.Equal(VMState.Running, lc.State);
        Assert.Empty(effects);
    }

    [Fact]
    public void SealedGuestCanBePoweredOffWhileWaiting()
    {
        // The VM boots with the host but stays sealed — the owner may still
        // shut it down without ever unlocking.
        var lc = Sealed(VMState.AwaitingPhoneUnlock);
        var effects = lc.Handle(VMEvent.PowerOff);
        Assert.Equal(VMState.Stopped, lc.State);
        Assert.Equal(new[] { VMEffect.StopVirtualMachine }, effects);
    }

    // ---- Run / stop / restart ----

    [Fact]
    public void RunningPowersOffToStopped()
    {
        var lc = Sealed(VMState.Running);
        var effects = lc.Handle(VMEvent.PowerOff);
        Assert.Equal(VMState.Stopped, lc.State);
        Assert.Equal(new[] { VMEffect.StopVirtualMachine }, effects);
    }

    [Fact]
    public void StoppedRebootsThroughTheSealedState()
    {
        var lc = Sealed(VMState.Stopped);
        var effects = lc.Handle(VMEvent.PowerOn);
        Assert.Equal(VMState.AwaitingPhoneUnlock, lc.State);
        Assert.Equal(new[] { VMEffect.StartVirtualMachine }, effects);
    }

    [Fact]
    public void RuntimeFailureFromRunning()
    {
        var lc = Sealed(VMState.Running);
        lc.Handle(VMEvent.RuntimeFailed("crashed"));
        Assert.Equal(VMState.Failed(VMFailurePhase.Run, "crashed"), lc.State);
    }

    [Fact]
    public void RuntimeFailureWhileAwaitingUnlock()
    {
        var lc = Sealed(VMState.AwaitingPhoneUnlock);
        lc.Handle(VMEvent.RuntimeFailed("died"));
        Assert.Equal(VMState.Failed(VMFailurePhase.Run, "died"), lc.State);
    }

    [Fact]
    public void RunFailureIsRestartable()
    {
        var lc = Sealed(VMState.Failed(VMFailurePhase.Run, "x"));
        var effects = lc.Handle(VMEvent.PowerOn);
        Assert.Equal(VMState.AwaitingPhoneUnlock, lc.State);
        Assert.Equal(new[] { VMEffect.StartVirtualMachine }, effects);
    }

    // ---- Invalid transitions are loud, not swallowed ----

    [Fact]
    public void InvalidTransitionsThrow()
    {
        var cases = new (VMState state, VMEvent ev)[]
        {
            (VMState.Created, VMEvent.PowerOn),               // nothing installed yet
            (VMState.Created, VMEvent.InstallSucceeded),
            (VMState.Installing, VMEvent.PowerOn),            // mid-install
            (VMState.Installing, VMEvent.GuestUnlocked),
            (VMState.Installed, VMEvent.StartInstall),        // already installed
            (VMState.Installed, VMEvent.GuestUnlocked),       // not booted
            (VMState.Running, VMEvent.PowerOn),               // already up
            (VMState.Running, VMEvent.GuestUnlocked),
            (VMState.Running, VMEvent.StartInstall),
            (VMState.Stopped, VMEvent.GuestUnlocked),
            (VMState.AwaitingPhoneUnlock, VMEvent.PowerOn),
            (VMState.Failed(VMFailurePhase.Install, "x"), VMEvent.PowerOn), // must retry install
            (VMState.Failed(VMFailurePhase.Run, "x"), VMEvent.StartInstall),
        };
        foreach (var (state, ev) in cases)
        {
            var lc = Sealed(state);
            var thrown = Assert.Throws<VMLifecycleException>(() => lc.Handle(ev));
            Assert.Equal(state, thrown.From);
            Assert.Equal(ev, thrown.On);
            Assert.Equal(state, lc.State); // state must not change on a rejected event
        }
    }

    // ---- Injectable clock ----

    [Fact]
    public void StateTimestampsComeFromTheInjectedClock()
    {
        var times = new Queue<DateTimeOffset>(new[]
        {
            DateTimeOffset.FromUnixTimeSeconds(100),
            DateTimeOffset.FromUnixTimeSeconds(200),
            DateTimeOffset.FromUnixTimeSeconds(300),
        });
        var lc = new VMLifecycle(sealedAtBoot: true, clock: () => times.Dequeue());
        Assert.Equal(DateTimeOffset.FromUnixTimeSeconds(100), lc.StateChangedAt);
        lc.Handle(VMEvent.StartInstall);
        Assert.Equal(DateTimeOffset.FromUnixTimeSeconds(200), lc.StateChangedAt);
        lc.Handle(VMEvent.InstallSucceeded);
        Assert.Equal(DateTimeOffset.FromUnixTimeSeconds(300), lc.StateChangedAt);
    }

    // ---- The duration-gated install verdict (the Mac Phase-0 hard-won finding) ----

    [Fact]
    public void CleanStopAfterPlausibleDurationIsSuccess()
    {
        Assert.Equal(VMEvent.InstallSucceeded, VMLifecycle.VerdictForCleanInstallStop(TimeSpan.FromMinutes(10)));
        // Edge: exactly the minimum counts as success.
        Assert.Equal(VMEvent.InstallSucceeded, VMLifecycle.VerdictForCleanInstallStop(VMLifecycle.MinPlausibleInstallDuration));
    }

    [Fact]
    public void TooFastCleanStopIsAnActionableFailure()
    {
        var verdict = VMLifecycle.VerdictForCleanInstallStop(TimeSpan.FromSeconds(12));
        Assert.Equal(VMEventKind.InstallFailed, verdict.Kind);
        Assert.Contains("12s", verdict.Reason);
        Assert.Contains("Retry", verdict.Reason);
    }

    [Fact]
    public void PrebuiltSpecializationHasShortNonzeroFloor()
    {
        Assert.Equal(VMEvent.InstallSucceeded, VMLifecycle.VerdictForCleanProvisioningStop(
            VMLifecycle.MinPlausibleSpecializationDuration, VMProvisioningMode.PrebuiltAppliance));
        Assert.Equal(VMEventKind.InstallFailed, VMLifecycle.VerdictForCleanProvisioningStop(
            TimeSpan.FromMilliseconds(300), VMProvisioningMode.PrebuiltAppliance).Kind);
        Assert.Equal(VMEventKind.InstallFailed, VMLifecycle.VerdictForCleanProvisioningStop(
            VMLifecycle.MinPlausibleSpecializationDuration, VMProvisioningMode.InstallerISO).Kind);
    }

    [Fact]
    public void InstanceVerdictDerivesElapsedFromTheStateTimestamp()
    {
        var t0 = DateTimeOffset.FromUnixTimeSeconds(1000);
        var now = t0;
        var lc = new VMLifecycle(sealedAtBoot: true, clock: () => now);
        lc.Handle(VMEvent.StartInstall); // stateChangedAt = t0

        Assert.Equal(VMEventKind.InstallFailed, lc.VerdictForCleanInstallStop(t0.AddSeconds(30)).Kind);
        Assert.Equal(VMEventKind.InstallSucceeded, lc.VerdictForCleanInstallStop(t0.AddSeconds(120)).Kind);
    }

    [Fact]
    public void InstanceVerdictOutsideInstallingIsAProgrammingError()
    {
        var lc = Sealed(VMState.Running);
        Assert.Throws<InvalidOperationException>(
            () => lc.VerdictForCleanInstallStop(DateTimeOffset.UnixEpoch));
    }
}
