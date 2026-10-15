using System;
using System.Collections.Generic;
using System.Linq;
using Flagship.Builder;
using Xunit;

namespace Flagship.Builder.Tests;

/// <summary>
/// A pairing code stays up without anyone pressing a button: started at
/// launch, paused offline, back with the network, failures retried with a
/// growing delay, never restarted when no longer wanted. Mirrors the Linux
/// test_pairing_watch.py.
/// </summary>
public class PairingWatchTests
{
    private sealed class Rig
    {
        public readonly List<string> Calls = new();
        public readonly List<(TimeSpan Delay, Action Fire, bool[] Cancelled)> Pending = new();
        public bool Wants = true;
        public readonly PairingWatch Watch;

        public Rig()
        {
            Watch = new PairingWatch(() => Wants, () => Calls.Add("start"), () => Calls.Add("stop"), (delay, fire) =>
            {
                var cancelled = new[] { false };
                Pending.Add((delay, fire, cancelled));
                return () => cancelled[0] = true;
            });
        }

        public TimeSpan Fire()
        {
            var (delay, fire, cancelled) = Pending[0];
            Pending.RemoveAt(0);
            if (!cancelled[0]) fire();
            return delay;
        }
    }

    [Fact]
    public void StartsAtLaunchOnlyWhenWanted()
    {
        var r = new Rig();
        r.Watch.Launch();
        Assert.Equal(new[] { "start" }, r.Calls);
        var idle = new Rig { Wants = false };
        idle.Watch.Launch();
        Assert.Empty(idle.Calls);
    }

    [Fact]
    public void OfflineStopsAndOnlineStartsAgain()
    {
        var r = new Rig();
        r.Watch.OnConnectivity(false);
        r.Watch.OnConnectivity(false);
        Assert.Equal(new[] { "stop" }, r.Calls);
        r.Watch.OnConnectivity(true);
        Assert.Equal(new[] { "stop", "start" }, r.Calls);
    }

    [Fact]
    public void FailuresRetryWithGrowingDelaysAndResetOnceReady()
    {
        var r = new Rig();
        var delays = new List<TimeSpan>();
        for (var i = 0; i <= PairingWatch.RetryDelays.Length; i++)
        {
            r.Watch.OnFailed();
            delays.Add(r.Fire());
        }
        Assert.Equal(PairingWatch.RetryDelays.Append(PairingWatch.RetryDelays[^1]), delays);
        r.Watch.OnReady();
        r.Watch.OnFailed();
        Assert.Equal(PairingWatch.RetryDelays[0], r.Fire());
    }

    [Fact]
    public void NoRetryWhileOfflineOrOnceNoLongerWanted()
    {
        var r = new Rig();
        r.Watch.OnFailed();
        r.Watch.OnConnectivity(false);
        r.Fire();
        Assert.Equal(new[] { "stop" }, r.Calls);
        r.Watch.OnConnectivity(true);
        r.Watch.OnFailed();
        r.Wants = false;
        r.Fire();
        Assert.Equal(new[] { "stop", "start" }, r.Calls);
    }
}
