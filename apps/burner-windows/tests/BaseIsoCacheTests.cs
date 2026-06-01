using System;
using System.IO;
using Xunit;
using Flagship.Burner;

namespace Flagship.Burner.Tests;

/// <summary>
/// BaseIsoCache pins — the version + sha256 + cache path the box and the
/// download path both agree on. The actual download is network-bound and not
/// exercised here; EnsureAsync's cache-hit path (return existing file without
/// re-download) is.
/// </summary>
public class BaseIsoCacheTests
{
    [Fact]
    public void PinnedConstantsMatchServer()
    {
        Assert.Equal("alpine-3.21.0", BaseIsoCache.Version);
        Assert.Equal("f63e57b0ad4a94444f3141bf29877dbe4502553725b7c883900215ad4d3c08cd", BaseIsoCache.Sha256Hex);
        Assert.Equal("https://flagshipserver.com/build/iso/flagship-alpine-base.iso", BaseIsoCache.Url);
    }

    [Fact]
    public void CachedPath_NamesByVersionAndLivesUnderFlagshipBurner()
    {
        var path = BaseIsoCache.CachedPath();
        Assert.EndsWith("flagship-base-alpine-3.21.0.iso", path);
        Assert.Contains("flagship-burner", path);
        // CachedPath must create the directory so the caller can write into it.
        Assert.True(Directory.Exists(Path.GetDirectoryName(path)));
    }

    [Fact]
    public async System.Threading.Tasks.Task EnsureAsync_ReturnsCachedWithoutDownload()
    {
        // Seed the cache with a placeholder; EnsureAsync must return it verbatim
        // and must NOT fire onDownloadStart (no network round-trip).
        var path = BaseIsoCache.CachedPath();
        bool existed = File.Exists(path);
        if (!existed) File.WriteAllBytes(path, new byte[] { 1, 2, 3 });
        try
        {
            bool downloadStarted = false;
            var result = await BaseIsoCache.EnsureAsync(
                progress: _ => { },
                onDownloadStart: () => downloadStarted = true);
            Assert.Equal(path, result);
            Assert.False(downloadStarted);
        }
        finally
        {
            if (!existed) { try { File.Delete(path); } catch { } }
        }
    }
}
