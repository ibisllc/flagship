using System.Reflection;

namespace Flagship.Builder;

/// <summary>The version studio-release stamped into this build
/// (FlagshipBuilder.csproj StudioVersion), without the SourceLink commit
/// suffix .NET appends to the informational version.</summary>
internal static class StudioVersion
{
    public static readonly string Current =
        (typeof(StudioVersion).Assembly.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion
            ?? "0.0.0-dev").Split('+')[0];
}
