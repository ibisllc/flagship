using System;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.Json;
using Xunit;
using Flagship.Builder.VM;

namespace Flagship.Builder.Tests;

/// <summary>First contact: what Studio reads from a hosted VM's server-code port and reports.</summary>
public sealed class ServerCodeSeenTests
{
    private static byte[] Unhex(string h) => Convert.FromHexString(h);

    [Fact]
    public void TheMacMatchesTheSharedVectors()
    {
        using var doc = JsonDocument.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "Resources", "enrollment-vectors.json")));
        var key = Unhex(doc.RootElement.GetProperty("studioConfirmKeyHex").GetString()!);
        foreach (var s in doc.RootElement.GetProperty("seen").EnumerateArray())
        {
            Assert.Equal(s.GetProperty("macHex").GetString(),
                ServerCodeSeen.MacHex(key, s.GetProperty("serverDomain").GetString()!, s.GetProperty("stkPubHex").GetString()!));
        }
        Assert.Null(ServerCodeSeen.MacHex(new byte[16], "home.alice.flagship.services", new string('a', 64)));
    }

    [Fact]
    public void OnlyThisServersWellFormedLineCounts()
    {
        var key = string.Concat(Enumerable.Repeat("ab", 32));
        Assert.Equal(new ServerCodeSeen.Sighting("482913", key),
            ServerCodeSeen.Parse($"flagship-server-code Home.Alice.flagship.services 482913 {key}\n", "home.alice.flagship.services"));
        Assert.Null(ServerCodeSeen.Parse($"flagship-server-code home.bob.flagship.services 482913 {key}", "home.alice.flagship.services"));
        Assert.Null(ServerCodeSeen.Parse($"flagship-server-code home.alice.flagship.services 48291x {key}", "home.alice.flagship.services"));
        Assert.Null(ServerCodeSeen.Parse($"flagship-server-code home.alice.flagship.services 482913 {key.ToUpperInvariant()}", "home.alice.flagship.services"));
        Assert.Equal("482 913", ServerCodeSeen.Pretty("482913"));
    }

    [Fact]
    public void LinesSplitAcrossReadsAndAnOverlongLineIsDropped()
    {
        var s = new ConsoleLineSplitter(maxLine: 32);
        Assert.Empty(s.Feed(Encoding.UTF8.GetBytes("flagship-ser")));
        Assert.Equal(new[] { "flagship-server-code x" }, s.Feed(Encoding.UTF8.GetBytes("ver-code x\nnext")));
        Assert.Empty(s.Feed(Encoding.UTF8.GetBytes(new string('z', 64))));
        Assert.Equal(new[] { "ok" }, s.Feed(Encoding.UTF8.GetBytes("ok\n")));
    }

    [Fact]
    public void TheKeyLivesBesideTheBundleOnlyUntilDeleted()
    {
        var layout = new VMBundleLayout(Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString("N")));
        Directory.CreateDirectory(layout.BundleDir("home.alice.flagship.services"));
        var key = Enumerable.Repeat((byte)0x88, 32).ToArray();
        StudioConfirmKeyFile.Write(key, layout, "home.alice.flagship.services");
        Assert.Equal(key, StudioConfirmKeyFile.Read(layout, "home.alice.flagship.services"));
        StudioConfirmKeyFile.Delete(layout, "home.alice.flagship.services");
        Assert.Null(StudioConfirmKeyFile.Read(layout, "home.alice.flagship.services"));
        Directory.Delete(layout.Root, true);
    }
}
