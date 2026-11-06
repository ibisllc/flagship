using System.Reflection;

namespace Flagship.Builder;

/// <summary>The version studio-release stamped into this build
/// (FlagshipBuilder.csproj StudioVersion), without the SourceLink commit
/// suffix .NET appends to the informational version.</summary>
internal static class StudioVersion
{
    /// <summary>The maturity word beside the product version
    /// (release/version.json; scripts/check-versions.mjs --write keeps it in step).</summary>
    public const string Label = "Beta";

    /// <summary>Whether this platform still carries the "Experimental" tag: STUDIO_EXPERIMENTAL.windows in
    /// apps/web/public/app-stores.js, the website's switch (scripts/check-versions.mjs --write keeps it in step).
    /// It goes false only after docs/runbooks/0.3-windows-studio-acceptance.md passes.</summary>
    public const bool Experimental = false;

    /// <summary>The brand name, not translated.</summary>
    public const string ProductName = "Flagship Studio";

    /// <summary>The main window's title: the brand, tagged while the platform is Experimental.</summary>
    public static string WindowTitle(bool experimental = Experimental)
        => experimental ? Strings.T("flagshipStudioExperimental") : ProductName;

    public static readonly string Current =
        (typeof(StudioVersion).Assembly.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion
            ?? "0.0.0-dev").Split('+')[0];

    /// <summary>"0.2.0" reads as "0.2 Beta"; a dev build or a patch release is shown as is.</summary>
    public static string Display(string version)
    {
        var parts = version.Split('.');
        if (parts.Length == 3 && parts[2] == "0" && int.TryParse(parts[0], out _) && int.TryParse(parts[1], out _))
            return $"{parts[0]}.{parts[1]} {Strings.T(Label)}";
        return version;
    }

    public static string CurrentDisplay => Display(Current);
}
