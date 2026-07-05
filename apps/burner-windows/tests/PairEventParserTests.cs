using Xunit;
using Flagship.Burner;

namespace Flagship.Burner.Tests;

/// <summary>
/// The pure parser for the `FLAGSHIP_PAIR <json>` milestone lines that
/// `flagship-burn pair --emit-events` prints. The shape must track the shared
/// PairEvent union in packages/flagship-burner/src/pair.ts.
/// </summary>
public class PairEventParserTests
{
    [Fact]
    public void ParsesReady()
    {
        var line = "FLAGSHIP_PAIR {\"event\":\"ready\",\"sessionId\":\"abc\",\"humanCode\":\"ABCD-1234\",\"payload\":\"flagship://pair?...\",\"qrTerminal\":\"█▀█\\n▀▀▀\",\"debugRequested\":false}";
        var ev = PairEventParser.TryParse(line);
        Assert.NotNull(ev);
        Assert.Equal("ready", ev!.Event);
        Assert.Equal("ABCD-1234", ev.HumanCode);
        Assert.Contains("█", ev.QrTerminal);
        Assert.False(ev.DebugRequested);
    }

    [Fact]
    public void ParsesPhoneConnectedSas()
    {
        var ev = PairEventParser.TryParse("FLAGSHIP_PAIR {\"event\":\"phone-connected\",\"sas\":\"418 902\"}");
        Assert.NotNull(ev);
        Assert.Equal("phone-connected", ev!.Event);
        Assert.Equal("418 902", ev.Sas);
    }

    [Fact]
    public void ParsesDoneWithDebugGranted()
    {
        var ev = PairEventParser.TryParse("FLAGSHIP_PAIR {\"event\":\"done\",\"recipePath\":\"C:\\\\tmp\\\\r.json\",\"serverDomain\":\"home.harry.flagship.services\",\"debugGranted\":true}");
        Assert.NotNull(ev);
        Assert.Equal("done", ev!.Event);
        Assert.Equal("home.harry.flagship.services", ev.ServerDomain);
        Assert.Equal(@"C:\tmp\r.json", ev.RecipePath);
        Assert.True(ev.DebugGranted);
    }

    [Fact]
    public void ParsesError()
    {
        var ev = PairEventParser.TryParse("FLAGSHIP_PAIR {\"event\":\"error\",\"message\":\"pairing session timed out\"}");
        Assert.NotNull(ev);
        Assert.Equal("error", ev!.Event);
        Assert.Contains("timed out", ev.Message);
    }

    [Fact]
    public void DebugGrantedDefaultsFalseWhenAbsentOrFalse()
    {
        Assert.False(PairEventParser.TryParse("FLAGSHIP_PAIR {\"event\":\"delivered\",\"serverDomain\":\"x.y.flagship.services\"}")!.DebugGranted);
        Assert.False(PairEventParser.TryParse("FLAGSHIP_PAIR {\"event\":\"done\",\"debugGranted\":false}")!.DebugGranted);
    }

    [Theory]
    [InlineData("plain human log line")]
    [InlineData("  Waiting for your phone…")]
    [InlineData("FLAGSHIP_PAIR not-json")]
    [InlineData("FLAGSHIP_PAIR [1,2,3]")]
    [InlineData("FLAGSHIP_PAIR {\"nope\":1}")]
    [InlineData("")]
    public void NonEventLinesReturnNull(string line)
    {
        Assert.Null(PairEventParser.TryParse(line));
    }

    [Fact]
    public void ToleratesLeadingWhitespace()
    {
        var ev = PairEventParser.TryParse("   FLAGSHIP_PAIR {\"event\":\"paired\"}");
        Assert.NotNull(ev);
        Assert.Equal("paired", ev!.Event);
    }
}
