using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Text.RegularExpressions;
using System.Threading.Tasks;

namespace Flagship.Builder;

/// <summary>
/// "Restart as administrator" without losing the servers (Windows acceptance W10). The elevated copy is started
/// first, so a No at the UAC prompt (or a timeout) changes nothing; only once it is running does this copy shut its
/// servers down and quit. The elevated copy waits for this one to exit before it touches a VM (their disks are in
/// use until then) and starts again the servers that were running.
/// </summary>
public static class ElevationHandoff
{
    public const string AfterFlag = "--after-elevation";
    public const string ResumeFlag = "--resume";
    /// <summary>The old copy powers each server off for up to VMManager.GracefulStopSeconds, all at once.</summary>
    public static readonly TimeSpan WaitForOldCopy = TimeSpan.FromMinutes(3);

    private static readonly Regex ServerName = new("^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$", RegexOptions.CultureInvariant);

    public sealed record Request(int Pid, IReadOnlyList<string> Resume);

    public static string Arguments(int pid, IEnumerable<string> resume)
    {
        var names = resume.Where(n => ServerName.IsMatch(n)).Distinct().ToArray();
        var args = $"{AfterFlag} {pid}";
        return names.Length == 0 ? args : $"{args} {ResumeFlag} {string.Join(",", names)}";
    }

    public static Request? Parse(IReadOnlyList<string> args)
    {
        int? pid = null;
        var resume = new List<string>();
        for (var i = 0; i < args.Count - 1; i++)
        {
            if (args[i] == AfterFlag && int.TryParse(args[i + 1], out var p) && p > 0) pid = p;
            else if (args[i] == ResumeFlag)
                resume.AddRange(args[i + 1].Split(',', StringSplitOptions.RemoveEmptyEntries).Where(n => ServerName.IsMatch(n)));
        }
        return pid is int id ? new Request(id, resume.Distinct().ToArray()) : null;
    }

    /// <summary>Wait until the copy that asked for elevation has exited (or the wait runs out).</summary>
    public static async Task WaitForExitAsync(int pid, TimeSpan timeout)
    {
        Process process;
        try { process = Process.GetProcessById(pid); }
        catch (ArgumentException) { return; }
        using (process)
        {
            var exited = process.WaitForExitAsync();
            await Task.WhenAny(exited, Task.Delay(timeout));
        }
    }
}
