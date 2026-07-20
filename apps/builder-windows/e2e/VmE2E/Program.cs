using System;
using System.IO;
using System.Net.Http;
using System.Security.Cryptography.X509Certificates;
using System.Threading;
using System.Threading.Tasks;
using Flagship.Builder;
using Flagship.Builder.VM;

// Headless e2e for the Windows desktop VM appliance: drives the EXACT
// production stack (RecipeLoader → VMConfig.Plan → VMManager → QemuHost →
// duration-gated verdict) through remaster-output → WHPX boot → unattended
// install → ISO-detach → first boot from disk → register → serve.
//
//   dotnet run --project apps/builder-windows/e2e/VmE2E -- <recipe.json> <installer.iso> [workRoot]
//
// The recipe should carry diskEncryption:"none" (no phone in the unlock path)
// so "Running" is reached without any pairing; the proof of life is the
// public FQDN serving over real TLS (the box terminates TLS itself, so ANY
// HTTP response is the green padlock).

if (args.Length < 2)
{
    Console.Error.WriteLine("usage: VmE2E <recipe.json> <installer.iso> [workRoot]");
    return 2;
}
var recipePath = Path.GetFullPath(args[0]);
var installerIso = Path.GetFullPath(args[1]);
var workRoot = args.Length >= 3
    ? Path.GetFullPath(args[2])
    : VMBundleLayout.DefaultRoot().Root;

void Say(string s) => Console.WriteLine($"[{DateTime.Now:HH:mm:ss}] {s}");

// ── 1. Recipe: parse + verify signature locally, exactly like the app ──────
var recipeBytes = File.ReadAllBytes(recipePath);
Recipe recipe;
try { recipe = RecipeLoader.Load(recipeBytes); }
catch (RecipeException e)
{
    Console.Error.WriteLine($"recipe rejected: {e.Message}");
    return 2;
}
Say($"recipe verified: {recipe.ServerDomain} (diskEncryption={recipe.DiskEncryption ?? "luks"})");

// ── 2. Toolchain + WHPX probe ───────────────────────────────────────────────
QemuToolchain toolchain;
try { toolchain = QemuLocator.Locate(); }
catch (QemuLocatorException e)
{
    Console.Error.WriteLine(e.Message);
    return 2;
}
var whpx = await WhpxProbe.RunAsync(toolchain);
Say($"WHPX probe: {whpx.Kind} — {whpx.Message}");
if (!whpx.IsAvailable) return 2;

// ── 3. Plan + create the bundle ─────────────────────────────────────────────
var host = HostResources.Current();
var config = VMConfig.Plan(recipe, recipeBytes, host);
Say($"plan: {config.CpuCount} vCPU, {config.MemoryBytes / VMResourcePlan.GiB} GiB RAM, " +
    $"{config.MainDiskSizeBytes / VMResourcePlan.GiB} GiB disk, console={(config.SerialConsoleEnabled ? "on (debug grant)" : "OFF (production)")}, " +
    $"sealedAtBoot={config.AwaitsPhoneUnlockAtBoot}");

var store = new VMInventoryStore(new VMBundleLayout(workRoot));
Directory.CreateDirectory(workRoot);
var manager = new VMManager(store, toolchain);
manager.Log = Say;

if (manager.Server(config.Name) != null)
{
    Say($"stale bundle for {config.Name} found — deleting for a clean run");
    await manager.DeleteServerAsync(config.Name);
}
manager.CreateServer(config);
File.Copy(installerIso, store.Layout.InstallerIsoPath(config.Name), overwrite: true);
Say($"bundle ready under {store.Layout.BundleDir(config.Name)}");

using var done = new CancellationTokenSource();
Console.CancelKeyPress += (_, e) =>
{
    e.Cancel = true;
    done.Cancel();
};

// ── 4. Install ──────────────────────────────────────────────────────────────
var installStarted = DateTimeOffset.UtcNow;
await manager.BeginInstallAsync(config.Name);

VMStateKind last = VMStateKind.Created;
var installDeadline = DateTimeOffset.UtcNow.AddMinutes(75);
while (!done.IsCancellationRequested)
{
    var s = manager.Server(config.Name);
    if (s is null) { Say("server vanished"); return 1; }
    if (s.Record.State.Kind != last)
    {
        last = s.Record.State.Kind;
        Say($"state → {s.Record.State.Label}" +
            (s.Record.State.Failure is { } f ? $" ({f.Reason})" : ""));
    }
    if (last == VMStateKind.Failed)
    {
        DumpConsoleTail(store, config);
        return 1;
    }
    if (last is VMStateKind.Running or VMStateKind.AwaitingPhoneUnlock) break;
    if (DateTimeOffset.UtcNow > installDeadline)
    {
        Say("TIMEOUT waiting for the install/boot to reach a live state");
        DumpConsoleTail(store, config);
        await manager.PowerOffAsync(config.Name);
        return 1;
    }
    try { await Task.Delay(TimeSpan.FromSeconds(10), done.Token); }
    catch (OperationCanceledException) { break; }
}
if (done.IsCancellationRequested)
{
    Say("cancelled — stopping VM");
    await manager.PowerOffAsync(config.Name);
    return 130;
}
Say($"guest is up (install+first boot took {(DateTimeOffset.UtcNow - installStarted).TotalMinutes:F1} min)");

// ── 5. The green padlock: the public FQDN must serve over real TLS ─────────
string? certSubject = null, certIssuer = null;
using var http = new HttpClient(new HttpClientHandler
{
    ServerCertificateCustomValidationCallback = (req, cert, chain, errors) =>
    {
        certSubject = cert?.Subject;
        certIssuer = cert?.Issuer;
        return errors == System.Net.Security.SslPolicyErrors.None;
    },
})
{ Timeout = TimeSpan.FromSeconds(10) };

var url = $"https://{config.ServerDomain}/";
var serveDeadline = DateTimeOffset.UtcNow.AddMinutes(25);
Say($"polling {url} (register → tunnel → ACME → serve)…");
while (!done.IsCancellationRequested && DateTimeOffset.UtcNow < serveDeadline)
{
    try
    {
        using var resp = await http.GetAsync(url, done.Token);
        Say($"GREEN PADLOCK: {url} answered HTTP {(int)resp.StatusCode}");
        Say($"  cert subject: {certSubject}");
        Say($"  cert issuer:  {certIssuer}");
        Say("e2e COMPLETE — leaving the VM running (Ctrl+C in the console, or Stop in the app, to shut down)");
        return 0;
    }
    catch (OperationCanceledException) when (done.IsCancellationRequested) { break; }
    catch (Exception e)
    {
        var brief = e.InnerException?.Message ?? e.Message;
        Say($"  not yet: {Trim(brief, 100)}");
    }
    var srv = manager.Server(config.Name);
    if (srv?.Record.State.Kind == VMStateKind.Failed)
    {
        Say($"guest failed while waiting to serve: {srv.Record.State.Failure?.Reason}");
        DumpConsoleTail(store, config);
        return 1;
    }
    try { await Task.Delay(TimeSpan.FromSeconds(20), done.Token); }
    catch (OperationCanceledException) { break; }
}

Say(done.IsCancellationRequested ? "cancelled" : "TIMEOUT waiting for the FQDN to serve");
DumpConsoleTail(store, config);
await manager.PowerOffAsync(config.Name);
return 1;

static void DumpConsoleTail(VMInventoryStore store, VMConfig config)
{
    var log = store.Layout.ConsoleLogPath(config.Name);
    if (!File.Exists(log)) { Console.WriteLine("(no console.log — production recipe?)"); return; }
    Console.WriteLine($"--- console.log tail ({log}) ---");
    var text = File.ReadAllText(log);
    Console.WriteLine(text.Length <= 4000 ? text : text[^4000..]);
    Console.WriteLine("--- end console.log ---");
}

static string Trim(string s, int n) => s.Length <= n ? s : s[..n] + "…";
