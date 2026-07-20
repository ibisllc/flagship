using System;
using System.Diagnostics;
using System.IO;
using System.Threading;
using System.Threading.Tasks;

namespace Flagship.Builder;

public enum LogStream { Stdout, Stderr }

public readonly record struct LogLine(LogStream Stream, string Text);

/// <summary>
/// Spawn the @flagship/builder Node CLI and stream stdout/stderr line by
/// line via callback. Mirrors apps/builder-mac CLIRunner.swift and
/// apps/builder-linux cli_runner.py.
///
/// The runner does not own the locate step — pass the resolved
/// `nodePath` + argv[0] = entryPath in. Cancellation kills the process.
/// </summary>
public sealed class CliRunner
{
    private readonly string _nodePath;
    private readonly string[] _arguments;
    private readonly string? _workingDirectory;
    private Process? _process;
    public int ExitCode { get; private set; } = -1;

    public CliRunner(string nodePath, string[] arguments, string? workingDirectory = null)
    {
        _nodePath = nodePath;
        _arguments = arguments;
        _workingDirectory = workingDirectory;
    }

    public bool IsRunning => _process != null && !_process.HasExited;

    /// <summary>
    /// Launch the subprocess and stream both pipes line by line. The
    /// returned task completes after the process exits + both pipes
    /// have hit EOF. Throws if spawn fails; runtime errors surface as
    /// non-zero ExitCode + stderr lines.
    /// </summary>
    public async Task RunAsync(Action<LogLine> onLine, CancellationToken cancellation = default)
    {
        var psi = new ProcessStartInfo
        {
            FileName = _nodePath,
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            RedirectStandardInput = false,
            CreateNoWindow = true,
            WorkingDirectory = _workingDirectory ?? string.Empty,
            // Force UTF-8 so non-ASCII paths and JSON survive. Windows
            // default is the active code page, which is often CP1252.
            StandardOutputEncoding = System.Text.Encoding.UTF8,
            StandardErrorEncoding = System.Text.Encoding.UTF8,
        };
        foreach (var a in _arguments) psi.ArgumentList.Add(a);

        var p = new Process { StartInfo = psi, EnableRaisingEvents = true };
        _process = p;
        ExitCode = -1;

        var stdoutDone = new TaskCompletionSource();
        var stderrDone = new TaskCompletionSource();
        var exitedTcs = new TaskCompletionSource();

        p.OutputDataReceived += (_, e) =>
        {
            if (e.Data == null) { stdoutDone.TrySetResult(); return; }
            try { onLine(new LogLine(LogStream.Stdout, e.Data)); } catch { /* swallow */ }
        };
        p.ErrorDataReceived += (_, e) =>
        {
            if (e.Data == null) { stderrDone.TrySetResult(); return; }
            try { onLine(new LogLine(LogStream.Stderr, e.Data)); } catch { /* swallow */ }
        };
        p.Exited += (_, _) => exitedTcs.TrySetResult();

        if (!p.Start())
        {
            throw new InvalidOperationException("Process.Start returned false");
        }
        p.BeginOutputReadLine();
        p.BeginErrorReadLine();

        using var reg = cancellation.Register(() =>
        {
            try { if (!p.HasExited) p.Kill(entireProcessTree: true); } catch { }
        });

        await Task.WhenAll(stdoutDone.Task, stderrDone.Task, exitedTcs.Task);
        ExitCode = p.ExitCode;
    }

    public void Cancel()
    {
        try
        {
            if (_process != null && !_process.HasExited)
            {
                _process.Kill(entireProcessTree: true);
            }
        }
        catch { /* ignore — best effort */ }
    }
}
