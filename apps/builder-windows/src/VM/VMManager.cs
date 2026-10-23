using System;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.ComponentModel;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;

namespace Flagship.Builder.VM;

public sealed record InstallObservation(string Phase, string? Detail, DateTimeOffset UpdatedAt)
{
    public string Summary => !string.IsNullOrWhiteSpace(Detail) ? Detail : Phase switch
    {
        "booting" => "Booting the installer",
        "partitioning" => "Preparing the encrypted disk",
        "installing" => "Installing Debian",
        "downloading" => "Downloading Flagship software",
        "registering" => "Registering the server",
        "sealing" => "Sealing the disk key",
        "installed" => "Installation complete",
        "pairing" => "Pairing with your phone",
        "live" => "Server is live",
        "error" => "Installation reported an error",
        _ => "Waiting for an installer checkpoint",
    };

    public bool IsStale(DateTimeOffset now) => now - UpdatedAt >= TimeSpan.FromMinutes(3);
    public int StaleMinutes(DateTimeOffset now) => Math.Max(0, (int)(now - UpdatedAt).TotalMinutes);
}

/// <summary>
/// One hosted server as the UI sees it: the persisted record + change
/// notifications for every derived display property. Pure presentation
/// mapping — no QEMU, no filesystem.
/// </summary>
public sealed class HostedServer : INotifyPropertyChanged
{
    private VMRecord _record;

    public HostedServer(VMRecord record)
    {
        _record = record;
    }

    public event PropertyChangedEventHandler? PropertyChanged;

    public VMRecord Record
    {
        get => _record;
        set
        {
            _record = value;
            PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(string.Empty));
        }
    }

    public string Name => _record.Config.Name;
    /// <summary>"home.harry" — the short server.username identity, matching
    /// the Mac sidebar.</summary>
    public string DisplayName => $"{_record.Config.ServerName}.{_record.Config.Username}";
    public string Fqdn => _record.Config.ServerDomain;
    public string BadgeLabel => _record.Tier.BadgeLabel();
    public string StateLabel => _record.StateLabel;
    public VMStateKind StateKind => _record.State.Kind;
    public InstallObservation? InstallObservation { get; internal set; }

    /// <summary>The guest's own signed health report while it runs.</summary>
    public VMServerHealth? Health { get; internal set; }
    public HealthVerdict? HealthVerdict => StateKind == VMStateKind.Running ? Health?.Verdict(DateTimeOffset.UtcNow) : null;
    public bool HasHealth => HealthVerdict is not null;
    public string HealthTitle => HealthVerdict is { Ok: false } ? "Server health" : "Health";
    public string HealthText => HealthVerdict is { } v ? string.Join("\n", v.Lines) : "";

    public string LastConnectedText => _record.LastConnectedAt is { } at
        ? "Last connected " + at.ToLocalTime().ToString("d MMM yyyy HH:mm", System.Globalization.CultureInfo.CurrentCulture)
        : "Not connected yet";

    public string SidebarStatus => StateKind == VMStateKind.Installing && InstallObservation is { } observation
        ? observation.IsStale(DateTimeOffset.UtcNow)
            ? $"No guest progress for {observation.StaleMinutes(DateTimeOffset.UtcNow)}m · {observation.Summary}"
            : observation.Summary
        : HealthVerdict is { Ok: false } health ? health.Lines[0] : StateLabel;

    // The copy while a guest is sealed, identical on the Mac and Linux Studios
    // (vm-core-vectors.json "awaitingUnlockCopy"). The phone, not Studio,
    // decides whether a restart needs an approval, so no line promises nobody
    // has to act.
    public const string AwaitingUnlockStalled =
        "Taking longer than expected — the box may not have reached the network, or it may be waiting for you to approve the unlock on your phone. Check that it's online, or power off and retry.";
    public const string AwaitingUnlockOnItsOwn =
        "Unlocking its disk with the key your phone left it. If your phone asks you to approve, approve it there.";
    public const string AwaitingUnlockFirstBoot =
        "The disk is sealed — approve the first unlock on your phone. After that it should unlock on its own; if your phone asks again, approve it there.";
    public const string AwaitingUnlockApproveEveryBoot =
        "The disk is sealed — approve the unlock on your phone.";

    public string StatusSubtitle
    {
        get
        {
            if (ComingUpStalled)
                return AwaitingUnlockStalled;
            return _record.State.Kind switch
            {
                VMStateKind.AwaitingPhoneUnlock => _record.UnlocksOnItsOwn
                    ? AwaitingUnlockOnItsOwn
                    : _record.Config.BootUnlockMode == "approve"
                        ? AwaitingUnlockApproveEveryBoot
                        : AwaitingUnlockFirstBoot,
                VMStateKind.Installing => InstallObservation is null
                    ? "Waiting for the first guest checkpoint."
                    : InstallObservation.IsStale(DateTimeOffset.UtcNow)
                        ? $"No new guest checkpoint for {InstallObservation.StaleMinutes(DateTimeOffset.UtcNow)} minutes. Last reported: {InstallObservation.Summary}. The VM may be stalled."
                        : $"{InstallObservation.Summary}. Guest checkpoint is current.",
                VMStateKind.Running => $"Serving at https://{_record.Config.ServerDomain}/",
                VMStateKind.Failed => _record.State.Failure?.Reason ?? "",
                VMStateKind.Installed or VMStateKind.Stopped => "Start the server to bring it online.",
                _ => "Preparing the installer…",
            };
        }
    }

    /// <summary>True iff this sealed guest has awaited unlock past the stall
    /// threshold — the UI surfaces an advisory then (the poll keeps running).
    /// Falls back to CreatedAt for legacy records with no StateChangedAt.</summary>
    public bool ComingUpStalled
    {
        get
        {
            var since = _record.StateChangedAt == default ? _record.CreatedAt : _record.StateChangedAt;
            return VMLifecycle.ComingUpIsStalled(_record.State.Kind, DateTimeOffset.UtcNow - since);
        }
    }

    /// <summary>Re-raise PropertyChanged for time-derived bindings (StatusSubtitle)
    /// so a sealed guest that produces no state change while it waits still flips
    /// to the stall advisory. Called on a slow UI timer while awaiting unlock.</summary>
    public void RefreshTimeDerivedState() =>
        PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(string.Empty));

    public string SpecSummary
    {
        get
        {
            var c = _record.Config;
            var enc = c.DiskEncrypted ? "Encrypted (LUKS)" : "Unencrypted";
            return $"{c.CpuCount} vCPU · {c.MemoryBytes / VMResourcePlan.GiB} GiB RAM · {c.MainDiskSizeBytes / VMResourcePlan.GiB} GiB disk · {enc}";
        }
    }

    public bool CanStart => _record.State.Kind is VMStateKind.Installed or VMStateKind.Stopped
        || (_record.State.Kind == VMStateKind.Failed && _record.State.Failure?.Phase == VMFailurePhase.Run);
    public bool CanStop => _record.State.Kind is VMStateKind.Running or VMStateKind.AwaitingPhoneUnlock;
    public bool CanCancelInstall => _record.State.Kind == VMStateKind.Installing;
    public bool CanRetryInstall => _record.State.Kind == VMStateKind.Failed
        && _record.State.Failure?.Phase == VMFailurePhase.Install;
    public bool ConsoleEnabled => _record.Config.SerialConsoleEnabled;
}

/// <summary>
/// Runtime orchestrator for hosted VMs: owns the inventory, one pure
/// VMLifecycle per VM (the decision-maker), and one QemuHost per live VM
/// (the dumb executor). Every state change is persisted, so the sidebar
/// survives relaunches. Mirrors the Mac's VMManager, with one upgrade the
/// Mac file still carries as a TODO: a clean guest-stop during install goes
/// through the duration-gated verdict instead of being read as success
/// unconditionally.
/// </summary>
public sealed class VMManager
{
    public ObservableCollection<HostedServer> Servers { get; } = new();

    /// <summary>Log sink — the wizard routes this into its log pane.</summary>
    public Action<string> Log = _ => { };

    /// <summary>Called with true while any server installs, waits for its
    /// unlock or runs (the PC must not sleep), and with false once none
    /// does. The app marshals it to the UI thread (SetThreadExecutionState
    /// is per thread).</summary>
    public Action<bool> WakeHoldChanged = _ => { };
    private bool _wakeHeld;

    public VMInventoryStore Store { get; }

    /// <summary>Non-null when the QEMU toolchain could not be located; the
    /// host-here path is disabled with this reason.</summary>
    public string? ToolchainError { get; }

    private readonly QemuToolchain? _toolchain;
    public QemuToolchain? Toolchain => _toolchain;
    private readonly Dictionary<string, VMLifecycle> _lifecycles = new();
    private readonly Dictionary<string, QemuHost> _hosts = new();
    /// <summary>Guests powering off after a Stop; a Start waits for them.</summary>
    private readonly PendingStops _stopping = new();
    /// <summary>Set once the app starts quitting: nothing new may boot.</summary>
    private bool _quitting;
    private readonly Dictionary<string, bool> _attachIso = new();
    private readonly Dictionary<string, CancellationTokenSource> _unlockPolls = new();
    private readonly Dictionary<string, CancellationTokenSource> _installPolls = new();
    private readonly Dictionary<string, CancellationTokenSource> _healthPolls = new();
    private readonly Dictionary<string, CancellationTokenSource> _codeWatches = new();
    private static readonly HttpClient SeenReport = new() { Timeout = TimeSpan.FromSeconds(10) };

    /// <summary>The six-digit code each hosted server showed this boot (first contact).</summary>
    public Dictionary<string, string> ServerCodes { get; } = new();
    private readonly Func<string, CancellationToken, Task<string?>> _healthFetch;
    private readonly TimeSpan _healthInterval;
    private readonly Func<string, CancellationToken, Task<bool>> _unlockProbe;
    private readonly TimeSpan _unlockInterval;
    private readonly Func<ulong?> _availableMemory;
    private readonly HashSet<string> _installStallLogged = new();
    private readonly SynchronizationContext? _sync;
    private readonly Func<DateTimeOffset> _clock;
    private static readonly HttpClient UnlockProbe = new() { Timeout = TimeSpan.FromSeconds(10) };
    private static readonly HttpClient InstallProbe = new() { Timeout = TimeSpan.FromSeconds(10) };
    private static readonly HttpClient HealthProbe = new() { Timeout = TimeSpan.FromSeconds(15) };
    private static readonly Regex ProvisionSerial = new("^[A-Za-z0-9_-]{8,64}$", RegexOptions.CultureInvariant);
    private static readonly HashSet<string> ProvisionPhases = new()
    {
        "booting", "partitioning", "installing", "downloading", "registering",
        "sealing", "installed", "pairing", "live", "error",
    };

    public VMManager(VMInventoryStore store, QemuToolchain? toolchain, string? toolchainError = null,
                     Func<DateTimeOffset>? clock = null,
                     Func<string, CancellationToken, Task<string?>>? healthFetch = null,
                     TimeSpan? healthInterval = null,
                     Func<string, CancellationToken, Task<bool>>? unlockProbe = null,
                     TimeSpan? unlockInterval = null,
                     Func<ulong?>? availableMemory = null)
    {
        Store = store;
        _toolchain = toolchain;
        ToolchainError = toolchainError;
        _clock = clock ?? (() => DateTimeOffset.UtcNow);
        _healthFetch = healthFetch ?? FetchHealthAsync;
        _healthInterval = healthInterval ?? TimeSpan.FromMinutes(1);
        _unlockProbe = unlockProbe ?? ProbeNameAsync;
        _unlockInterval = unlockInterval ?? TimeSpan.FromSeconds(15);
        _availableMemory = availableMemory ?? HostResources.AvailableMemoryBytes;
        _sync = SynchronizationContext.Current;
        LoadAndNormalize();
    }

    /// <summary>How long Stop, Restart and Quit wait for the guest to power
    /// off after pressing its power button before pulling the plug. A forced
    /// stop seconds after an update rebuilt the server's code left it half
    /// updated. Matches the Mac.</summary>
    public const int GracefulStopSeconds = 60;

    public const string QuitDuringInstallReason = "The app quit while the install was running.";

    public static VMManager CreateDefault()
    {
        QemuToolchain? toolchain = null;
        string? error = null;
        try { toolchain = QemuLocator.Locate(); }
        catch (QemuLocatorException e) { error = e.Message; }
        return new VMManager(new VMInventoryStore(VMBundleLayout.DefaultRoot()), toolchain, error);
    }

    /// <summary>How many VMs this host allows at once (pure cap math).</summary>
    public int MaxVMCount => VMResourcePlan.MaxVMCount(HostResources.Current());
    public bool AtCapacity => Servers.Count >= MaxVMCount;

    public HostedServer? Server(string name) => Servers.FirstOrDefault(s => s.Name == name);

    /// <summary>The live QEMU adapter for a VM (console access etc.), if running.</summary>
    public QemuHost? Host(string name) => _hosts.TryGetValue(name, out var h) ? h : null;

    public string InstallerIsoPath(string name) => Store.Layout.InstallerIsoPath(name);
    public string ApplianceSeedPath(string name) => Store.Layout.ApplianceSeedPath(name);

    // ---- Launch normalization ----

    /// <summary>
    /// VMs die with the app, so any persisted "live" state found at launch is
    /// stale: a mid-install VM becomes a retryable install failure; a booted
    /// one is simply stopped.
    /// </summary>
    private void LoadAndNormalize()
    {
        foreach (var record in Store.List())
        {
            var normalized = record.State.Kind switch
            {
                VMStateKind.Installing => record with
                {
                    State = VMState.Failed(VMFailurePhase.Install, QuitDuringInstallReason),
                    StateChangedAt = _clock(),
                },
                VMStateKind.AwaitingPhoneUnlock or VMStateKind.Running =>
                    record with { State = VMState.Stopped, StateChangedAt = _clock() },
                _ => record,
            };
            if (!ReferenceEquals(normalized, record))
            {
                try { Store.Save(normalized); } catch { }
            }
            Servers.Add(new HostedServer(normalized));
        }
    }

    // ---- Creation / deletion ----

    /// <summary>
    /// Create the persistent bundle for a planned VM. The caller (wizard)
    /// then remasters the installer ISO into InstallerIsoPath(name) and
    /// calls BeginInstallAsync.
    /// </summary>
    /// <summary>
    /// The phone's key for confirming the next hosted server's code (first contact): kept with that
    /// server's bundle once it is created, until Studio has reported the code it saw.
    /// </summary>
    public byte[]? PendingStudioConfirmKey { get; set; }

    public void CreateServer(VMConfig config)
    {
        var now = _clock();
        var record = new VMRecord
        {
            Config = config,
            State = VMState.Created,
            CreatedAt = now,
            StateChangedAt = now,
            Tier = ServerTier.HostedVM,
        };
        Store.Create(record);
        if (PendingStudioConfirmKey is { Length: 32 } key)
        {
            try { StudioConfirmKeyFile.Write(key, Store.Layout, config.Name); } catch (IOException) { }
        }
        PendingStudioConfirmKey = null;
        InsertSorted(new HostedServer(record));
        _lifecycles[config.Name] = new VMLifecycle(config.AwaitsPhoneUnlockAtBoot, VMState.Created);
    }

    /// <summary>Drop a hosted server entirely (its disk image included).
    /// Stops it first if live.</summary>
    public async Task DeleteServerAsync(string name)
    {
        if (_codeWatches.Remove(name, out var codeWatch)) codeWatch.Cancel();
        ServerCodes.Remove(name);
        if (_hosts.TryGetValue(name, out var host))
        {
            host.OnGuestStopped = null;
            try { await host.ForceStopAsync(); } catch { }
        }
        await _stopping.WaitAsync(name);
        _hosts.Remove(name);
        _lifecycles.Remove(name);
        if (_unlockPolls.Remove(name, out var cts)) cts.Cancel();
        if (_installPolls.Remove(name, out var installCts)) installCts.Cancel();
        if (_healthPolls.Remove(name, out var healthCts)) healthCts.Cancel();
        try { Store.Delete(name); } catch { }
        var server = Server(name);
        if (server != null) Servers.Remove(server);
        SyncWakeHold();
    }

    /// <summary>True while any server installs, waits for its unlock, or runs.</summary>
    public bool NeedsAwake => Servers.Any(s => s.StateKind is VMStateKind.Installing
        or VMStateKind.AwaitingPhoneUnlock or VMStateKind.Running);

    /// <summary>Hold off system sleep while servers need the PC; a sleeping
    /// PC takes every server offline. The display may still sleep. Mirrors
    /// the Mac VMManager.syncWakeHold.</summary>
    private void SyncWakeHold()
    {
        var wanted = NeedsAwake;
        if (wanted == _wakeHeld) return;
        _wakeHeld = wanted;
        Log(wanted ? "Keeping this PC awake while it hosts servers" : "No server running: this PC may sleep again");
        WakeHoldChanged(wanted);
    }

    // ---- Lifecycle driving ----

    public Task BeginInstallAsync(string name) => ApplyAsync(VMEvent.StartInstall, name);
    public Task CancelInstallAsync(string name)
        => ApplyAsync(VMEvent.InstallFailed("Installation stopped by you."), name);
    public Task PowerOnAsync(string name) => ApplyAsync(VMEvent.PowerOn, name);
    public Task PowerOffAsync(string name) => ApplyAsync(VMEvent.PowerOff, name);

    /// <summary>True while quitting would abandon a guest: one that is booted,
    /// installing, or still powering off after a Stop. QEMU runs as separate
    /// processes that outlive the app.</summary>
    public bool HasLiveServers => _stopping.AnyInFlight
        || Servers.Any(s => s.CanStop || s.CanCancelInstall);

    /// <summary>
    /// Used on quit. Powers every booted server off gracefully, all at once,
    /// stops any install (it is retried later, as after any interrupted
    /// install), and waits for stops already in flight. Nothing boots after
    /// this starts.
    /// </summary>
    public async Task ShutDownAllAsync()
    {
        _quitting = true;
        var booted = Servers.Where(s => s.CanStop).Select(s => s.Name).ToArray();
        var installing = Servers.Where(s => s.CanCancelInstall).Select(s => s.Name).ToArray();
        if (booted.Length + installing.Length > 0)
            Log($"Shutting down {booted.Length + installing.Length} server(s) before quitting");
        var work = booted.Select(PowerOffAsync)
            .Concat(installing.Select(n => ApplyAsync(VMEvent.InstallFailed(QuitDuringInstallReason), n)))
            .ToArray();
        try
        {
            await Task.WhenAll(work);
        }
        finally
        {
            await _stopping.WaitAllAsync();
        }
    }

    /// <summary>The app is staying open after all (a cancelled restart as
    /// administrator): servers may boot again.</summary>
    public void CancelQuit() => _quitting = false;

    /// <summary>Whether a stop that leaves the lifecycle in this state presses
    /// the guest's power button first. A booted server gets to stop its daemon
    /// and flush its disk; an install that failed or was cancelled is redone
    /// from scratch, so it is cut at once.</summary>
    public static bool StopsGracefully(VMStateKind stateAfterStop) => stateAfterStop == VMStateKind.Stopped;

    /// <summary>
    /// Feed one event through the pure state machine, persist the new state,
    /// and execute the effects it ordered.
    /// </summary>
    private async Task ApplyAsync(VMEvent ev, string name)
    {
        var server = Server(name);
        if (server is null) return;
        if (_quitting && (ev.Kind is VMEventKind.StartInstall or VMEventKind.PowerOn))
        {
            Log($"VM {name}: not starting while the app quits");
            return;
        }
        var lc = _lifecycles.TryGetValue(name, out var existing)
            ? existing
            : new VMLifecycle(server.Record.Config.AwaitsPhoneUnlockAtBoot, server.Record.State, _clock);
        _lifecycles[name] = lc;
        IReadOnlyList<VMEffect> effects;
        try
        {
            effects = lc.Handle(ev);
        }
        catch (VMLifecycleException)
        {
            Log($"VM {name}: ignored {ev.Kind} in state {server.Record.State.Label}");
            return;
        }
        server.Record = server.Record with
        {
            State = lc.State,
            StateChangedAt = lc.StateChangedAt,
            LastConnectedAt = lc.State.Kind == VMStateKind.Running ? lc.StateChangedAt : server.Record.LastConnectedAt,
        };
        try { Store.Save(server.Record); } catch { }
        CancelPollsLeftBehind(name);
        SyncWakeHold();
        await RunEffectsAsync(effects, server.Record.Config);
        SyncUnlockPoll(server.Record.Config);
        SyncInstallPoll(server.Record.Config);
        SyncHealthPoll(server.Record.Config);
    }

    private async Task RunEffectsAsync(IReadOnlyList<VMEffect> effects, VMConfig config)
    {
        var name = config.Name;
        foreach (var effect in effects)
        {
            switch (effect)
            {
                case VMEffect.AttachInstallerISO:
                    _attachIso[name] = true;
                    break;
                case VMEffect.DetachInstallerISO:
                    _attachIso[name] = false;
                    // Reclaim the (large) single-use installer once the install
                    // SUCCEEDED; a failed install keeps it so retry can re-attach.
                    if (CurrentStateKind(name) == VMStateKind.Installed)
                    {
                        var media = config.ProvisioningMode == VMProvisioningMode.PrebuiltAppliance
                            ? Store.Layout.ApplianceSeedPath(name)
                            : Store.Layout.InstallerIsoPath(name);
                        try { File.Delete(media); } catch { }
                    }
                    break;
                case VMEffect.StartVirtualMachine:
                    await StartVmAsync(config);
                    break;
                case VMEffect.StopVirtualMachine:
                    if (_hosts.TryGetValue(name, out var host))
                        await StopHostAsync(name, host, StopsGracefully(CurrentStateKind(name)));
                    break;
            }
        }
    }

    /// <summary>
    /// Stop one guest, tracked so a Start of the same server waits for it.
    /// The host stays registered until its process is gone, so Delete can
    /// still force it. The lifecycle already records the outcome, so the
    /// exit this causes is not news: its callback is detached, which also
    /// keeps a late exit from landing on a newer run of the same server.
    /// </summary>
    private async Task StopHostAsync(string name, QemuHost host, bool graceful)
    {
        host.OnGuestStopped = null;
        if (graceful) Log($"VM {name}: shutting down (up to {GracefulStopSeconds}s before forcing)");
        await _stopping.RunAsync(name, () => graceful
            ? host.StopAsync(GracefulStopSeconds)
            : host.ForceStopAsync());
        if (_hosts.TryGetValue(name, out var live) && ReferenceEquals(live, host))
            _hosts.Remove(name);
        if (graceful) Log($"VM {name}: powered off");
    }

    /// <summary>A stop can take a minute; stop watching a guest that is no
    /// longer sealed or installing right away rather than after it.</summary>
    private void CancelPollsLeftBehind(string name)
    {
        var kind = CurrentStateKind(name);
        if (kind != VMStateKind.AwaitingPhoneUnlock && _unlockPolls.Remove(name, out var unlock))
            unlock.Cancel();
        if (kind != VMStateKind.Installing && _installPolls.Remove(name, out var install))
            install.Cancel();
        if (kind != VMStateKind.Running) StopHealthPoll(name);
    }

    /// <summary>States in which the lifecycle expects a QEMU process.</summary>
    private static bool WantsGuest(VMStateKind kind)
        => kind is VMStateKind.Installing or VMStateKind.AwaitingPhoneUnlock or VMStateKind.Running;

    private VMStateKind CurrentStateKind(string name)
        => Server(name)?.Record.State.Kind ?? VMStateKind.Created;

    private async Task StartVmAsync(VMConfig config)
    {
        var name = config.Name;
        // A Start pressed while the guest is still shutting down must not
        // open the same disk in a second QEMU.
        if (_stopping.IsStopping(name))
        {
            Log($"VM {name}: waiting for the previous shutdown to finish");
            await _stopping.WaitAsync(name);
            if (_quitting || !WantsGuest(CurrentStateKind(name))) return;
        }
        if (_toolchain is null)
        {
            var reason = ToolchainError ?? "QEMU is not installed.";
            Log($"VM {name}: cannot start — {reason}");
            await FailFromStateAsync(name, reason);
            return;
        }
        // WHPX maps the guest's RAM up front: refuse with a plain sentence
        // instead of letting QEMU die with "failed to map GPA range".
        if (QemuFailure.CheckFreeMemory(config.MemoryBytes, _availableMemory(), QemuFailure.WhpxHeadroomBytes)
            is { } tooLittle)
        {
            Log($"VM {name}: cannot start — {tooLittle}");
            await FailFromStateAsync(name, tooLittle);
            return;
        }
        try
        {
            var host = new QemuHost(_toolchain);
            host.OnGuestStopped = (code, stderrTail) => OnUi(() => _ = GuestStoppedAsync(name, host, code, stderrTail));
            _hosts[name] = host;
            await host.StartAsync(config, Store.Layout, _attachIso.TryGetValue(name, out var a) && a);
            Log($"VM {name}: started ({config.CpuCount} vCPU, {config.MemoryBytes / VMResourcePlan.GiB} GiB)");
            WatchServerCode(config);
        }
        catch (Exception e)
        {
            _hosts.Remove(name);
            Log($"VM {name}: failed to start — {e.Message}");
            await FailFromStateAsync(name, e.Message);
        }
    }

    private async Task FailFromStateAsync(string name, string reason)
    {
        switch (CurrentStateKind(name))
        {
            case VMStateKind.Installing:
                await ApplyAsync(VMEvent.InstallFailed(reason), name);
                break;
            case VMStateKind.AwaitingPhoneUnlock:
            case VMStateKind.Running:
                await ApplyAsync(VMEvent.RuntimeFailed(reason), name);
                break;
        }
    }

    /// <summary>
    /// The guest stopped on its own. What it MEANS depends on the phase the
    /// pure lifecycle is in. During install a clean stop is AMBIGUOUS
    /// (success-poweroff / completed-install reboot / never-booted all look
    /// identical), so it goes through the duration-gated verdict — the
    /// hard-won Mac Phase-0 finding.
    /// </summary>
    private async Task GuestStoppedAsync(string name, QemuHost host, int exitCode, string stderrTail)
    {
        if (_codeWatches.Remove(name, out var codeWatch)) codeWatch.Cancel();
        // A newer run of this server owns it now; this exit is old news.
        if (_hosts.TryGetValue(name, out var live) && !ReferenceEquals(live, host)) return;
        _hosts.Remove(name);
        switch (CurrentStateKind(name))
        {
            case VMStateKind.Installing:
                if (exitCode != 0)
                {
                    await ApplyAsync(VMEvent.InstallFailed(
                        QemuFailure.DescribeExit(exitCode, stderrTail, Server(name)!.Record.Config.MemoryBytes)), name);
                    return;
                }
                var config = Server(name)!.Record.Config;
                var verdict = _lifecycles.TryGetValue(name, out var lc)
                    ? VMLifecycle.VerdictForCleanProvisioningStop(
                        _clock() - lc.StateChangedAt, config.ProvisioningMode)
                    : VMEvent.InstallSucceeded;
                if (verdict.Kind == VMEventKind.InstallSucceeded)
                {
                    var verb = config.ProvisioningMode == VMProvisioningMode.PrebuiltAppliance
                        ? "specialization" : "install";
                    Log($"VM {name}: {verb} finished — booting sealed disk");
                    await ApplyAsync(VMEvent.InstallSucceeded, name);
                    // First boot from disk follows immediately; an encrypted
                    // guest then sits sealed in awaiting-phone-unlock.
                    await ApplyAsync(VMEvent.PowerOn, name);
                }
                else
                {
                    Log($"VM {name}: {verdict.Reason}");
                    await ApplyAsync(verdict, name);
                }
                break;

            case VMStateKind.AwaitingPhoneUnlock:
            case VMStateKind.Running:
                if (exitCode != 0)
                {
                    await ApplyAsync(VMEvent.RuntimeFailed(
                        QemuFailure.DescribeExit(exitCode, stderrTail, Server(name)!.Record.Config.MemoryBytes)), name);
                }
                else
                {
                    await ApplyAsync(VMEvent.PowerOff, name);
                }
                break;
        }
    }

    // ---- Unlock detection ----

    /// <summary>
    /// While a guest sits sealed, poll its public FQDN. TLS terminates ON THE
    /// BOX (SNI passthrough), so any HTTP response proves the LUKS unlock
    /// completed, the daemon came up, and the tunnel serves — real evidence,
    /// not a timer. The host app is not in the unlock loop and never holds a
    /// key.
    /// </summary>
    private void SyncUnlockPoll(VMConfig config)
    {
        var name = config.Name;
        var isSealed = CurrentStateKind(name) == VMStateKind.AwaitingPhoneUnlock;
        if (!isSealed)
        {
            if (_unlockPolls.Remove(name, out var old)) old.Cancel();
            return;
        }
        if (_unlockPolls.ContainsKey(name)) return;
        var cts = new CancellationTokenSource();
        _unlockPolls[name] = cts;
        var domain = config.ServerDomain;
        var healthUrl = VMServerHealth.OrderHealthUrl(config.ProvisionStatusSerial);
        var poweredOnAt = _clock();
        _ = Task.Run(async () =>
        {
            if (await UnlockWatch.RunAsync(domain, healthUrl, poweredOnAt, _clock, _healthFetch,
                    _unlockProbe, _unlockInterval, cts.Token) && !cts.IsCancellationRequested)
                OnUi(() => _ = ApplyAsync(VMEvent.GuestUnlocked, name));
        });
    }

    private static async Task<bool> ProbeNameAsync(string url, CancellationToken ct)
    {
        using var response = await UnlockProbe.GetAsync(url, ct);
        return true;
    }

    // ---- First contact: the code the guest shows on its server-code port ----

    /// <summary>
    /// Read what the guest writes to its server-code port. On this server's own line, note the code and,
    /// when the phone gave this server a confirm key, tell `.com` what was seen so the phone can confirm
    /// it without asking. Best effort: the phone falls back to asking the owner to compare the code.
    /// </summary>
    private void WatchServerCode(VMConfig config)
    {
        var name = config.Name;
        if (_codeWatches.Remove(name, out var old)) old.Cancel();
        var cts = new CancellationTokenSource();
        _codeWatches[name] = cts;
        var path = ServerCodeSeen.PortLogPath(Store.Layout, name);
        var layout = Store.Layout;
        var host = Environment.GetEnvironmentVariable("FLAGSHIP_CONTROL_HOST") ?? "flagshipserver.com";
        _ = Task.Run(async () =>
        {
            var splitter = new ConsoleLineSplitter();
            long offset = 0;
            var reported = false;
            while (!cts.IsCancellationRequested && !reported)
            {
                try
                {
                    if (File.Exists(path))
                    {
                        using var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
                        if (fs.Length < offset) offset = 0;
                        fs.Seek(offset, SeekOrigin.Begin);
                        var buf = new byte[fs.Length - offset];
                        var n = await fs.ReadAsync(buf, cts.Token);
                        offset += n;
                        foreach (var line in splitter.Feed(buf.AsSpan(0, n)))
                        {
                            if (ServerCodeSeen.Parse(line, config.ServerDomain) is not { } seen) continue;
                            OnUi(() =>
                            {
                                if (!ServerCodes.TryGetValue(name, out var c) || c != seen.Code)
                                {
                                    ServerCodes[name] = seen.Code;
                                    Log($"VM {name}: this server's code is {ServerCodeSeen.Pretty(seen.Code)}");
                                }
                            });
                            var key = StudioConfirmKeyFile.Read(layout, name);
                            var serial = config.ProvisionStatusSerial;
                            if (key is null || string.IsNullOrEmpty(serial) || !ProvisionSerial.IsMatch(serial)) { reported = true; break; }
                            var mac = ServerCodeSeen.MacHex(key, config.ServerDomain, seen.StkPubHex);
                            if (mac is null) { reported = true; break; }
                            reported = await ReportServerSeenAsync($"https://{host}/api/order/{serial}/server-seen",
                                ServerCodeSeen.Body(seen.StkPubHex, mac), cts.Token);
                            if (reported)
                            {
                                StudioConfirmKeyFile.Delete(layout, name);
                                OnUi(() => Log($"VM {name}: told your phone which server this is"));
                            }
                            reported = true;
                            break;
                        }
                    }
                    await Task.Delay(TimeSpan.FromSeconds(2), cts.Token);
                }
                catch (OperationCanceledException) { return; }
                catch (IOException) { }
            }
        });
    }

    private static async Task<bool> ReportServerSeenAsync(string url, string body, CancellationToken ct)
    {
        for (var attempt = 0; attempt < 4; attempt++)
        {
            try
            {
                using var content = new StringContent(body, System.Text.Encoding.UTF8, "application/json");
                using var response = await SeenReport.PostAsync(url, content, ct);
                if (response.IsSuccessStatusCode) return true;
                var code = (int)response.StatusCode;
                if (code >= 400 && code < 500 && code != 404 && code != 429) return false;
            }
            catch (HttpRequestException) { }
            catch (TaskCanceledException) when (!ct.IsCancellationRequested) { }
            await Task.Delay(TimeSpan.FromSeconds(5 + attempt * 10), ct);
        }
        return false;
    }

    // ---- Privacy-safe install checkpoints ----

    private void SyncInstallPoll(VMConfig config)
    {
        var name = config.Name;
        if (CurrentStateKind(name) != VMStateKind.Installing)
        {
            if (_installPolls.Remove(name, out var old)) old.Cancel();
            _installStallLogged.Remove(name);
            return;
        }
        var serial = config.ProvisionStatusSerial;
        if (_installPolls.ContainsKey(name) || string.IsNullOrEmpty(serial)
            || !ProvisionSerial.IsMatch(serial)) return;
        var startedAt = Server(name)?.Record.StateChangedAt ?? _clock();
        var cts = new CancellationTokenSource();
        _installPolls[name] = cts;
        _ = Task.Run(async () =>
        {
            var url = $"https://{Environment.GetEnvironmentVariable("FLAGSHIP_CONTROL_HOST") ?? "flagshipserver.com"}/api/order/{serial}/status";
            while (!cts.IsCancellationRequested)
            {
                try
                {
                    using var response = await InstallProbe.GetAsync(url, cts.Token);
                    if (response.IsSuccessStatusCode)
                    {
                        using var doc = JsonDocument.Parse(await response.Content.ReadAsStringAsync(cts.Token));
                        var root = doc.RootElement;
                        var phase = root.GetProperty("phase").GetString();
                        var updatedAt = DateTimeOffset.FromUnixTimeMilliseconds(root.GetProperty("updatedAt").GetInt64());
                        if (phase is not null && ProvisionPhases.Contains(phase)
                            && updatedAt >= startedAt.AddSeconds(-30))
                        {
                            string? detail = root.TryGetProperty("detail", out var d) && d.ValueKind == JsonValueKind.String
                                ? new string((d.GetString() ?? "").Where(c => !char.IsControl(c)).Take(240).ToArray())
                                : null;
                            var observation = new InstallObservation(phase, detail, updatedAt);
                            OnUi(() =>
                            {
                                var server = Server(name);
                                if (server is null) return;
                                var changed = server.InstallObservation != observation;
                                server.InstallObservation = observation;
                                if (changed) Log($"VM {name}: installer checkpoint — {observation.Summary}");
                                if (!observation.IsStale(_clock())) _installStallLogged.Remove(name);
                                server.RefreshTimeDerivedState();
                            });
                        }
                    }
                }
                catch (OperationCanceledException) when (cts.IsCancellationRequested) { return; }
                catch { }
                OnUi(() =>
                {
                    var observation = Server(name)?.InstallObservation;
                    if (observation is null || !observation.IsStale(_clock())
                        || !_installStallLogged.Add(name)) return;
                    Log($"VM {name}: no guest checkpoint for {observation.StaleMinutes(_clock())} minutes; last: {observation.Summary}");
                });
                try { await Task.Delay(TimeSpan.FromSeconds(15), cts.Token); }
                catch (OperationCanceledException) { return; }
            }
        });
    }

    // ---- Health reports ----

    /// <summary>
    /// While a guest runs, read its signed health report from `.com` (by the
    /// order that created it) once a minute. The report comes from a timer
    /// inside the guest, so it explains a server that stopped answering. A VM
    /// without an order serial shows no health line.
    /// </summary>
    private void SyncHealthPoll(VMConfig config)
    {
        var name = config.Name;
        if (CurrentStateKind(name) != VMStateKind.Running)
        {
            StopHealthPoll(name);
            return;
        }
        var url = VMServerHealth.OrderHealthUrl(config.ProvisionStatusSerial);
        if (_healthPolls.ContainsKey(name) || url is null) return;
        var cts = new CancellationTokenSource();
        _healthPolls[name] = cts;
        var domain = config.ServerDomain;
        _ = Task.Run(async () =>
        {
            var lastIssues = "";
            while (!cts.IsCancellationRequested)
            {
                string? body = null;
                try { body = await _healthFetch(url, cts.Token); }
                catch (OperationCanceledException) when (cts.IsCancellationRequested) { return; }
                catch { }
                if (body is not null && VMServerHealth.FromOrderHealth(body, domain) is { } health)
                {
                    OnUi(() =>
                    {
                        if (cts.IsCancellationRequested || Server(name) is not { } server) return;
                        server.Health = health;
                        server.RefreshTimeDerivedState();
                        var v = health.Verdict(_clock());
                        var issues = v.Ok ? "" : string.Join(" ", v.Lines);
                        if (issues == lastIssues) return;
                        Log(issues.Length == 0 ? $"VM {name}: health back to normal" : $"VM {name}: health — {issues}");
                        lastIssues = issues;
                    });
                }
                try { await Task.Delay(_healthInterval, cts.Token); }
                catch (OperationCanceledException) { return; }
            }
        });
    }

    private void StopHealthPoll(string name)
    {
        if (_healthPolls.Remove(name, out var cts)) cts.Cancel();
        if (Server(name) is { Health: not null } server)
        {
            server.Health = null;
            server.RefreshTimeDerivedState();
        }
    }

    private static async Task<string?> FetchHealthAsync(string url, CancellationToken ct)
    {
        using var response = await HealthProbe.GetAsync(url, ct);
        return response.IsSuccessStatusCode ? await response.Content.ReadAsStringAsync(ct) : null;
    }

    // ---- plumbing ----

    private void InsertSorted(HostedServer server)
    {
        var i = 0;
        while (i < Servers.Count && string.CompareOrdinal(Servers[i].Name, server.Name) < 0) i++;
        Servers.Insert(i, server);
    }

    /// <summary>Marshal to the UI thread when one exists (QemuHost events fire
    /// on the thread pool); run inline in tests.</summary>
    private void OnUi(Action action)
    {
        if (_sync != null) _sync.Post(_ => action(), null);
        else action();
    }
}
