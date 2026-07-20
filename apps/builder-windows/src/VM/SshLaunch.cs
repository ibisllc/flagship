using System.Collections.Generic;
using System.Globalization;

namespace Flagship.Builder.VM;

/// <summary>
/// Builds the argv to open an interactive SSH session to a hosted debug VM
/// over its loopback host-forward. Pure + unit-tested; the caller spawns a
/// terminal around it. The guest's own debug gate still governs whether the
/// login succeeds — this only saves the owner from hunting a LAN IP.
/// </summary>
public static class SshLaunch
{
    public const string DebugUser = "debug";

    /// <summary>
    /// `ssh -p &lt;port&gt; -o StrictHostKeyChecking=no -o UserKnownHostsFile=NUL
    /// debug@127.0.0.1`. Host-key checking is disabled because the guest
    /// regenerates its host key on first boot and the target is loopback (the
    /// forward, not a real network peer), so a pinned known_hosts would just
    /// nag on every reburn.
    /// </summary>
    public static string[] SshArgs(int sshPort)
        => new[]
        {
            "-p", sshPort.ToString(CultureInfo.InvariantCulture),
            "-o", "StrictHostKeyChecking=no",
            "-o", "UserKnownHostsFile=NUL",
            $"{DebugUser}@127.0.0.1",
        };

    /// <summary>
    /// The full `cmd.exe /k …` argument string that opens a new console window
    /// running the SSH session (kept open with /k so the user sees output even
    /// after the session ends). Quotes nothing that needs it — all tokens are
    /// safe literals.
    /// </summary>
    public static string CmdKArguments(int sshPort)
    {
        var parts = new List<string> { "/k", "ssh" };
        parts.AddRange(SshArgs(sshPort));
        return string.Join(" ", parts);
    }
}
