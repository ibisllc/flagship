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
    public string StateLabel => _record.State.Label;
    public VMStateKind StateKind => _record.State.Kind;
    public InstallObservation? InstallObservation { get; internal set; }
    public string SidebarStatus => StateKind == VMStateKind.Installing && InstallObservation is { } observation
        ? observation.IsStale(DateTimeOffset.UtcNow)
            ? $"No guest progress for {observation.StaleMinutes(DateTimeOffset.UtcNow)}m · {observation.Summary}"
            : observation.Summary
        : StateLabel;

    public string StatusSubtitle
    {
        get
        {
            if (ComingUpStalled)
                return "Taking longer than expected — the box may not have reached the network. Check that it's online, or power off and retry.";
            return _record.State.Kind switch
            {
                VMStateKind.AwaitingPhoneUnlock => _record.Config.BootUnlockMode == "approve"
                    ? "The disk is sealed — approve the unlock on your phone."
                    : "The disk is sealed — waiting for the phone-home unlock.",
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

    public VMInventoryStore Store { get; }

    /// <summary>Non-null when the QEMU toolchain could not be located; the
    /// host-here path is disabled with this reason.</summary>
    public string? ToolchainError { get; }

    private readonly QemuToolchain? _toolchain;
    public QemuToolchain? Toolchain => _toolchain;
    private readonly Dictionary<string, VMLifecycle> _lifecycles = new();
    private readonly Dictionary<string, QemuHost> _hosts = new();
    private readonly Dictionary<string, bool> _attachIso = new();
    private readonly Dictionary<string, CancellationTokenSource> _unlockPolls = new();
    private readonly Dictionary<string, CancellationTokenSource> _installPolls = new();
    private readonly HashSet<string> _installStallLogged = new();
    private readonly SynchronizationContext? _sync;
    private readonly Func<DateTimeOffset> _clock;
    private static readonly HttpClient UnlockProbe = new() { Timeout = TimeSpan.FromSeconds(10) };
    private static readonly HttpClient InstallProbe = new() { Timeout = TimeSpan.FromSeconds(10) };
    private static readonly Regex ProvisionSerial = new("^[A-Za-z0-9_-]{8,64}$", RegexOptions.CultureInvariant);
    private static readonly HashSet<string> ProvisionPhases = new()
    {
        "booting", "partitioning", "installing", "downloading", "registering",
        "sealing", "installed", "pairing", "live", "error",
    };

    public VMManager(VMInventoryStore store, QemuToolchain? toolchain, string? toolchainError = null,
                     Func<DateTimeOffset>? clock = null)
    {
        Store = store;
        _toolchain = toolchain;
        ToolchainError = toolchainError;
        _clock = clock ?? (() => DateTimeOffset.UtcNow);
        _sync = SynchronizationContext.Current;
        LoadAndNormalize();
    }

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
                    State = VMState.Failed(VMFailurePhase.Install, "The app quit while the install was running."),
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
        InsertSorted(new HostedServer(record));
        _lifecycles[config.Name] = new VMLifecycle(config.AwaitsPhoneUnlockAtBoot, VMState.Created);
    }

    /// <summary>Drop a hosted server entirely (its disk image included).
    /// Stops it first if live.</summary>
    public async Task DeleteServerAsync(string name)
    {
        if (_hosts.TryGetValue(name, out var host)) { try { await host.ForceStopAsync(); } catch { } }
        _hosts.Remove(name);
        _lifecycles.Remove(name);
        if (_unlockPolls.Remove(name, out var cts)) cts.Cancel();
        if (_installPolls.Remove(name, out var installCts)) installCts.Cancel();
        try { Store.Delete(name); } catch { }
        var server = Server(name);
        if (server != null) Servers.Remove(server);
    }

    // ---- Lifecycle driving ----

    public Task BeginInstallAsync(string name) => ApplyAsync(VMEvent.StartInstall, name);
    public Task CancelInstallAsync(string name)
        => ApplyAsync(VMEvent.InstallFailed("Installation stopped by you."), name);
    public Task PowerOnAsync(string name) => ApplyAsync(VMEvent.PowerOn, name);
    public Task PowerOffAsync(string name) => ApplyAsync(VMEvent.PowerOff, name);

    /// <summary>
    /// Feed one event through the pure state machine, persist the new state,
    /// and execute the effects it ordered.
    /// </summary>
    private async Task ApplyAsync(VMEvent ev, string name)
    {
        var server = Server(name);
        if (server is null) return;
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
        var config = lc.State.Kind == VMStateKind.Installed
            ? server.Record.Config with { ProvisionStatusSerial = null }
            : server.Record.Config;
        server.Record = server.Record with
        {
            Config = config,
            State = lc.State,
            StateChangedAt = lc.StateChangedAt,
        };
        try { Store.Save(server.Record); } catch { }
        await RunEffectsAsync(effects, server.Record.Config);
        SyncUnlockPoll(server.Record.Config);
        SyncInstallPoll(server.Record.Config);
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
                    if (_hosts.Remove(name, out var host))
                    {
                        try { await host.ForceStopAsync(); } catch { }
                    }
                    break;
            }
        }
    }

    private VMStateKind CurrentStateKind(string name)
        => Server(name)?.Record.State.Kind ?? VMStateKind.Created;

    private async Task StartVmAsync(VMConfig config)
    {
        var name = config.Name;
        if (_toolchain is null)
        {
            var reason = ToolchainError ?? "QEMU is not installed.";
            Log($"VM {name}: cannot start — {reason}");
            await FailFromStateAsync(name, reason);
            return;
        }
        try
        {
            var host = new QemuHost(_toolchain);
            host.OnGuestStopped = (code, stderrTail) => OnUi(() => _ = GuestStoppedAsync(name, code, stderrTail));
            _hosts[name] = host;
            await host.StartAsync(config, Store.Layout, _attachIso.TryGetValue(name, out var a) && a);
            Log($"VM {name}: started ({config.CpuCount} vCPU, {config.MemoryBytes / VMResourcePlan.GiB} GiB)");
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
    private async Task GuestStoppedAsync(string name, int exitCode, string stderrTail)
    {
        _hosts.Remove(name);
        switch (CurrentStateKind(name))
        {
            case VMStateKind.Installing:
                if (exitCode != 0)
                {
                    await ApplyAsync(VMEvent.InstallFailed(
                        $"QEMU exited {exitCode}: {stderrTail.Trim()}"), name);
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
                        $"QEMU exited {exitCode}: {stderrTail.Trim()}"), name);
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
        _ = Task.Run(async () =>
        {
            var url = $"https://{config.ServerDomain}/";
            while (!cts.IsCancellationRequested)
            {
                try
                {
                    using var response = await UnlockProbe.GetAsync(url, cts.Token);
                    OnUi(() => _ = ApplyAsync(VMEvent.GuestUnlocked, name));
                    return;
                }
                catch (OperationCanceledException) when (cts.IsCancellationRequested)
                {
                    return;
                }
                catch
                {
                    // Not up yet (TLS handshake fails while sealed) — keep waiting.
                }
                try { await Task.Delay(TimeSpan.FromSeconds(15), cts.Token); }
                catch (OperationCanceledException) { return; }
            }
        });
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
            var url = $"https://flagshipserver.com/api/order/{serial}/status";
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
