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

    public static readonly string Current =
        (typeof(StudioVersion).Assembly.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion
            ?? "0.0.0-dev").Split('+')[0];

    /// <summary>"0.2.0" reads as "0.2 Beta"; a dev build or a patch release is shown as is.</summary>
    public static string Display(string version)
    {
        var parts = version.Split('.');
        if (parts.Length == 3 && parts[2] == "0" && int.TryParse(parts[0], out _) && int.TryParse(parts[1], out _))
            return $"{parts[0]}.{parts[1]} {Label}";
        return version;
    }

    public static string CurrentDisplay => Display(Current);
}
