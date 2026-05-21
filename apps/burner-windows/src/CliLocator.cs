using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;

namespace Flagship.Burner;

/// <summary>
/// Find Node + the Flagship Burner CLI entry point on Windows.
///
/// Resolution order (first hit wins):
///   1. env vars FLAGSHIP_NODE_PATH / FLAGSHIP_BURN_ENTRY (dev overrides)
///   2. Common Node install locations on Windows:
///        - %ProgramFiles%\nodejs\node.exe
///        - %ProgramFiles(x86)%\nodejs\node.exe
///        - %LocalAppData%\Programs\nodejs\node.exe (winget)
///   3. PATH lookup for `node.exe`
///   4. CLI entry: walk up from the assembly location to find
///      ..\..\..\..\packages\flagship-burner\src\cli.ts (dev) or
///      a bundled dist\cli.js (release packaging — Phase 2)
///
/// Mirrors apps/burner-mac CLILocator.swift + apps/burner-linux cli_runner.py.
/// </summary>
public sealed class CliLocatorException : Exception
{
    public CliLocatorException(string message) : base(message) { }
}

public static class CliLocator
{
    public sealed record Resolved(string NodePath, string EntryPath);

    public static Resolved Locate(IReadOnlyDictionary<string, string?>? environment = null,
                                   Func<string, bool>? fileExists = null,
                                   string? executableDir = null)
    {
        var env = environment ?? ReadEnv();
        var exists = fileExists ?? (p => File.Exists(p));
        var node = FindNode(env, exists);
        var entry = FindEntry(env, exists, executableDir);
        return new Resolved(node, entry);
    }

    public static string FindNode(IReadOnlyDictionary<string, string?> env, Func<string, bool> exists)
    {
        if (env.TryGetValue("FLAGSHIP_NODE_PATH", out var ovr) && !string.IsNullOrEmpty(ovr) && exists(ovr))
        {
            return ovr;
        }
        var candidates = new List<string>();
        foreach (var v in new[] { "ProgramFiles", "ProgramFiles(x86)" })
        {
            if (env.TryGetValue(v, out var pf) && !string.IsNullOrEmpty(pf))
            {
                candidates.Add(Path.Combine(pf, "nodejs", "node.exe"));
            }
        }
        if (env.TryGetValue("LocalAppData", out var lad) && !string.IsNullOrEmpty(lad))
        {
            candidates.Add(Path.Combine(lad, "Programs", "nodejs", "node.exe"));
        }
        // chocolatey lib path occasionally moves node here
        candidates.Add(@"C:\ProgramData\chocolatey\lib\nodejs\tools\node.exe");
        foreach (var c in candidates)
        {
            if (exists(c)) return c;
        }
        // PATH lookup
        var fromPath = LookupOnPath("node.exe", env);
        if (fromPath != null) return fromPath;
        throw new CliLocatorException(
            $"node.exe not found; searched: {string.Join("; ", candidates)} + PATH");
    }

    public static string FindEntry(IReadOnlyDictionary<string, string?> env,
                                    Func<string, bool> exists,
                                    string? executableDir = null)
    {
        if (env.TryGetValue("FLAGSHIP_BURN_ENTRY", out var ovr) && !string.IsNullOrEmpty(ovr) && exists(ovr))
        {
            return ovr;
        }
        var baseDir = executableDir ?? AppContext.BaseDirectory;
        var searched = new List<string>();
        // dev run: apps\burner-windows\bin\Debug\net8.0-windows\ → walk
        // up to the repo root then into packages\flagship-burner\src\cli.ts.
        // We try a few depths to be resilient to publishing layouts.
        for (var depth = 1; depth <= 6; depth++)
        {
            var ancestor = ClimbParents(baseDir, depth);
            if (ancestor == null) break;
            var candidate = Path.Combine(ancestor,
                "packages", "flagship-burner", "src", "cli.ts");
            searched.Add(candidate);
            if (exists(candidate)) return candidate;
            var jsCandidate = Path.Combine(ancestor,
                "packages", "flagship-burner", "dist", "cli.js");
            searched.Add(jsCandidate);
            if (exists(jsCandidate)) return jsCandidate;
        }
        // Bundled-with-app fallback (Phase 2 release packaging copies
        // the dist tree alongside the exe).
        var local = Path.Combine(baseDir, "flagship-burner", "src", "cli.ts");
        searched.Add(local);
        if (exists(local)) return local;
        var localJs = Path.Combine(baseDir, "flagship-burner", "dist", "cli.js");
        searched.Add(localJs);
        if (exists(localJs)) return localJs;
        throw new CliLocatorException(
            $"Flagship Burner CLI entry not found; searched: {string.Join("; ", searched)}");
    }

    /// <summary>Return the directory `levels` parents up from `start`,
    /// or null if it walks past the filesystem root.</summary>
    public static string? ClimbParents(string start, int levels)
    {
        var current = start;
        for (var i = 0; i < levels; i++)
        {
            var parent = Path.GetDirectoryName(current?.TrimEnd(Path.DirectorySeparatorChar));
            if (string.IsNullOrEmpty(parent) || parent == current) return null;
            current = parent;
        }
        return current;
    }

    /// <summary>Pure PATH lookup — splits %PATH%, tests each candidate.</summary>
    public static string? LookupOnPath(string fileName, IReadOnlyDictionary<string, string?> env)
    {
        if (!env.TryGetValue("PATH", out var pathVal) || string.IsNullOrEmpty(pathVal))
        {
            return null;
        }
        foreach (var part in pathVal!.Split(';', StringSplitOptions.RemoveEmptyEntries))
        {
            var trimmed = part.Trim().Trim('"');
            if (trimmed.Length == 0) continue;
            try
            {
                var candidate = Path.Combine(trimmed, fileName);
                if (File.Exists(candidate)) return candidate;
            }
            catch (ArgumentException) { /* skip malformed PATH entries */ }
        }
        return null;
    }

    private static IReadOnlyDictionary<string, string?> ReadEnv()
    {
        var d = new Dictionary<string, string?>(StringComparer.OrdinalIgnoreCase);
        foreach (System.Collections.DictionaryEntry e in Environment.GetEnvironmentVariables())
        {
            d[e.Key.ToString()!] = e.Value?.ToString();
        }
        return d;
    }
}
