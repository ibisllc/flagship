// CliArgs lives in Wizard.cs alongside the WPF view-model; the test
// project can't pull Wizard.cs in (WPF on non-Windows would fail).
// Mirror the static arg-vector builders here so they stay in lock-step.
// If you change CliArgs in Wizard.cs you MUST update this shim.

namespace Flagship.Burner;

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
