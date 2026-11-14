using Flagship.Builder;
using Xunit;

namespace Flagship.Builder.Tests;

/// <summary>W10: the elevated copy learns which copy to wait for and which servers to start again.</summary>
public class ElevationHandoffTests
{
    [Fact]
    public void RoundTripsThePidAndTheServersToResume()
    {
        var args = ElevationHandoff.Arguments(4242, new[] { "home", "lab-2", "home" });
        Assert.Equal("--after-elevation 4242 --resume home,lab-2", args);
        var parsed = ElevationHandoff.Parse(args.Split(' '));
        Assert.NotNull(parsed);
        Assert.Equal(4242, parsed!.Pid);
        Assert.Equal(new[] { "home", "lab-2" }, parsed.Resume);
    }

    [Fact]
    public void NoServersRunningStillWaitsForTheOldCopy()
    {
        var args = ElevationHandoff.Arguments(7, System.Array.Empty<string>());
        Assert.Equal("--after-elevation 7", args);
        Assert.Empty(ElevationHandoff.Parse(args.Split(' '))!.Resume);
    }

    [Fact]
    public void AnOrdinaryStartOrABadNameIsNotAHandoff()
    {
        Assert.Null(ElevationHandoff.Parse(System.Array.Empty<string>()));
        Assert.Null(ElevationHandoff.Parse(new[] { "--after-elevation", "x" }));
        var parsed = ElevationHandoff.Parse(new[] { "--after-elevation", "9", "--resume", "home,../evil,Bad Name" });
        Assert.Equal(new[] { "home" }, parsed!.Resume);
    }
}
