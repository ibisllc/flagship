namespace Flagship.Builder;

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

    public static string[] ApplianceProvision(string entryPath, string recipePath,
        string basePath, string manifestPath, string diskPath, string seedPath,
        string arch, ulong diskSize, string qemuImg)
        => new[] { entryPath, "appliance-provision", recipePath, basePath, manifestPath,
            diskPath, seedPath, "--arch", arch, "--disk-size",
            diskSize.ToString(System.Globalization.CultureInfo.InvariantCulture),
            "--qemu-img", qemuImg };

    public static string[] Write(string entryPath, string recipePath, string isoPath, string? device, bool yes, bool keepRecipe, string? wifiSsid = null, string? wifiPassword = null)
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
        if (!string.IsNullOrWhiteSpace(wifiSsid))
        {
            a.Add("--wifi-ssid"); a.Add(wifiSsid.Trim());
            a.Add("--wifi-password"); a.Add(wifiPassword ?? string.Empty);
        }
        return a.ToArray();
    }

    /// <summary>
    /// `pair --out &lt;recipe.json&gt; --emit-events [--debug]` — the phone-pairing
    /// relay session (shared TS implementation), with machine-readable
    /// milestones the WPF cover renders. Mirrors the CLI's `cmdPair`.
    /// </summary>
    public static string[] Pair(string entryPath, string outPath, bool debug)
    {
        var a = new System.Collections.Generic.List<string>
            { entryPath, "pair", "--out", outPath, "--emit-events" };
        if (debug) a.Add("--debug");
        return a.ToArray();
    }
}
