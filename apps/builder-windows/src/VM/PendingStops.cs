using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;

namespace Flagship.Builder.VM;

/// <summary>
/// Guests still powering off, one per server. A graceful stop can take a
/// minute, and a Start pressed meanwhile must wait for it: two QEMU processes
/// on one disk image would corrupt it. Mirrors the Mac VMManager's `stopping`.
/// </summary>
public sealed class PendingStops
{
    private readonly object _lock = new();
    private readonly Dictionary<string, Task> _stops = new();

    /// <summary>Run a stop and track it until it ends. A stop's failure is
    /// swallowed: the force stop it falls back to is the last word.</summary>
    public async Task RunAsync(string name, Func<Task> stop)
    {
        var tracked = Swallow(stop);
        lock (_lock) _stops[name] = tracked;
        try
        {
            await tracked;
        }
        finally
        {
            lock (_lock)
            {
                if (_stops.TryGetValue(name, out var current) && ReferenceEquals(current, tracked))
                    _stops.Remove(name);
            }
        }
    }

    public bool IsStopping(string name)
    {
        lock (_lock) return _stops.TryGetValue(name, out var t) && !t.IsCompleted;
    }

    public bool AnyInFlight
    {
        get { lock (_lock) return _stops.Values.Any(t => !t.IsCompleted); }
    }

    /// <summary>Wait until no stop of this server is in flight, including one
    /// that began while waiting for an earlier one.</summary>
    public async Task WaitAsync(string name)
    {
        while (true)
        {
            Task? pending;
            lock (_lock) pending = _stops.TryGetValue(name, out var t) && !t.IsCompleted ? t : null;
            if (pending is null) return;
            await pending;
        }
    }

    public Task WaitAllAsync()
    {
        Task[] pending;
        lock (_lock) pending = _stops.Values.Where(t => !t.IsCompleted).ToArray();
        return Task.WhenAll(pending);
    }

    private static async Task Swallow(Func<Task> stop)
    {
        try { await stop(); } catch { }
    }
}
