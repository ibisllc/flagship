using Xunit;
using Flagship.Builder;

namespace Flagship.Builder.Tests;

/// <summary>About shows the one product version (release/version.json).</summary>
public class StudioVersionTests
{
    [Fact]
    public void ARelease_ReadsAsTheProductVersionWithItsLabel()
        => Assert.Equal("0.2 Beta", StudioVersion.Display("0.2.0"));

    [Fact]
    public void ADevBuildAndAPatchRelease_AreShownAsIs()
    {
        Assert.Equal("0.0.0-dev", StudioVersion.Display("0.0.0-dev"));
        Assert.Equal("0.2.1", StudioVersion.Display("0.2.1"));
    }
}
