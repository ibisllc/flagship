using System;
using System.Collections.Generic;

namespace Flagship.Builder.VM;

/// <summary>
/// One hosted VM's lifecycle — pure and event-driven. The host (QEMU adapter /
/// UI) feeds it events and executes the effects it returns; nothing in here
/// touches QEMU, the filesystem, or a real clock.
///
///     created ──startInstall──▶ installing (installer ISO attached)
///     installing ──installSucceeded──▶ installed (ISO DETACHED — from here
///                                       the guest boots from its own disk)
///     installed/stopped ──powerOn──▶ awaitingPhoneUnlock   (encrypted guest:
///                                       sealed in the initramfs until the
///                                       phone-home unlock answers)
///                              └────▶ running              (unencrypted guest)
///     awaitingPhoneUnlock ──guestUnlocked──▶ running
///     running/awaitingPhoneUnlock ──powerOff──▶ stopped
///     + failure states (install / run), each retryable.
///
/// Mirrors apps/builder-mac FlagshipBuilderCore/VM/VMLifecycle.swift; the
/// shared contract is pinned by apps/desktop-shared/golden/vm-core-vectors.json.
/// </summary>
public enum VMFailurePhase { Install, Run }

public sealed record VMFailure(VMFailurePhase Phase, string Reason);

public enum VMStateKind
{
    Created,
    Installing,
    Installed,
    AwaitingPhoneUnlock,
    Running,
    Stopped,
    Failed,
}

public sealed record VMState(VMStateKind Kind, VMFailure? Failure = null)
{
    public static readonly VMState Created = new(VMStateKind.Created);
    public static readonly VMState Installing = new(VMStateKind.Installing);
    public static readonly VMState Installed = new(VMStateKind.Installed);
    public static readonly VMState AwaitingPhoneUnlock = new(VMStateKind.AwaitingPhoneUnlock);
    public static readonly VMState Running = new(VMStateKind.Running);
    public static readonly VMState Stopped = new(VMStateKind.Stopped);
    public static VMState Failed(VMFailure failure) => new(VMStateKind.Failed, failure);
    public static VMState Failed(VMFailurePhase phase, string reason) => new(VMStateKind.Failed, new VMFailure(phase, reason));

    /// <summary>User-facing status label (sidebar / detail).</summary>
    public string Label => Kind switch
    {
        VMStateKind.Created => "Created",
        VMStateKind.Installing => "Installing…",
        VMStateKind.Installed => "Installed",
        VMStateKind.AwaitingPhoneUnlock => "Waiting for you to unlock",
        VMStateKind.Running => "Running",
        VMStateKind.Stopped => "Stopped",
        VMStateKind.Failed => Failure?.Phase == VMFailurePhase.Install ? "Install failed" : "Stopped unexpectedly",
        _ => "Unknown",
    };
}

public enum VMEventKind
{
    StartInstall,
    InstallSucceeded,
    InstallFailed,
    PowerOn,
    GuestUnlocked,
    PowerOff,
    RuntimeFailed,
}

public sealed record VMEvent(VMEventKind Kind, string? Reason = null)
{
    /// <summary>Begin (or retry) the unattended install from the remastered ISO.</summary>
    public static readonly VMEvent StartInstall = new(VMEventKind.StartInstall);
    /// <summary>The installer ran to completion (the guest powered itself off).</summary>
    public static readonly VMEvent InstallSucceeded = new(VMEventKind.InstallSucceeded);
    public static VMEvent InstallFailed(string reason) => new(VMEventKind.InstallFailed, reason);
    /// <summary>Boot the installed guest from its main disk.</summary>
    public static readonly VMEvent PowerOn = new(VMEventKind.PowerOn);
    /// <summary>The sealed guest's phone-home unlock completed (owner approved /
    /// a lease answered) and the guest is up.</summary>
    public static readonly VMEvent GuestUnlocked = new(VMEventKind.GuestUnlocked);
    /// <summary>The guest stopped (user action or a clean guest shutdown).</summary>
    public static readonly VMEvent PowerOff = new(VMEventKind.PowerOff);
    public static VMEvent RuntimeFailed(string reason) => new(VMEventKind.RuntimeFailed, reason);
}

/// <summary>
/// Side effects the caller must perform, in order. The state machine decides;
/// the QEMU layer obeys.
/// </summary>
public enum VMEffect
{
    AttachInstallerISO,
    DetachInstallerISO,
    StartVirtualMachine,
    StopVirtualMachine,
}

public sealed class VMLifecycleException : Exception
{
    public VMState From { get; }
    public VMEvent On { get; }

    public VMLifecycleException(VMState from, VMEvent on)
        : base($"Invalid VM transition: {from.Kind} on {on.Kind}.")
    {
        From = from;
        On = on;
    }
}

public sealed class VMLifecycle
{
    public VMState State { get; private set; }
    /// <summary>When the current state was entered (via the injected clock).</summary>
    public DateTimeOffset StateChangedAt { get; private set; }

    /// <summary>
    /// From VMConfig.AwaitsPhoneUnlockAtBoot: whether powering on an installed
    /// guest lands in the sealed awaiting-phone-unlock state first.
    /// </summary>
    public bool SealedAtBoot { get; }

    private readonly Func<DateTimeOffset> _clock;

    public VMLifecycle(bool sealedAtBoot, VMState? state = null, Func<DateTimeOffset>? clock = null)
    {
        State = state ?? VMState.Created;
        SealedAtBoot = sealedAtBoot;
        _clock = clock ?? (() => DateTimeOffset.UtcNow);
        StateChangedAt = _clock();
    }

    /// <summary>
    /// A hypervisor-level clean guest-stop during the install phase is
    /// AMBIGUOUS: install-success (the preseed powers the guest off), a
    /// completed-install reboot, and a never-really-booted guest all look
    /// identical from outside. The Mac Phase-0 boot proved the only reliable
    /// discriminator is elapsed time — a real unattended Debian install cannot
    /// complete faster than this.
    /// </summary>
    public static readonly TimeSpan MinPlausibleInstallDuration = TimeSpan.FromSeconds(90);
    public static readonly TimeSpan MinPlausibleSpecializationDuration = TimeSpan.FromSeconds(5);

    /// <summary>
    /// The duration-gated verdict for a clean guest-stop observed while
    /// installing: a clean stop after a plausible duration is success (poweroff
    /// OR reboot — both mean the installer finished); a too-fast clean stop is
    /// a failure with an actionable message. Pure — pinned by the shared
    /// golden vectors (edge: exactly the minimum counts as success).
    /// </summary>
    public static VMEvent VerdictForCleanInstallStop(TimeSpan elapsedSinceInstallStart)
    {
        if (elapsedSinceInstallStart >= MinPlausibleInstallDuration) return VMEvent.InstallSucceeded;
        var secs = (int)Math.Round(elapsedSinceInstallStart.TotalSeconds);
        return VMEvent.InstallFailed(
            $"The installer stopped after only {secs}s — too fast to have completed. " +
            "The guest likely failed to boot the installer ISO. Retry the install; " +
            "if it persists, re-download the base image and remaster again.");
    }

    public static VMEvent VerdictForCleanProvisioningStop(
        TimeSpan elapsedSinceInstallStart, VMProvisioningMode mode)
    {
        if (mode == VMProvisioningMode.InstallerISO)
            return VerdictForCleanInstallStop(elapsedSinceInstallStart);
        if (elapsedSinceInstallStart >= MinPlausibleSpecializationDuration)
            return VMEvent.InstallSucceeded;
        var secs = (int)Math.Round(elapsedSinceInstallStart.TotalSeconds);
        return VMEvent.InstallFailed(
            $"The appliance stopped after only {secs}s — too fast to have specialized. " +
            "The image may be the wrong architecture or otherwise not bootable.");
    }

    /// <summary>
    /// Convenience for the live adapter: derive the elapsed install time from
    /// this machine's own state timestamp. Only meaningful while installing.
    /// </summary>
    /// <summary>
    /// A sealed guest awaiting phone-unlock should come online within a few
    /// minutes; past this it has very likely failed to reach the network (e.g. a
    /// first-boot NIC/DHCP failure) and would otherwise spin on "Waiting for you
    /// to unlock" forever with no hint. The UI keeps polling, but past this
    /// threshold it surfaces an advisory. Mirrors macOS
    /// VMLifecycle.comingUpStallThreshold / Linux COMING_UP_STALL_THRESHOLD.
    /// </summary>
    public static readonly TimeSpan ComingUpStallThreshold = TimeSpan.FromMinutes(8);

    /// <summary>
    /// True iff a hosted server has been sealed + awaiting unlock past the stall
    /// threshold. Pure so the view can evaluate it against a live clock.
    /// </summary>
    public static bool ComingUpIsStalled(VMStateKind state, TimeSpan elapsed) =>
        state == VMStateKind.AwaitingPhoneUnlock && elapsed >= ComingUpStallThreshold;

    public VMEvent VerdictForCleanInstallStop(DateTimeOffset now)
    {
        if (State.Kind != VMStateKind.Installing)
            throw new InvalidOperationException($"Install verdict requested in state {State.Kind}.");
        return VerdictForCleanInstallStop(now - StateChangedAt);
    }

    /// <summary>
    /// Apply one event. Returns the effects to execute; throws on an event
    /// that is meaningless in the current state (a programming error or a
    /// stale caller — never silently swallowed).
    /// </summary>
    public IReadOnlyList<VMEffect> Handle(VMEvent ev)
    {
        var (next, effects) = Transition(ev);
        State = next;
        StateChangedAt = _clock();
        return effects;
    }

    private (VMState, VMEffect[]) Transition(VMEvent ev)
    {
        switch (State.Kind, ev.Kind)
        {
            case (VMStateKind.Created, VMEventKind.StartInstall):
                return (VMState.Installing, new[] { VMEffect.AttachInstallerISO, VMEffect.StartVirtualMachine });
            case (VMStateKind.Failed, VMEventKind.StartInstall) when State.Failure?.Phase == VMFailurePhase.Install:
                return (VMState.Installing, new[] { VMEffect.AttachInstallerISO, VMEffect.StartVirtualMachine });

            case (VMStateKind.Installing, VMEventKind.InstallSucceeded):
                // The install→first-boot seam: the ISO comes OFF here so every
                // subsequent boot is from the guest's own disk.
                return (VMState.Installed, new[] { VMEffect.DetachInstallerISO });
            case (VMStateKind.Installing, VMEventKind.InstallFailed):
                return (VMState.Failed(VMFailurePhase.Install, ev.Reason ?? ""),
                        new[] { VMEffect.StopVirtualMachine, VMEffect.DetachInstallerISO });

            case (VMStateKind.Installed, VMEventKind.PowerOn):
            case (VMStateKind.Stopped, VMEventKind.PowerOn):
                return (SealedAtBoot ? VMState.AwaitingPhoneUnlock : VMState.Running,
                        new[] { VMEffect.StartVirtualMachine });
            case (VMStateKind.Failed, VMEventKind.PowerOn) when State.Failure?.Phase == VMFailurePhase.Run:
                return (SealedAtBoot ? VMState.AwaitingPhoneUnlock : VMState.Running,
                        new[] { VMEffect.StartVirtualMachine });

            case (VMStateKind.AwaitingPhoneUnlock, VMEventKind.GuestUnlocked):
                return (VMState.Running, Array.Empty<VMEffect>());
            case (VMStateKind.AwaitingPhoneUnlock, VMEventKind.PowerOff):
            case (VMStateKind.Running, VMEventKind.PowerOff):
                return (VMState.Stopped, new[] { VMEffect.StopVirtualMachine });
            case (VMStateKind.AwaitingPhoneUnlock, VMEventKind.RuntimeFailed):
            case (VMStateKind.Running, VMEventKind.RuntimeFailed):
                return (VMState.Failed(VMFailurePhase.Run, ev.Reason ?? ""), Array.Empty<VMEffect>());

            default:
                throw new VMLifecycleException(State, ev);
        }
    }
}
