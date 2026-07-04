using System;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Threading;
using System.Threading.Tasks;

namespace Flagship.Burner.VM;

/// <summary>
/// The ONE file that runs QEMU. Deliberately dumb: it translates a pure
/// VMConfig (all decisions already made — see QemuCommandLine) into a
/// process and starts/stops it. The pure layer is what's unit-tested; this
/// adapter is exercised by the live e2e boot.
///
/// The analog of the Mac's VZHost: onGuestStopped fires when the guest stops
/// on its own — install completion (the preseed/-no-reboot end the process)
/// or a crash. The pure lifecycle decides what it means (for installs, via
/// the duration-gated VMLifecycle.VerdictForCleanInstallStop).
/// </summary>
public sealed class QemuHost
{
    private readonly QemuToolchain _toolchain;
    private Process? _process;

    public QemuHost(QemuToolchain toolchain)
    {
        _toolchain = toolchain;
    }

    /// <summary>QMP port of the running VM (0 when stopped).</summary>
    public int QmpPort { get; private set; }
    /// <summary>Serial-console port of the running VM (0 when stopped or
    /// production — the console device only exists under a debug grant).</summary>
    public int SerialPort { get; private set; }
    public bool IsRunning => _process is { HasExited: false };

    /// <summary>
    /// Fired (on a thread-pool thread) when the guest stops for ANY reason:
    /// (exitCode, stderrTail). A clean stop is exit 0; the caller marshals to
    /// its own context and feeds the pure lifecycle. Plain settable callback
    /// (not an event) mirroring VZHost.onGuestStopped.
    /// </summary>
    public Action<int, string>? OnGuestStopped { get; set; }

    /// <summary>
    /// Create the sparse main disk (qcow2 grows into it) + the per-VM UEFI
    /// vars copy if they don't exist yet. Idempotent.
    /// </summary>
    public async Task EnsureBundleArtifactsAsync(VMConfig config, VMBundleLayout layout,
                                                 CancellationToken cancellation = default)
    {
        var diskPath = layout.DiskImagePath(config.Name);
        if (!File.Exists(diskPath))
        {
            var gib = config.MainDiskSizeBytes / VMResourcePlan.GiB;
            var psi = new ProcessStartInfo
            {
                FileName = _toolchain.ImgBinary,
                RedirectStandardError = true,
                RedirectStandardOutput = true,
                UseShellExecute = false,
                CreateNoWindow = true,
            };
            psi.ArgumentList.Add("create");
            psi.ArgumentList.Add("-f");
            psi.ArgumentList.Add("qcow2");
            psi.ArgumentList.Add(diskPath);
            psi.ArgumentList.Add($"{gib}G");
            using var p = Process.Start(psi) ?? throw new IOException("qemu-img spawn failed");
            var stderr = await p.StandardError.ReadToEndAsync(cancellation);
            await p.WaitForExitAsync(cancellation);
            if (p.ExitCode != 0)
                throw new IOException($"qemu-img create failed ({p.ExitCode}): {stderr.Trim()}");
        }

        var varsPath = layout.EfiVariableStorePath(config.Name);
        if (!File.Exists(varsPath))
            File.Copy(_toolchain.UefiVarsTemplate, varsPath);
    }

    /// <summary>Start the VM. attachInstallerISO mirrors the lifecycle effects.</summary>
    public async Task StartAsync(VMConfig config, VMBundleLayout layout, bool attachInstallerISO,
                                 string accel = "whpx", CancellationToken cancellation = default)
    {
        if (IsRunning) throw new InvalidOperationException($"VM '{config.Name}' is already running.");
        await EnsureBundleArtifactsAsync(config, layout, cancellation);

        QmpPort = FreeLoopbackPort();
        SerialPort = config.SerialConsoleEnabled ? FreeLoopbackPort() : 0;
        var args = QemuCommandLine.Build(config, layout, _toolchain.UefiCodePath,
                                         attachInstallerISO, QmpPort, SerialPort, accel);

        var psi = new ProcessStartInfo
        {
            FileName = _toolchain.SystemBinary,
            RedirectStandardError = true,
            RedirectStandardOutput = true,
            UseShellExecute = false,
            CreateNoWindow = true,
        };
        foreach (var a in args) psi.ArgumentList.Add(a);

        var p = Process.Start(psi) ?? throw new IOException("qemu spawn failed");
        p.EnableRaisingEvents = true;
        var stderrTask = p.StandardError.ReadToEndAsync(CancellationToken.None);
        _ = p.StandardOutput.ReadToEndAsync(CancellationToken.None); // drain, unused
        p.Exited += async (_, _) =>
        {
            string tail = "";
            try { tail = Tail(await stderrTask, 2000); } catch { }
            var code = 0;
            try { code = p.ExitCode; } catch { }
            _process = null;
            QmpPort = 0;
            SerialPort = 0;
            OnGuestStopped?.Invoke(code, tail);
        };
        _process = p;

        // Surface an immediate startup failure (bad args, WHPX refusal) as a
        // thrown error rather than a phantom "running" VM.
        await Task.Delay(750, cancellation);
        if (p.HasExited)
        {
            var stderr = Tail(await stderrTask, 2000);
            throw new IOException($"QEMU failed to start (exit {p.ExitCode}): {stderr.Trim()}");
        }
    }

    /// <summary>
    /// Ask the guest to power down cleanly (ACPI); after graceSeconds without
    /// an exit, hard-stop. The OnGuestStopped event carries the final word.
    /// </summary>
    public async Task StopAsync(int graceSeconds = 90, CancellationToken cancellation = default)
    {
        var p = _process;
        if (p is null || p.HasExited) return;
        try
        {
            await using var qmp = new QmpClient();
            using var connectCts = CancellationTokenSource.CreateLinkedTokenSource(cancellation);
            connectCts.CancelAfter(TimeSpan.FromSeconds(5));
            await qmp.ConnectAsync(QmpPort, connectCts.Token);
            await qmp.SystemPowerdownAsync(connectCts.Token);
        }
        catch
        {
            // QMP unreachable — fall through to the hard stop below.
        }
        var exited = await Task.Run(() => p.WaitForExit(graceSeconds * 1000), cancellation);
        if (!exited) await ForceStopAsync();
    }

    public async Task ForceStopAsync()
    {
        var p = _process;
        if (p is null || p.HasExited) return;
        try
        {
            await using var qmp = new QmpClient();
            using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(3));
            await qmp.ConnectAsync(QmpPort, cts.Token);
            await qmp.QuitAsync(cts.Token);
            if (await Task.Run(() => p.WaitForExit(3000))) return;
        }
        catch { }
        try { p.Kill(entireProcessTree: true); } catch { }
    }

    private static int FreeLoopbackPort()
    {
        var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        var port = ((IPEndPoint)listener.LocalEndpoint).Port;
        listener.Stop();
        return port;
    }

    private static string Tail(string s, int max) => s.Length <= max ? s : s[^max..];
}
