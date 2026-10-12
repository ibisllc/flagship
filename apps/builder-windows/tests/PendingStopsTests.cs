using System;
using System.IO;
using System.Threading.Tasks;
using Xunit;
using Flagship.Builder.VM;

namespace Flagship.Builder.Tests;

/// <summary>
/// The per-server in-flight stop registry a Start waits on, so a server whose
/// guest is still powering off is never booted a second time on one disk.
/// </summary>
public sealed class PendingStopsTests
{
    private static TaskCompletionSource Gate() => new(TaskCreationOptions.RunContinuationsAsynchronously);

    [Fact]
    public void NothingPendingWaitsForNothing()
    {
        var stops = new PendingStops();
        Assert.False(stops.IsStopping("a"));
        Assert.False(stops.AnyInFlight);
        Assert.True(stops.WaitAsync("a").IsCompleted);
        Assert.True(stops.WaitAllAsync().IsCompleted);
    }

    [Fact]
    public async Task WaitHoldsUntilTheStopEnds()
    {
        var stops = new PendingStops();
        var gate = Gate();
        var run = stops.RunAsync("a", () => gate.Task);
        Assert.True(stops.IsStopping("a"));
        Assert.True(stops.AnyInFlight);
        Assert.False(stops.IsStopping("b"));
        Assert.True(stops.WaitAsync("b").IsCompleted);

        var wait = stops.WaitAsync("a");
        Assert.False(wait.IsCompleted);
        gate.SetResult();
        await wait;
        await run;
        Assert.False(stops.IsStopping("a"));
        Assert.False(stops.AnyInFlight);
    }

    [Fact]
    public async Task AnEarlierStopEndingKeepsTheLaterOneTracked()
    {
        var stops = new PendingStops();
        var first = Gate();
        var second = Gate();
        var run1 = stops.RunAsync("a", () => first.Task);
        var run2 = stops.RunAsync("a", () => second.Task);
        first.SetResult();
        await run1;
        Assert.True(stops.IsStopping("a"));
        var wait = stops.WaitAsync("a");
        Assert.False(wait.IsCompleted);
        second.SetResult();
        await wait;
        await run2;
        Assert.False(stops.IsStopping("a"));
    }

    [Fact]
    public async Task AWaitAlsoCoversAStopThatBeganWhileWaiting()
    {
        var stops = new PendingStops();
        var first = Gate();
        var second = Gate();
        var run1 = stops.RunAsync("a", () => first.Task);
        var wait = stops.WaitAsync("a");
        var run2 = stops.RunAsync("a", () => second.Task);
        first.SetResult();
        await run1;
        Assert.False(wait.IsCompleted);
        second.SetResult();
        await wait;
        await run2;
    }

    [Fact]
    public async Task AFailedStopIsSwallowedAndUntracked()
    {
        var stops = new PendingStops();
        await stops.RunAsync("a", () => Task.FromException(new IOException("qmp gone")));
        await stops.RunAsync("b", () => throw new IOException("spawn failed"));
        Assert.False(stops.AnyInFlight);
    }

    [Fact]
    public async Task WaitAllCoversEveryServer()
    {
        var stops = new PendingStops();
        var a = Gate();
        var b = Gate();
        var runA = stops.RunAsync("a", () => a.Task);
        var runB = stops.RunAsync("b", () => b.Task);
        var all = stops.WaitAllAsync();
        a.SetResult();
        await runA;
        Assert.False(all.IsCompleted);
        b.SetResult();
        await all;
        await runB;
        Assert.False(stops.AnyInFlight);
    }
}
