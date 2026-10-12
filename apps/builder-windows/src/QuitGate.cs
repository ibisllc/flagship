using System;
using System.Threading.Tasks;

namespace Flagship.Builder;

/// <summary>
/// Holds the app's exit until hosted servers have powered off. QEMU runs as
/// separate processes that outlive the app, and leaving a guest running
/// unattended or killing it is a power cut to the server. WPF-free so the
/// decision is unit tested; MainWindow feeds it every Window.Closing.
/// Mirrors the Mac AppDelegate's applicationShouldTerminate.
/// </summary>
public sealed class QuitGate
{
    private readonly Func<bool> _hasLiveServers;
    private readonly Func<Task> _shutDownAll;
    private readonly Action _closeForReal;
    private bool _released;

    /// <param name="closeForReal">Must not close synchronously: it can run
    /// inside the Closing handler that started the shutdown.</param>
    public QuitGate(Func<bool> hasLiveServers, Func<Task> shutDownAll, Action closeForReal)
    {
        _hasLiveServers = hasLiveServers;
        _shutDownAll = shutDownAll;
        _closeForReal = closeForReal;
    }

    public bool IsShuttingDown { get; private set; }

    /// <summary>
    /// Called for every close request; true means cancel this one. The first
    /// request that finds a live server starts shutting them all down and
    /// closes for real once they are off; requests meanwhile are held.
    /// </summary>
    public bool ShouldHoldClose()
    {
        if (_released) return false;
        if (IsShuttingDown) return true;
        if (!_hasLiveServers()) return false;
        IsShuttingDown = true;
        _ = ShutDownThenCloseAsync();
        return true;
    }

    private async Task ShutDownThenCloseAsync()
    {
        try { await _shutDownAll(); }
        catch { }
        _released = true;
        IsShuttingDown = false;
        _closeForReal();
    }
}
