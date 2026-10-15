using System;
using System.IO;
using System.Linq;
using System.Text;
using Flagship.Builder;
using Xunit;

namespace Flagship.Builder.Tests;

/// <summary>The Wi-Fi store keeps the name as is and the password only in
/// its protected form. DPAPI itself is Windows-only, so a reversible stand-in
/// protects here.</summary>
public sealed class WifiCredentialStoreTests : IDisposable
{
    private readonly string _path = Path.Combine(Path.GetTempPath(), $"wifi-{Guid.NewGuid():N}", "wifi.json");

    private static byte[] Flip(byte[] b) => b.Select(x => (byte)(x ^ 0x5a)).ToArray();

    private WifiCredentialStore Store() => new(_path, Flip, Flip);

    public void Dispose()
    {
        try { Directory.Delete(Path.GetDirectoryName(_path)!, recursive: true); } catch { }
    }

    [Fact]
    public void RoundTripsWithoutStoringThePasswordInTheClear()
    {
        Store().Save("  Home Wi-Fi ", "hunter2-secret");
        Assert.Equal(("Home Wi-Fi", "hunter2-secret"), Store().Load());
        var raw = File.ReadAllText(_path);
        Assert.Contains("Home Wi-Fi", raw);
        Assert.DoesNotContain("hunter2-secret", raw);
    }

    [Fact]
    public void BlankValuesClearTheStore()
    {
        Store().Save("Home", "pw");
        Store().Save(" ", "");
        Assert.False(File.Exists(_path));
        Assert.Equal(("", ""), Store().Load());
    }

    [Fact]
    public void AnUnreadablePasswordLoadsAsNothing()
    {
        Store().Save("Home", "pw");
        var broken = new WifiCredentialStore(_path, Flip, _ => throw new InvalidOperationException("other user"));
        Assert.Equal(("Home", ""), broken.Load());
    }
}
