using System;
using Xunit;

namespace Flagship.Builder.Tests;

/// Windows 10 22H2 is supported with a calm notice (no security updates any more); Windows 11 shows none.
/// Nothing is ever blocked.
public sealed class WindowsSupportTests
{
    [Theory]
    [InlineData("10.0.19045.0", true)]   // Windows 10 22H2
    [InlineData("10.0.19044.0", true)]
    [InlineData("10.0.21999.0", true)]
    [InlineData("10.0.22000.0", false)]  // first Windows 11
    [InlineData("10.0.22631.0", false)]  // Windows 11 23H2
    [InlineData("10.0.26100.0", false)]  // Windows 11 24H2
    [InlineData("6.3.9600.0", false)]
    public void TellsWindows10ByItsBuildNumber(string version, bool windows10)
    {
        Assert.Equal(windows10, WindowsSupport.IsWindows10(Version.Parse(version)));
        Assert.Equal(windows10, WindowsSupport.Notice(Version.Parse(version)) is not null);
    }

    [Fact]
    public void TheNoticeIsTheCatalogSentence()
    {
        Assert.Equal(Strings.T("windows10NoLongerGetsSecurityUpdates"), WindowsSupport.Notice(new Version(10, 0, 19045)));
        Assert.DoesNotContain("windows10NoLongerGetsSecurityUpdates", WindowsSupport.Notice(new Version(10, 0, 19045)));
    }
}
