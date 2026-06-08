using System;
using System.Collections.ObjectModel;
using System.ComponentModel;
using System.IO;
using System.Linq;
using System.Runtime.CompilerServices;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Media;

namespace Flagship.Burner;

/// <summary>
/// Wizard view-model — owns user selections, fires the CLI, exposes
/// observable state to MainWindow.xaml via INotifyPropertyChanged.
///
/// 1:1 with apps/burner-mac/Sources/FlagshipBurner/WizardModel.swift and
/// apps/burner-linux/wizard.py's WizardModel. The Windows version
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
    private CliRunner? _currentRunner;
    private BurnerMode _mode = BurnerMode.Simple;
    private double? _progress;
    private string? _phase;
    private Recipe? _parsedRecipe;
    private bool _baseDownloadStarted;
    private string? _baseDownloadUrl;
    private System.Threading.CancellationTokenSource? _cts;
    private readonly IsoBaseCache _baseCache;

    /// <summary>
    /// Test seam: set inside RunBakeAsync only on the Advanced branch that
    /// actually runs the CLI remaster step. Lets model-level unit tests assert
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
        _baseCache = baseCache ?? new IsoBaseCache(burnerVersion: BurnerVersion);
    }

    /// <summary>Reported to the manifest endpoint. Mirrors FlagshipBurner.csproj &lt;Version&gt;.</summary>
    public const string BurnerVersion = "0.0.1";

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
    /// user-supplied Debian/Ubuntu ISO via the Node CLI.
    /// </summary>
    public BurnerMode Mode
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
        && (!Mode.RequiresUserISO() || HasIso)
        && SelectedDisk != null && !IsRunning && !IsFinished;

    public bool ShowReadiness => !IsFinished && !IsRunning;

    public string ReadinessSummary
    {
        get
        {
            var missing = new System.Collections.Generic.List<string>();
            if (!HasRecipe) missing.Add("recipe");
            if (Mode.RequiresUserISO() && !HasIso) missing.Add("ISO");
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

    // ---- progress ----

    /// <summary>Show the linear progress block (vs. the Bake button / done card).</summary>
    public bool ShowProgress => IsRunning;
    public bool ProgressIndeterminate => Progress == null;
    public double ProgressValue => Progress ?? 0.0;

    /// <summary>Human label for the current phase, mirroring WizardModel.phaseLabel.</summary>
    public string? PhaseLabel => Phase switch
    {
        "download" => "Downloading base image…",
        "remaster" => "Building image…",
        "write" => "Writing to USB…",
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

    public void AcceptRecipeFile(string path)
    {
        RecipeError = null;
        Verified = null;
        _parsedRecipe = null;
        RecipePath = path;
        // Verify LOCALLY (parse + Ed25519) for immediate feedback before the
        // CLI remaster runs. Mirrors WizardModel.runVerify().
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
        _currentRunner?.Cancel();
    }

    /// <summary>
    /// Parse + verify the recipe locally (no CLI). Sets Verified (surfaced in
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
        if (Mode == BurnerMode.Simple)
        {
            await RunSimpleBakeAsync();
            return;
        }
        var recipe = _recipePath!;
        var iso = _isoPath!;
        var disk = SelectedDisk!;
        DidRemasterForTest = true;
        Phase = "remaster";
        await RunCliAsync(
            entry => CliArgs.Write(entry, recipe, iso, device: disk.DevicePath, yes: true, keepRecipe: false),
            onSuccess: _ => { IsFinished = true; });
        Phase = null;
    }

    /// <summary>
    /// Simple pipeline: ensure the base ISO via the server manifest (download
    /// phase surfaces the URL + byte progress), then hand the cached base to the
    /// SAME CLI `write` remaster+flash path Advanced runs. The burner is a dumb
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

        // 2. Remaster + flash via the SAME CLI path Advanced uses.
        DidRemasterForTest = true;
        Phase = "remaster";
        Progress = null;
        FireBag();
        var recipe = _recipePath!;
        await RunCliCoreAsync(
            entry => CliArgs.Write(entry, recipe, baseIso, device: disk.DevicePath, yes: true, keepRecipe: false),
            onSuccess: _ => { IsFinished = true; });
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
        await RunCliAsync(
            entry => CliArgs.Prepare(entry, recipe, iso, outIso, keepRecipe: true),
            onSuccess: _ => { IsFinished = true; });
    }

    // ---- CLI ----

    private async Task RunCliAsync(Func<string, string[]> argBuilder, Action<string> onSuccess)
    {
        if (IsRunning) return;
        IsRunning = true;
        FireBag();
        await RunCliCoreAsync(argBuilder, onSuccess);
        IsRunning = false;
        FireBag();
    }

    /// <summary>
    /// CLI body WITHOUT the IsRunning toggle/guard — for callers (Simple bake)
    /// that already own the running state across a multi-phase pipeline.
    /// </summary>
    private async Task RunCliCoreAsync(Func<string, string[]> argBuilder, Action<string> onSuccess)
    {
        CliLocator.Resolved? resolved = null;
        try { resolved = CliLocator.Locate(); }
        catch (CliLocatorException e)
        {
            AppendLog(LogStream.Stderr, $"CLI locate failed: {e.Message}");
            return;
        }

        var args = argBuilder(resolved.EntryPath);
        AppendLog(LogStream.Stdout, $"+ node {string.Join(" ", args)}");

        var runner = new CliRunner(resolved.NodePath, args);
        _currentRunner = runner;
        var stdoutBuf = new System.Text.StringBuilder();
        try
        {
            await runner.RunAsync(line =>
            {
                // AppendLog marshals to the UI thread internally; we
                // only buffer stdout in the worker thread for the
                // success callback.
                AppendLog(line.Stream, line.Text);
                if (line.Stream == LogStream.Stdout)
                {
                    stdoutBuf.AppendLine(line.Text);
                }
            });
        }
        catch (Exception e)
        {
            AppendLog(LogStream.Stderr, $"spawn failed: {e.Message}");
            _currentRunner = null;
            return;
        }
        _currentRunner = null;
        var code = runner.ExitCode;
        if (code == 0)
        {
            onSuccess(stdoutBuf.ToString());
        }
        else
        {
            AppendLog(LogStream.Stderr, $"CLI exited {code}");
        }
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
        nameof(Mode), nameof(Progress), nameof(Phase),
        nameof(BaseDownloadStarted), nameof(BaseDownloadUrl),
        nameof(ShowIsoRow),
        nameof(ShowProgress), nameof(ProgressIndeterminate), nameof(ProgressValue),
        nameof(PhaseLabel), nameof(ProgressCaption), nameof(ProgressTint),
        nameof(ShowDownloadRow), nameof(DownloadUrlCaption),
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

/// <summary>
/// Argument-vector builders for the Node CLI's subcommands.
/// Pure, unit-testable. Mirror CLIArgs.swift / cli_runner.py.
/// </summary>
public static class CliArgs
{
    public static string[] Verify(string entryPath, string recipePath)
        => new[] { entryPath, "verify", recipePath };

    public static string[] UserData(string entryPath, string recipePath, string outPath, bool keepRecipe)
    {
        var a = new System.Collections.Generic.List<string>
            { entryPath, "user-data", recipePath, outPath };
        if (keepRecipe) a.Add("--keep-recipe");
        return a.ToArray();
    }

    public static string[] Prepare(string entryPath, string recipePath, string isoPath, string outIsoPath, bool keepRecipe)
    {
        var a = new System.Collections.Generic.List<string>
            { entryPath, "prepare", recipePath, isoPath, outIsoPath };
        if (keepRecipe) a.Add("--keep-recipe");
        return a.ToArray();
    }

    public static string[] Write(string entryPath, string recipePath, string isoPath, string? device, bool yes, bool keepRecipe)
    {
        var a = new System.Collections.Generic.List<string>
            { entryPath, "write", recipePath, isoPath };
        if (!string.IsNullOrEmpty(device))
        {
            a.Add("--device");
            a.Add(device);
        }
        if (yes) a.Add("--yes");
        if (keepRecipe) a.Add("--keep-recipe");
        return a.ToArray();
    }
}
