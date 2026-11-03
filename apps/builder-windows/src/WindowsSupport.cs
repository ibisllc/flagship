using System;

namespace Flagship.Builder;

/// <summary>
/// Studio runs on Windows 11 and on Windows 10 22H2 (x64). Windows 10 no longer gets security updates, so
/// Studio shows a calm notice there, like the phone app's line for an older Android, and never blocks
/// anything. Windows 10 is told apart by its build number: every Windows 11 build is 22000 or later.
/// </summary>
public static class WindowsSupport
{
    public const int FirstWindows11Build = 22000;

    public static bool IsWindows10(Version osVersion) =>
        osVersion.Major == 10 && osVersion.Build is > 0 and < FirstWindows11Build;

    /// <summary>The notice for this Windows, or null on Windows 11 (and anything unknown).</summary>
    public static string? Notice(Version osVersion) =>
        IsWindows10(osVersion) ? Strings.T("windows10NoLongerGetsSecurityUpdates") : null;

    /// <summary>.NET reports the real version (no compatibility shim) since .NET 5.</summary>
    public static string? CurrentNotice() =>
        OperatingSystem.IsWindows() ? Notice(Environment.OSVersion.Version) : null;
}
