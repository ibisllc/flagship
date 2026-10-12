using System;
using System.Threading.Tasks;
using Xunit;
using Flagship.Builder;

namespace Flagship.Builder.Tests;

/// <summary>
/// Quitting with a live server holds the close, powers the servers off, then
/// closes for real; quitting with none closes at once.
/// </summary>
public sealed class QuitGateTests
{
    [Fact]
    public void NoLiveServersClosesAtOnce()
    {
        var shutdowns = 0;
        var closes = 0;
        var gate = new QuitGate(() => false, () => { shutdowns++; return Task.CompletedTask; }, () => closes++);
        Assert.False(gate.ShouldHoldClose());
        Assert.False(gate.IsShuttingDown);
        Assert.Equal(0, shutdowns);
        Assert.Equal(0, closes);
    }

    [Fact]
    public async Task LiveServersHoldTheCloseUntilTheyAreOff()
    {
        var shutdowns = 0;
        var closes = 0;
        var off = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var closed = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var gate = new QuitGate(
            () => true,
            () => { shutdowns++; return off.Task; },
            () => { closes++; closed.TrySetResult(); });

        Assert.True(gate.ShouldHoldClose());
        Assert.True(gate.IsShuttingDown);
        // A second Quit while shutting down is held too, without a second shutdown.
        Assert.True(gate.ShouldHoldClose());
        Assert.Equal(1, shutdowns);
        Assert.Equal(0, closes);

        off.SetResult();
        await closed.Task.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Equal(1, closes);
        Assert.False(gate.IsShuttingDown);
        // The close it then issues goes through, even if a server is still listed.
        Assert.False(gate.ShouldHoldClose());
        Assert.Equal(1, shutdowns);
    }

    [Fact]
    public void AFailedShutdownStillQuits()
    {
        var closes = 0;
        var gate = new QuitGate(() => true, () => Task.FromException(new InvalidOperationException()), () => closes++);
        Assert.True(gate.ShouldHoldClose());
        Assert.Equal(1, closes);
        Assert.False(gate.ShouldHoldClose());

        var throwingCloses = 0;
        var throwing = new QuitGate(() => true, () => throw new InvalidOperationException(), () => throwingCloses++);
        Assert.True(throwing.ShouldHoldClose());
        Assert.Equal(1, throwingCloses);
    }

    [Fact]
    public void LivenessIsCheckedAtEachClose()
    {
        var live = false;
        var gate = new QuitGate(() => live, () => new TaskCompletionSource().Task, () => { });
        Assert.False(gate.ShouldHoldClose());
        live = true;
        Assert.True(gate.ShouldHoldClose());
    }
}
