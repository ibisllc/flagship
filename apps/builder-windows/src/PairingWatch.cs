using System;

namespace Flagship.Builder;

/// <summary>
/// Keeps a live pairing code on screen without anyone pressing a button.
/// Mirrors the Mac WizardModel's pairing lifecycle (and the Linux
/// pairing_watch.py): pairing starts at launch, stops while the PC is offline
/// so the code doesn't churn against a dead relay, comes back with the
/// network, and a failed session is retried with a growing delay. A session
/// the owner cancelled, or one that delivered its recipe, is not restarted:
/// wantsPairing says when a new one is wanted.
/// </summary>
public sealed class PairingWatch
{
    public static readonly TimeSpan[] RetryDelays =
    {
        TimeSpan.FromSeconds(5), TimeSpan.FromSeconds(10), TimeSpan.FromSeconds(20),
        TimeSpan.FromSeconds(40), TimeSpan.FromSeconds(60),
    };

    private readonly Func<bool> _wantsPairing;
    private readonly Action _start;
    private readonly Action _stop;
    private readonly Func<TimeSpan, Action, Action> _schedule;
    private int _failures;
    private Action? _cancelRetry;

    /// <param name="schedule">Runs the action after the delay (on the UI
    /// thread) and returns a cancel.</param>
    public PairingWatch(Func<bool> wantsPairing, Action start, Action stop, Func<TimeSpan, Action, Action> schedule)
    {
        _wantsPairing = wantsPairing;
        _start = start;
        _stop = stop;
        _schedule = schedule;
    }

    public bool IsOnline { get; private set; } = true;

    public void Launch()
    {
        if (IsOnline && _wantsPairing()) _start();
    }

    public void OnConnectivity(bool online)
    {
        if (online == IsOnline) return;
        IsOnline = online;
        if (online)
        {
            _failures = 0;
            if (_wantsPairing()) _start();
        }
        else
        {
            DropRetry();
            _stop();
        }
    }

    /// <summary>The relay answered: the next failure starts from the short delay.</summary>
    public void OnReady() => _failures = 0;

    public void OnFailed()
    {
        if (!IsOnline || _cancelRetry is not null) return;
        var delay = RetryDelays[Math.Min(_failures, RetryDelays.Length - 1)];
        _failures++;
        _cancelRetry = _schedule(delay, Retry);
    }

    private void Retry()
    {
        _cancelRetry = null;
        if (IsOnline && _wantsPairing()) _start();
    }

    private void DropRetry()
    {
        var cancel = _cancelRetry;
        _cancelRetry = null;
        cancel?.Invoke();
    }
}
