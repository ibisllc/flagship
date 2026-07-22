using System;
using System.Collections.ObjectModel;
using System.ComponentModel;
using System.IO;
using System.Linq;
using System.Runtime.CompilerServices;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Media;
using Flagship.Builder.VM;

namespace Flagship.Builder;

/// <summary>
/// Wizard view-model — owns user selections, runs the native build pipeline, exposes
/// observable state to MainWindow.xaml via INotifyPropertyChanged.
///
/// 1:1 with apps/builder-mac/Sources/FlagshipBuilder/WizardModel.swift and
/// apps/builder-linux/wizard.py's WizardModel. The Windows version
/// invokes the CLI's `write` subcommand directly (same as Linux), since
/// the app launches with `requireAdministrator`; we already have raw
/// disk privileges so there is no pkexec dance.
/// </summary>
public sealed class Wizard : INotifyPropertyChanged
{
    private string? _recipePath;
    private string? _isoPath;
    private DiskInfo? _selectedDisk;
    private bool _isRefreshingDisks;
    private bool _isRunning;
    private bool _isFinished;
    private string? _recipeError;
    private VerifyResult? _verified;
    private string? _outIsoPath;
    private readonly NativeBuildPipeline _nativeBuild = new();
    private BuilderMode _mode = BuilderMode.Simple;
    private bool _useSystemIso;
    private string _wifiSsid = string.Empty;
    private string _wifiPassword = string.Empty;
    private double? _progress;
    private string? _phase;
    private Recipe? _parsedRecipe;
    private bool _baseDownloadStarted;
    private string? _baseDownloadUrl;
    private System.Threading.CancellationTokenSource? _cts;
    private readonly IsoBaseCache _baseCache;

    /// <summary>
    /// Test seam: set inside RunBakeAsync only on the Advanced branch that
    /// actually runs the native remaster step. Lets model-level unit tests assert
    /// the flow chosen without stubbing the privileged write. Mirrors
    /// WizardModel.swift's didRemasterForTest.
    /// </summary>
    public bool DidRemasterForTest { get; private set; }

    public Wizard() : this(null) { }

    /// <param name="baseCache">Injectable for tests (stubbed HTTP + temp cache
    /// dir). Production passes null → the platform-default manifest-driven
    /// cache against flagshipserver.com.</param>
    public Wizard(IsoBaseCache? baseCache)
    {
        Disks = new ObservableCollection<DiskInfo>();
        LogLines = new ObservableCollection<LogLine>();
        _baseCache = baseCache ?? new IsoBaseCache(builderVersion: BuilderVersion);
        Vm = VMManager.CreateDefault();
        Vm.Log = m => AppendLog(LogStream.Stdout, m);
        Vm.Servers.CollectionChanged += (_, _) => FireBag();
        if (Vm.Toolchain is { } tc) _ = ProbeWhpxAsync(tc);
    }

    // ---- Phone pairing (the QR cover — how a recipe arrives without a file) ----

    private PairSession? _pair;
    private bool _isPairing;
    private string? _pairQr;
    private string? _pairCode;
    private string? _pairSas;
    private string? _pairStatus;
    private bool _pairDebug;
    private PairingStage _pairingStage = PairingStage.Qr;
    private bool _manualRecipeMode;

    /// <summary>True while the pairing relay session is live (cover is showing
    /// the QR + waiting for / talking to the phone).</summary>
    public bool IsPairing
    {
        get => _isPairing;
        private set { if (_isPairing != value) { _isPairing = value; FireBag(); } }
    }

    /// <summary>The scannable unicode-block QR (rendered in a monospace block).</summary>
    public string? PairQr
    {
        get => _pairQr;
        private set { if (_pairQr != value) { _pairQr = value; FireBag(); } }
    }

    /// <summary>The 8-char human code to type if the QR can't be scanned.</summary>
    public string? PairCode
    {
        get => _pairCode;
        private set { if (_pairCode != value) { _pairCode = value; FireBag(); } }
    }

    /// <summary>The 6-digit SAS to compare against the phone once it connects.</summary>
    public string? PairSas
    {
        get => _pairSas;
        private set { if (_pairSas != value) { _pairSas = value; FireBag(); } }
    }

    public string? PairStatus
    {
        get => _pairStatus;
        private set { if (_pairStatus != value) { _pairStatus = value; FireBag(); } }
    }

    /// <summary>Advanced: request an owner-signed debug-access grant during pairing.</summary>
    public bool PairDebug
    {
        get => _pairDebug;
        set { if (_pairDebug != value) { _pairDebug = value; FireBag(); } }
    }

    public bool HasPairSas => !string.IsNullOrEmpty(_pairSas);
    public PairingStage PairingStage { get => _pairingStage; private set { if (_pairingStage != value) { _pairingStage = value; FireBag(); } } }
    public bool ManualRecipeMode { get => _manualRecipeMode; private set { if (_manualRecipeMode != value) { _manualRecipeMode = value; FireBag(); } } }
    public bool ShowPairingQr => ShowPairingCover && PairingStage == PairingStage.Qr;
    public bool ShowPairingConfirm => ShowPairingCover && PairingStage == PairingStage.Confirm;
    public bool ShowAwaitingAuthorization => ShowPairingCover && PairingStage == PairingStage.AwaitingAuthorization;
    public bool AdvancedAllowed => !ManualRecipeMode && Verified != null && Destination == ServerDestination.BurnToUSB;

    /// <summary>
    /// Start pairing: spawn `flagship-build pair --emit-events`, surface the QR /
    /// code / SAS / status, and on delivery load the received recipe (identical
    /// to a dropped-in recipe file) → the destination chooser.
    /// </summary>
    public void StartPairing()
    {
        if (IsPairing) return;
        SelectedServerName = null;
        Destination = null;
        RecipeError = null;
        Verified = null;
        _parsedRecipe = null;
        IsFinished = false;
        PairQr = null;
        PairCode = null;
        PairSas = null;
        PairStatus = "Starting…";
        PairingStage = PairingStage.Qr;
        ManualRecipeMode = false;
        IsPairing = true;

        var session = new PairSession(debug: false);
        _pair = session;
        // Match macOS: publish the locally generated QR before network work starts.
        PairQr = session.QrPayload;
        PairCode = session.HumanCodeDisplay;
        PairStatus = "Waiting for your phone…";
        session.OnEvent += ev => OnUi(() => HandlePairEvent(ev));
        session.OnLog += line => OnUi(() => AppendLog(line.Stream, line.Text));
        _ = Task.Run(async () =>
        {
            try { await session.RunAsync(); }
            catch (Exception e) { OnUi(() => { AppendLog(LogStream.Stderr, $"pair failed: {e.Message}"); EndPairing("Pairing couldn't start — check your network connection."); }); }
        });
    }

    public void CancelPairing()
    {
        _pair?.Cancel();
        EndPairing(null);
    }

    private void EndPairing(string? status)
    {
        _pair = null;
        IsPairing = false;
        if (status != null) PairStatus = status;
        PairQr = null;
        PairSas = null;
        FireBag();
    }

    private void HandlePairEvent(PairEvent ev)
    {
        switch (ev.Event)
        {
            case "ready":
                PairingStage = PairingStage.Qr;
                PairQr = ev.Payload;
                PairCode = ev.HumanCode;
                PairStatus = "Scan the QR with the Flagship app, or type the code.";
                break;
            case "phone-connected":
                PairingStage = PairingStage.Confirm;
                PairSas = ev.Sas;
                PairStatus = "Phone connected — check the security code matches, then approve on your phone.";
                break;
            case "paired":
                PairingStage = PairingStage.AwaitingAuthorization;
                PairStatus = "Paired. Waiting for your phone to send the approved recipe…";
                break;
            case "reconnecting":
                PairingStage = PairingStage.AwaitingAuthorization;
                PairStatus = "Your phone disconnected before sending the recipe. Reopen it to retry, or cancel pairing.";
                break;
            case "delivered":
                PairStatus = $"Recipe received for {ev.ServerDomain}.";
                break;
            case "debug-result":
                AppendLog(LogStream.Stdout, ev.DebugGranted
                    ? "debug access granted (owner-signed)"
                    : "debug access not granted — production image");
                break;
            case "done":
                IsPairing = false;
                _pair = null;
                PairSas = null;
                PairStatus = null;
                if (ev.RecipePath is string p && File.Exists(p))
                {
                    // Identical to a dropped-in recipe file: verify locally +
                    // go to the destination chooser.
                    AcceptRecipeFile(p);
                }
                FireBag();
                break;
            case "error":
                EndPairing(ev.Message ?? "Pairing failed.");
                break;
        }
    }

    // ---- Hosted VMs (the "Host here" destination) ----

    /// <summary>Runtime orchestrator for hosted VMs (sidebar + detail).</summary>
    public VMManager Vm { get; }

    private WhpxVerdict? _whpx;
    private ServerDestination? _destination;
    private string? _selectedServerName;
    private int? _handoffCountdown;

    private async Task ProbeWhpxAsync(QemuToolchain toolchain)
    {
        try { _whpx = await WhpxProbe.RunAsync(toolchain); }
        catch (Exception e) { _whpx = new WhpxVerdict(WhpxVerdictKind.Unknown, e.Message); }
        OnUi(() => FireBag());
    }

    /// <summary>Where the verified recipe should live. Null until the user
    /// picks on the destination chooser.</summary>
    public ServerDestination? Destination
    {
        get => _destination;
        set { if (_destination != value) { _destination = value; FireBag(); } }
    }

    /// <summary>Sidebar selection: the hosted server whose detail fills the
    /// main area. Null shows the wizard/chooser.</summary>
    public string? SelectedServerName
    {
        get => _selectedServerName;
        set { if (_selectedServerName != value) { _selectedServerName = value; FireBag(); } }
    }

    public HostedServer? SelectedServer
        => _selectedServerName is null ? null : Vm.Server(_selectedServerName);

    // Main-area pane switching (exactly one is visible). Priority: a selected
    // server's detail, else the live pairing cover, else the recipe→destination
    // flow.
    public bool ShowServerDetail => SelectedServer != null;
    public bool ShowPairingCover => !ShowServerDetail && IsPairing;
    public bool ShowDestinationChooser
        => !ShowServerDetail && !IsPairing && Verified != null && _destination == null && !IsRunning && !IsFinished;
    public bool ShowHostHerePane => !ShowServerDetail && !IsPairing && _destination == ServerDestination.HostHere;
    public bool ShowWizardPanes => !ShowServerDetail && !IsPairing && !ShowDestinationChooser && !ShowHostHerePane && (ManualRecipeMode || _destination == ServerDestination.BurnToUSB);
    public void EnterRecipeFileMode()
    {
        if (IsPairing) CancelPairing();
        ManualRecipeMode = true;
        Mode = BuilderMode.Simple;
        Destination = ServerDestination.BurnToUSB;
        PairStatus = null;
        FireBag();
    }

    public void ReturnToPairingCover()
    {
        ResetToNewServer();
        StartPairing();
    }
    /// <summary>The back-to-chooser link inside the USB pane.</summary>
    public bool ShowDestinationBackLink
        => ShowWizardPanes && Verified != null && _destination == ServerDestination.BurnToUSB && !IsRunning;

    public bool HasHostedServers => Vm.Servers.Count > 0;
    public int? HandoffCountdown
    {
        get => _handoffCountdown;
        private set { if (_handoffCountdown != value) { _handoffCountdown = value; FireBag(); } }
    }

    /// <summary>Why "Host on this PC" is unavailable — null means it's usable.
    /// Honest, actionable reasons only (capacity / WHPX / toolchain).</summary>
    public string? HostHereDisabledReason
    {
        get
        {
            if (Vm.ToolchainError != null) return Vm.ToolchainError;
            if (_whpx is { IsAvailable: false } v) return v.Message;
            var cap = Vm.MaxVMCount;
            if (cap == 0)
                return $"This PC doesn't have enough free memory to host a server (each server needs ~{VMResourcePlan.MinimumVMMemoryBytes / VMResourcePlan.GiB} GiB).";
            if (Vm.Servers.Count >= cap)
                return $"This PC is at its hosting limit ({cap}). Remove one first, or burn to USB.";
            return null;
        }
    }

    public bool HostHereEnabled => HostHereDisabledReason == null;
    public string HardwareBadgeLabel => ServerTier.Hardware.BadgeLabel();
    public string HostedVmBadgeLabel => ServerTier.HostedVM.BadgeLabel();

    public string HostHereSpecSummary
    {
        get
        {
            var host = VM.HostResources.Current();
            return $"Will run as a managed VM on this PC — {VMResourcePlan.VmCpuCount(host)} vCPU, " +
                   $"{VMResourcePlan.VmMemoryBytes(host) / VMResourcePlan.GiB} GiB RAM, " +
                   $"{VMResourcePlan.DefaultMainDiskSizeBytes / VMResourcePlan.GiB} GiB disk.";
        }
    }

    /// <summary>The "＋ Add a server" sidebar entry: back to a fresh wizard.</summary>
    public void ResetToNewServer()
    {
        if (IsPairing) CancelPairing();
        SelectedServerName = null;
        Destination = null;
        RecipePath = null;
        Verified = null;
        _parsedRecipe = null;
        RecipeError = null;
        IsFinished = false;
        ManualRecipeMode = false;
        UseSystemIso = false;
        FireBag();
    }

    /// <summary>
    /// "Host here": the SAME recipe → the SAME remastered installer ISO
    /// (through the native installer pipeline), but applied to a managed VM on this PC
    /// instead of a USB stick. The guest boot chain (unattended install →
    /// LUKS → phone-home unlock → register) runs unmodified inside the VM;
    /// this app never holds a key. Mirrors WizardModel.runHostHere.
    /// </summary>
    public async Task RunHostHereAsync()
    {
        if (IsRunning || _recipePath is null || _parsedRecipe is null) return;
        if (HostHereDisabledReason is string reason)
        {
            AppendLog(LogStream.Stderr, reason);
            return;
        }

        byte[] rawRecipe;
        try { rawRecipe = File.ReadAllBytes(_recipePath); }
        catch (Exception e)
        {
            AppendLog(LogStream.Stderr, $"Cannot read the recipe: {e.Message}");
            return;
        }
        var config = VMConfig.Plan(
            _parsedRecipe, rawRecipe, VM.HostResources.Current(),
            provisioningMode: VMProvisioningMode.InstallerISO);

        IsRunning = true;
        Phase = "download";
        Progress = null;
        BaseDownloadStarted = false;
        BaseDownloadUrl = null;
        _cts = new System.Threading.CancellationTokenSource();
        FireBag();
        try
        {
            // Same Simple-mode base ISO fetch as the USB path; Advanced mode
            // may bring its own stock ISO.
            string baseIso;
            if (Mode == BuilderMode.Advanced && HasIso)
            {
                baseIso = _isoPath!;
            }
            else
            {
                try
                {
                    var ensured = await _baseCache.EnsureAsync(
                        progress: p => SetProgress(p),
                        onDownloadStart: phase => OnUi(() =>
                        {
                            BaseDownloadStarted = true;
                            BaseDownloadUrl = phase.Url;
                        }),
                        log: m => OnUi(() => AppendLog(LogStream.Stdout, "+ " + m)),
                        cancellation: _cts.Token);
                    baseIso = ensured.Path;
                }
                catch (Exception e)
                {
                    AppendLog(LogStream.Stderr, (e as IsoBaseCache.CacheException)?.Message ?? e.Message);
                    return;
                }
            }

            // Create the bundle, then remaster the installer INTO it —
            // identical remaster to the USB path (same engine, same recipe).
            Phase = "remaster";
            Progress = null;
            BaseDownloadStarted = false;
            BaseDownloadUrl = null;
            FireBag();
            try { Vm.CreateServer(config); }
            catch (VMStoreException e)
            {
                AppendLog(LogStream.Stderr, e.Message);
                return;
            }
            DidRemasterForTest = true;
            var recipe = _recipePath!;
            var outIso = Vm.InstallerIsoPath(config.Name);
            var remastered = false;
            try { await _nativeBuild.PrepareAsync(recipe, baseIso, outIso, WifiSsid, WifiPassword, _cts.Token); remastered = true; }
            catch (Exception e) { AppendLog(LogStream.Stderr, e.Message); }
            if (!remastered)
            {
                await Vm.DeleteServerAsync(config.Name);
                return;
            }

            // Shred the single-use recipe, exactly like a successful USB burn.
            try { File.Delete(recipe); } catch { }
            await Vm.BeginInstallAsync(config.Name);
            Phase = "handoff";
            for (var remaining = 5; remaining > 0; remaining--)
            {
                HandoffCountdown = remaining;
                await Task.Delay(1000);
            }
            HandoffCountdown = null;
            SelectedServerName = null;
            Destination = null;
            RecipePath = null;
            Verified = null;
            _parsedRecipe = null;
        }
        finally
        {
            IsRunning = false;
            Phase = null;
            Progress = null;
            BaseDownloadStarted = false;
            BaseDownloadUrl = null;
            _cts?.Dispose();
            _cts = null;
            FireBag();
        }
    }

    /// <summary>Reported to the manifest endpoint. Mirrors FlagshipBuilder.csproj &lt;Version&gt;.</summary>
    public const string BuilderVersion = "0.0.1";

    public event PropertyChangedEventHandler? PropertyChanged;

    public ObservableCollection<DiskInfo> Disks { get; }
    public ObservableCollection<LogLine> LogLines { get; }

    // ---- raw state ----

    public string? RecipePath
    {
        get => _recipePath;
        private set { if (_recipePath != value) { _recipePath = value; FireBag(); } }
    }

    public string? IsoPath
    {
        get => _isoPath;
        private set { if (_isoPath != value) { _isoPath = value; FireBag(); } }
    }

    public DiskInfo? SelectedDisk
    {
        get => _selectedDisk;
        set { if (_selectedDisk != value) { _selectedDisk = value; FireBag(); } }
    }

    public bool IsRefreshingDisks
    {
        get => _isRefreshingDisks;
        private set { if (_isRefreshingDisks != value) { _isRefreshingDisks = value; FireBag(); } }
    }

    public bool IsRunning
    {
        get => _isRunning;
        private set { if (_isRunning != value) { _isRunning = value; FireBag(); } }
    }

    public bool IsFinished
    {
        get => _isFinished;
        private set { if (_isFinished != value) { _isFinished = value; FireBag(); } }
    }

    public string? RecipeError
    {
        get => _recipeError;
        private set { if (_recipeError != value) { _recipeError = value; FireBag(); } }
    }

    public VerifyResult? Verified
    {
        get => _verified;
        private set { if (!Equals(_verified, value)) { _verified = value; FireBag(); } }
    }

    /// <summary>
    /// Simple (default) = fetch the server-manifest Debian-netinst base, then run
    /// the SAME remaster+flash path Advanced uses. Advanced = remaster a stock
    /// user-supplied Debian/Ubuntu ISO through the native installer pipeline.
    /// </summary>
    public bool UseSystemIso { get => _useSystemIso; set { if (_useSystemIso != value) { _useSystemIso = value; FireBag(); } } }
    public string WifiSsid { get => _wifiSsid; set { if (_wifiSsid != value) { _wifiSsid = value; FireBag(); } } }
    public string WifiPassword { get => _wifiPassword; set { if (_wifiPassword != value) { _wifiPassword = value; FireBag(); } } }
    public bool IsSimpleMode => Mode == BuilderMode.Simple;
    public bool IsAdvancedMode => Mode == BuilderMode.Advanced;
    public BuilderMode Mode
    {
        get => _mode;
        set { if (_mode != value) { _mode = value; FireBag(); } }
    }

    /// <summary>
    /// True once a base-image download begins this run — drives the download
    /// row's visibility (the URL appears under the progress bar).
    /// </summary>
    public bool BaseDownloadStarted
    {
        get => _baseDownloadStarted;
        private set { if (_baseDownloadStarted != value) { _baseDownloadStarted = value; FireBag(); } }
    }

    /// <summary>The base-image URL currently being fetched (shown under the bar). Null when idle.</summary>
    public string? BaseDownloadUrl
    {
        get => _baseDownloadUrl;
        private set { if (_baseDownloadUrl != value) { _baseDownloadUrl = value; FireBag(); } }
    }

    /// <summary>0…1 during the byte-write / download; null means indeterminate (or idle).</summary>
    public double? Progress
    {
        get => _progress;
        private set { if (_progress != value) { _progress = value; FireBag(); } }
    }

    /// <summary>Raw phase token: "download" | "remaster" | "write".</summary>
    public string? Phase
    {
        get => _phase;
        private set { if (_phase != value) { _phase = value; FireBag(); } }
    }

    // ---- derived (one big bag for simplicity; WPF only reads these
    //      on PropertyChanged anyway) ----

    public bool HasRecipe => !string.IsNullOrEmpty(_recipePath);
    public bool HasIso => !string.IsNullOrEmpty(_isoPath);
    public bool HasDisks => Disks.Count > 0;
    public bool HasLogLines => LogLines.Count > 0;
    public string LogCountLabel => LogLines.Count == 0 ? "" : $"  {LogLines.Count}";

    public bool CanBake =>
        HasRecipe
        && (!EffectiveRequiresUserIso || HasIso)
        && SelectedDisk != null && !IsRunning && !IsFinished;

    public bool ShowReadiness => !IsFinished && !IsRunning;

    public string ReadinessSummary
    {
        get
        {
            var missing = new System.Collections.Generic.List<string>();
            if (!HasRecipe) missing.Add("recipe");
            if (EffectiveRequiresUserIso && !HasIso) missing.Add("ISO");
            if (SelectedDisk == null) missing.Add("USB drive");
            if (missing.Count == 0)
            {
                if (IsRunning) return "Working...";
                var dev = SelectedDisk?.DevicePath ?? "—";
                return $"Writes to {dev} · erases what's there";
            }
            return $"Need: {string.Join(", ", missing)}.";
        }
    }

    public string BakeButtonLabel => IsRunning ? "Working — click to cancel" : Mode.BakeCtaLabel();

    // ---- flow visibility ----

    /// <summary>The ISO row shows only in Advanced mode (Simple fetches the base
    /// from the server manifest, so it hides the user-ISO row).</summary>
    public bool ShowIsoRow => Mode.RequiresUserISO();
    public bool IsoPickerEnabled => ShowIsoRow && !UseSystemIso;
    private bool EffectiveRequiresUserIso => Mode.RequiresUserISO() && !UseSystemIso;

    // ---- progress ----

    /// <summary>Show the linear progress block (vs. the Bake button / done card).</summary>
    public bool ShowProgress => IsRunning;
    public bool ProgressIndeterminate => Progress == null;
    public double ProgressValue => Progress ?? 0.0;

    /// <summary>Human label for the current phase, mirroring WizardModel.phaseLabel.</summary>
    public string? PhaseLabel => Phase switch
    {
        "download" => "Downloading base image…",
        "clone appliance" => "Cloning prebuilt server…",
        "specialize" => "Securing this server…",
        "remaster" => "Building image…",
        "write" => "Writing to USB…",
        "handoff" => HandoffCountdown is int n
            ? $"Server handed off · returning home in {n}…"
            : "Preparing a new server…",
        _ => null,
    };

    public string ProgressCaption
    {
        get
        {
            var label = PhaseLabel ?? "Working…";
            if (Progress is double p) return $"{label}  {(int)Math.Round(p * 100)}%";
            return label;
        }
    }

    /// <summary>
    /// The download phase paints the warning (orange) tint to signal a one-time
    /// network fetch; the rest of the pipeline uses the accent (primary) color.
    /// </summary>
    public Brush ProgressTint => Phase == "download"
        ? FindBrush("FB.Warning")
        : FindBrush("FB.Primary");

    /// <summary>
    /// Show the download-URL row under the bar — only while a base download is
    /// actually running. The URL itself comes from BaseDownloadUrl.
    /// </summary>
    public bool ShowDownloadRow => Phase == "download" && BaseDownloadStarted && _baseDownloadUrl != null;

    /// <summary>The "from &lt;url&gt;" line shown under the progress bar during download.</summary>
    public string? DownloadUrlCaption => _baseDownloadUrl is string u ? $"from {u}" : null;

    // Recipe row
    public bool HasRecipePrimary => Verified != null || RecipeError != null || HasRecipe;
    public string? RecipePrimary
    {
        get
        {
            if (RecipeError != null) return RecipeError;
            if (Verified != null) return Verified.ServerDomain;
            if (HasRecipe) return Path.GetFileName(_recipePath);
            return null;
        }
    }
    public string? RecipeSecondary => Verified?.ExpiresAt is string s ? $"Expires {s}" : null;
    public string RecipeHint => "Drop a .json file (from the Download Recipe button)";
    public string RecipeStatusGlyph
    {
        get
        {
            if (RecipeError != null) return "⚠"; // warning
            if (Verified != null) return "✓"; // check
            return "";
        }
    }
    public Brush RecipeStatusBrush => RecipeError != null
        ? FindBrush("FB.Danger")
        : FindBrush("FB.Success");
    public Brush RecipeIconBg => Verified != null
        ? FindBrush("FB.SuccessFaded")
        : FindBrush("FB.SurfaceElevated");
    public string RecipeRowTag
    {
        get
        {
            if (RecipeError != null) return "error";
            if (Verified != null) return "ready";
            return "";
        }
    }

    // ISO row
    public string? IsoFileName => HasIso ? Path.GetFileName(_isoPath) : null;
    public string IsoStatusGlyph => HasIso ? "✓" : "";
    public Brush IsoStatusBrush => FindBrush("FB.Success");
    public Brush IsoIconBg => HasIso ? FindBrush("FB.SuccessFaded") : FindBrush("FB.SurfaceElevated");
    public string IsoRowTag => HasIso ? "ready" : "";

    // Disk row
    public string DiskStatusGlyph => SelectedDisk != null ? "✓" : "";
    public Brush DiskStatusBrush => FindBrush("FB.Success");
    public Brush DiskIconBg => SelectedDisk != null ? FindBrush("FB.WarningFaded") : FindBrush("FB.SurfaceElevated");
    public string DiskRowTag => SelectedDisk != null ? "ready" : "";

    // Done card
    public string? DoneServerDomain => Verified?.ServerDomain;
    public string? DoneOutputPath => _outIsoPath;

    // ---- mutation API (called from MainWindow) ----

    public void AcceptRecipeText(string json)
    {
        if (string.IsNullOrWhiteSpace(json)) { RecipeError = "Clipboard does not contain a recipe."; return; }
        var path = Path.Combine(Path.GetTempPath(), $"flagship-recipe-{Guid.NewGuid():N}.json");
        File.WriteAllText(path, json);
        AcceptRecipeFile(path);
    }
    public void AcceptRecipeFile(string path)
    {
        RecipeError = null;
        Verified = null;
        _parsedRecipe = null;
        RecipePath = path;
        // Verify LOCALLY (parse + Ed25519) for immediate feedback before the
        // native remaster runs. Mirrors WizardModel.runVerify().
        _ = RunVerifyAsync();
    }

    public void AcceptIsoFile(string path)
    {
        IsoPath = path;
    }

    public async Task RefreshDisksAsync()
    {
        if (IsRefreshingDisks) return;
        IsRefreshingDisks = true;
        try
        {
            var fresh = await Task.Run(() =>
            {
                try { return DiskEnumerator.Enumerate(); }
                catch (Exception) { return Array.Empty<DiskInfo>(); }
            });
            // Mutate ObservableCollection from the UI thread.
            await Application.Current.Dispatcher.InvokeAsync(() =>
            {
                var prevPath = SelectedDisk?.DevicePath;
                Disks.Clear();
                foreach (var d in fresh) Disks.Add(d);
                if (prevPath != null)
                {
                    var match = Disks.FirstOrDefault(d => d.DevicePath == prevPath);
                    SelectedDisk = match;
                }
                FireBag();
            });
        }
        finally
        {
            IsRefreshingDisks = false;
        }
    }

    public void ClearLog()
    {
        LogLines.Clear();
        FireBag();
    }

    public void Cancel()
    {
        _cts?.Cancel();

    }

    /// <summary>
    /// Parse + verify the recipe locally before generation. Sets Verified (surfaced in
    /// the recipe row) + caches the parsed Recipe.
    /// </summary>
    public async Task RunVerifyAsync()
    {
        if (string.IsNullOrEmpty(_recipePath)) return;
        var path = _recipePath!;
        var result = await Task.Run<(Recipe? recipe, string? error)>(() =>
        {
            try { return (RecipeLoader.Load(path), null); }
            catch (RecipeException e) { return (null, e.Message); }
            catch (Exception e) { return (null, e.Message); }
        });
        if (result.recipe is Recipe r)
        {
            _parsedRecipe = r;
            Verified = new VerifyResult
            {
                Ok = true,
                ServerDomain = r.ServerDomain,
                Username = r.Username,
                ServerName = r.ServerName,
                ExpiresAt = r.ExpiresAtDate.ToString("yyyy-MM-ddTHH:mm:ss.fffZ", System.Globalization.CultureInfo.InvariantCulture),
                InstallerGitRef = r.InstallerGitRef,
                SignatureValid = true,
            };
            RecipeError = null;
        }
        else
        {
            _parsedRecipe = null;
            Verified = null;
            RecipeError = result.error;
        }
    }

    /// <summary>
    /// One-click "Bake".
    ///
    /// Simple mode (default): fetch the server-manifest Debian-netinst base ISO
    /// (cached + sha256-verified), then remaster THAT base with the recipe via
    /// the Node CLI's `write` subcommand — the SAME remaster+flash path Advanced
    /// uses, just with a server-supplied base instead of a user-supplied ISO.
    ///
    /// Advanced mode: remaster the user's own stock Ubuntu/Debian ISO.
    /// </summary>
    public async Task RunBakeAsync()
    {
        if (!CanBake) return;
        if (Mode == BuilderMode.Simple || UseSystemIso)
        {
            await RunSimpleBakeAsync();
            return;
        }
        var recipe = _recipePath!;
        var iso = _isoPath!;
        var disk = SelectedDisk!;
        DidRemasterForTest = true; Phase = "remaster"; IsRunning = true; _cts = new CancellationTokenSource();
        try { await _nativeBuild.WriteAsync(recipe, iso, disk.DevicePath, WifiSsid, WifiPassword, SetProgress, _cts.Token); IsFinished = true; }
        catch (OperationCanceledException) { AppendLog(LogStream.Stderr, "Cancelled."); }
        catch (Exception e) { AppendLog(LogStream.Stderr, e.Message); }
        finally { IsRunning = false; Phase = null; Progress = null; _cts.Dispose(); _cts = null; FireBag(); }
    }

    /// <summary>
    /// Simple pipeline: ensure the base ISO via the server manifest (download
    /// phase surfaces the URL + byte progress), then hand the cached base to the
    /// SAME CLI `write` remaster+flash path Advanced runs. The builder is a dumb
    /// executor — it reports the cached sha, obeys the manifest, verifies bytes.
    /// </summary>
    private async Task RunSimpleBakeAsync()
    {
        if (IsRunning) return;
        var disk = SelectedDisk!;
        BaseDownloadStarted = false;
        BaseDownloadUrl = null;
        Progress = null;
        _cts = new System.Threading.CancellationTokenSource();

        // 1. Ensure the base ISO per the server manifest.
        Phase = "download";
        IsRunning = true;
        FireBag();

        string baseIso;
        try
        {
            var ensured = await _baseCache.EnsureAsync(
                progress: p => SetProgress(p),
                onDownloadStart: phase => OnUi(() =>
                {
                    BaseDownloadStarted = true;
                    BaseDownloadUrl = phase.Url;
                }),
                log: m => OnUi(() => AppendLog(LogStream.Stdout, "+ " + m)),
                cancellation: _cts.Token);
            baseIso = ensured.Path;
        }
        catch (Exception e)
        {
            AppendLog(LogStream.Stderr, (e as IsoBaseCache.CacheException)?.Message ?? e.Message);
            FinishSimple();
            return;
        }

        // 2. Remaster + flash via the same native pipeline Advanced uses.
        DidRemasterForTest = true;
        Phase = "remaster";
        Progress = null;
        FireBag();
        var recipe = _recipePath!;
        try { await _nativeBuild.WriteAsync(recipe, baseIso, disk.DevicePath, WifiSsid, WifiPassword, SetProgress, _cts.Token); IsFinished = true; }
        catch (OperationCanceledException) { AppendLog(LogStream.Stderr, "Cancelled."); }
        catch (Exception e) { AppendLog(LogStream.Stderr, e.Message); }
        FinishSimple();
    }

    private void FinishSimple()
    {
        IsRunning = false;
        Phase = null;
        Progress = null;
        BaseDownloadStarted = false;
        BaseDownloadUrl = null;
        _cts?.Dispose();
        _cts = null;
        FireBag();
    }

    private void SetProgress(double p) => OnUi(() => Progress = Math.Clamp(p, 0.0, 1.0));

    private static void OnUi(Action action)
    {
        if (Application.Current?.Dispatcher.CheckAccess() ?? true) action();
        else Application.Current.Dispatcher.Invoke(action);
    }

    public async Task RunPrepareAsync()
    {
        if (string.IsNullOrEmpty(_recipePath) || string.IsNullOrEmpty(_isoPath)) return;
        var recipe = _recipePath!;
        var iso = _isoPath!;
        var dir = Path.GetDirectoryName(iso) ?? Environment.CurrentDirectory;
        var stem = Path.GetFileNameWithoutExtension(iso);
        var outIso = Path.Combine(dir, stem + ".flagship.iso");
        _outIsoPath = outIso;
        FireBag();
        if (IsRunning) return; IsRunning = true; _cts = new CancellationTokenSource();
        try { await _nativeBuild.PrepareAsync(recipe, iso, outIso, WifiSsid, WifiPassword, _cts.Token); IsFinished = true; }
        catch (OperationCanceledException) { AppendLog(LogStream.Stderr, "Cancelled."); }
        catch (Exception e) { AppendLog(LogStream.Stderr, e.Message); }
        finally { IsRunning = false; _cts.Dispose(); _cts = null; FireBag(); }
    }

    private void AppendLog(LogStream stream, string text)
    {
        // Trim trailing CR that often arrives alongside LF.
        if (text.EndsWith("\r")) text = text[..^1];
        // ObservableCollection mutations + PropertyChanged must come
        // from the UI thread. WPF marshals automatic dispatcher
        // affinity for the *collection* but PropertyChanged subscribers
        // we don't control, so dispatch both together.
        void Mutate()
        {
            LogLines.Add(new LogLine(stream, text));
            FireBag();
        }
        if (Application.Current?.Dispatcher.CheckAccess() ?? true)
        {
            Mutate();
        }
        else
        {
            Application.Current.Dispatcher.Invoke(Mutate);
        }
    }

    // Fire PropertyChanged on every binding source we expose. WPF doesn't
    // re-evaluate derived properties unless we tell it to, and the
    // Wizard's state is small enough that a fire-everything strategy is
    // both simpler and faster than tracking individual deltas.
    private void FireBag([CallerMemberName] string? caller = null)
    {
        var handler = PropertyChanged;
        if (handler == null) return;
        foreach (var name in PropertyBag)
        {
            handler(this, new PropertyChangedEventArgs(name));
        }
    }

    private static readonly string[] PropertyBag = new[]
    {
        nameof(RecipePath), nameof(IsoPath), nameof(SelectedDisk),
        nameof(IsRefreshingDisks), nameof(IsRunning), nameof(IsFinished),
        nameof(RecipeError), nameof(Verified),
        nameof(HasRecipe), nameof(HasIso), nameof(HasDisks),
        nameof(HasLogLines), nameof(LogCountLabel),
        nameof(CanBake), nameof(ShowReadiness), nameof(ReadinessSummary),
        nameof(BakeButtonLabel),
        nameof(HasRecipePrimary), nameof(RecipePrimary), nameof(RecipeSecondary),
        nameof(RecipeHint), nameof(RecipeStatusGlyph), nameof(RecipeStatusBrush),
        nameof(RecipeIconBg), nameof(RecipeRowTag),
        nameof(IsoFileName), nameof(IsoStatusGlyph), nameof(IsoStatusBrush),
        nameof(IsoIconBg), nameof(IsoRowTag),
        nameof(DiskStatusGlyph), nameof(DiskStatusBrush), nameof(DiskIconBg),
        nameof(DiskRowTag),
        nameof(DoneServerDomain), nameof(DoneOutputPath),
        nameof(Mode), nameof(IsSimpleMode), nameof(IsAdvancedMode), nameof(UseSystemIso), nameof(IsoPickerEnabled), nameof(WifiSsid), nameof(WifiPassword),
        nameof(Progress), nameof(Phase),
        nameof(BaseDownloadStarted), nameof(BaseDownloadUrl),
        nameof(ShowIsoRow),
        nameof(ShowProgress), nameof(ProgressIndeterminate), nameof(ProgressValue),
        nameof(PhaseLabel), nameof(ProgressCaption), nameof(ProgressTint),
        nameof(ShowDownloadRow), nameof(DownloadUrlCaption),
        nameof(Destination), nameof(SelectedServerName), nameof(SelectedServer),
        nameof(HandoffCountdown),
        nameof(ShowServerDetail), nameof(ShowDestinationChooser),
        nameof(ShowHostHerePane), nameof(ShowWizardPanes), nameof(ShowDestinationBackLink),
        nameof(IsPairing), nameof(ShowPairingCover), nameof(PairQr), nameof(PairCode),
        nameof(PairSas), nameof(PairStatus), nameof(PairDebug), nameof(HasPairSas),
        nameof(PairingStage), nameof(ManualRecipeMode), nameof(ShowPairingQr),
        nameof(ShowPairingConfirm), nameof(ShowAwaitingAuthorization), nameof(AdvancedAllowed),
        nameof(HasHostedServers), nameof(HostHereDisabledReason), nameof(HostHereEnabled),
        nameof(HostHereSpecSummary), nameof(HardwareBadgeLabel), nameof(HostedVmBadgeLabel),
    };

    private static Brush FindBrush(string key)
    {
        if (Application.Current != null)
        {
            var b = Application.Current.TryFindResource(key) as Brush;
            if (b != null) return b;
        }
        return Brushes.Transparent;
    }
}
