using System;
using System.IO;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace Flagship.Burner;

/// <summary>
/// One phone-pairing milestone, parsed from a `FLAGSHIP_PAIR <json>` line the
/// `flagship-burn pair --emit-events` subprocess prints. Mirrors the shared
/// PairEvent union in packages/flagship-burner/src/pair.ts.
/// </summary>
public sealed record PairEvent
{
    public required string Event { get; init; }
    // ready
    public string? HumanCode { get; init; }
    public string? QrTerminal { get; init; }
    public string? Payload { get; init; }
    public bool DebugRequested { get; init; }
    // phone-connected
    public string? Sas { get; init; }
    // delivered / done
    public string? ServerDomain { get; init; }
    // done
    public string? RecipePath { get; init; }
    public bool DebugGranted { get; init; }
    // error
    public string? Message { get; init; }
}

/// <summary>
/// Pure parser for the subprocess's structured stdout. Kept separate from the
/// process plumbing so it's unit-testable. A line that isn't a well-formed
/// `FLAGSHIP_PAIR <json>` returns null (ordinary human log line).
/// </summary>
public static class PairEventParser
{
    public const string Prefix = "FLAGSHIP_PAIR ";

    public static PairEvent? TryParse(string line)
    {
        if (line is null) return null;
        var trimmed = line.TrimStart();
        if (!trimmed.StartsWith(Prefix, StringComparison.Ordinal)) return null;
        var json = trimmed[Prefix.Length..];
        try
        {
            using var doc = JsonDocument.Parse(json);
            var root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object) return null;
            if (!root.TryGetProperty("event", out var ev) || ev.ValueKind != JsonValueKind.String)
                return null;
            string? Str(string name) =>
                root.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
            bool Bool(string name) =>
                root.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.True;
            return new PairEvent
            {
                Event = ev.GetString()!,
                HumanCode = Str("humanCode"),
                QrTerminal = Str("qrTerminal"),
                Payload = Str("payload"),
                DebugRequested = Bool("debugRequested"),
                Sas = Str("sas"),
                ServerDomain = Str("serverDomain"),
                RecipePath = Str("recipePath"),
                DebugGranted = Bool("debugGranted"),
                Message = Str("message"),
            };
        }
        catch (JsonException)
        {
            return null;
        }
    }
}

/// <summary>
/// Drives `flagship-burn pair --out &lt;tmp&gt; --emit-events` and surfaces its
/// milestones as .NET events. The heavy lifting (the relay handshake, SAS
/// derivation, recipe decrypt + signature verify) is the SHARED TypeScript
/// implementation — this is thin glue, exactly like the remaster/write path.
/// On the terminal `done` event the recipe JSON has been written to the temp
/// path; the caller loads + verifies it locally (RecipeLoader) and proceeds to
/// the destination chooser.
/// </summary>
public sealed class PairSession
{
    private readonly bool _debug;
    private CliRunner? _runner;
    private readonly CancellationTokenSource _cts = new();

    /// <summary>Raised on the UI-marshalling caller's thread is NOT guaranteed —
    /// subscribers must dispatch to the UI themselves (the Wizard does).</summary>
    public event Action<PairEvent>? OnEvent;
    public event Action<LogLine>? OnLog;

    public string RecipeOutPath { get; }

    public PairSession(bool debug, string? outPath = null)
    {
        _debug = debug;
        RecipeOutPath = outPath ?? Path.Combine(Path.GetTempPath(),
            $"flagship-pair-{Guid.NewGuid():N}.json");
    }

    /// <summary>
    /// Spawn the pairing subprocess. Completes when it exits (after `done` or an
    /// error). Throws only if the CLI can't be located/spawned.
    /// </summary>
    public async Task RunAsync()
    {
        var resolved = CliLocator.Locate();
        var args = CliArgs.Pair(resolved.EntryPath, RecipeOutPath, _debug);
        _runner = new CliRunner(resolved.NodePath, args);
        await _runner.RunAsync(line =>
        {
            var ev = line.Stream == LogStream.Stdout ? PairEventParser.TryParse(line.Text) : null;
            if (ev != null) OnEvent?.Invoke(ev);
            else OnLog?.Invoke(line);
        }, _cts.Token);
    }

    public void Cancel()
    {
        try { _cts.Cancel(); } catch { }
        _runner?.Cancel();
    }
}
