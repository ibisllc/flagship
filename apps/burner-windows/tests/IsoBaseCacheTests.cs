using System;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Security.Cryptography;
using System.Threading;
using System.Threading.Tasks;
using Xunit;
using Flagship.Burner;

namespace Flagship.Burner.Tests;

/// <summary>
/// IsoBaseCache pins — the manifest-driven cache behaviour: inspect-and-report,
/// keep-on-null, download-and-verify, sha-mismatch ⇒ delete + error. Uses a temp
/// cache dir + stubbed HTTP (manifest handler + download handler) so no network
/// is touched. Mirrors the Swift/Python siblings' base-cache tests.
/// </summary>
public class IsoBaseCacheTests : IDisposable
{
    private readonly string _dir;

    public IsoBaseCacheTests()
    {
        _dir = Path.Combine(Path.GetTempPath(), "flagship-base-cache-tests-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(_dir);
    }

    public void Dispose()
    {
        try { Directory.Delete(_dir, recursive: true); } catch { /* best effort */ }
    }

    private static string Sha256Hex(byte[] bytes)
    {
        using var sha = SHA256.Create();
        return Hex.Encode(sha.ComputeHash(bytes));
    }

    [Fact]
    public void DefaultCacheDir_LivesUnderFlagshipBurner()
    {
        Assert.EndsWith("flagship-burner", IsoBaseCache.DefaultCacheDir());
    }

    [Fact]
    public void PathFor_NamesByVersion()
    {
        var cache = new IsoBaseCache(cacheDir: _dir);
        Assert.EndsWith("flagship-base-debian-12.5.iso", cache.PathFor("debian-12.5"));
    }

    [Fact]
    public async Task Inspect_NoCache_ReturnsNull_AndLogs()
    {
        var cache = new IsoBaseCache(cacheDir: _dir);
        string? logged = null;
        var cur = await cache.InspectAsync(log: m => logged = m);
        Assert.Null(cur);
        Assert.NotNull(logged);
        Assert.Contains("no base", logged!, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task Inspect_WithCache_ReportsPathAndSha()
    {
        var cache = new IsoBaseCache(cacheDir: _dir);
        var bytes = new byte[] { 1, 2, 3, 4 };
        string sha = Sha256Hex(bytes);
        var path = cache.PathFor("debian-12.5");
        File.WriteAllBytes(path, bytes);

        string? logged = null;
        var cur = await cache.InspectAsync(log: m => logged = m);
        Assert.NotNull(cur);
        Assert.Equal("debian-12.5", cur!.Version);
        Assert.Equal(sha, cur.Sha256);
        Assert.Contains(sha, logged!, StringComparison.OrdinalIgnoreCase);
        Assert.Contains(path, logged!);
    }

    [Fact]
    public async Task Ensure_NullDownload_KeepsCache_NoDownloadStart()
    {
        // Seed a cached base; the manifest says "null" ⇒ keep it.
        var cache = new IsoBaseCache(
            manifestHandler: new IsoManifestClientTests.StubHandler((req, ct) =>
                Task.FromResult(Ok("{\"download\":null}"))),
            cacheDir: _dir);
        var bytes = new byte[] { 9, 9, 9 };
        var path = cache.PathFor("debian-12.5");
        File.WriteAllBytes(path, bytes);

        bool downloadStarted = false;
        var result = await cache.EnsureAsync(
            progress: _ => { },
            onDownloadStart: _ => downloadStarted = true);
        Assert.Equal(path, result.Path);
        Assert.False(result.Downloaded);
        Assert.False(downloadStarted);
    }

    [Fact]
    public async Task Ensure_Download_VerifiesAndStores_LogsAndSurfacesUrl()
    {
        var payload = System.Text.Encoding.ASCII.GetBytes("the-debian-base-iso-bytes");
        string sha = Sha256Hex(payload);
        const string url = "https://flagshipserver.com/build/iso/flagship-base-debian.iso";
        string manifest =
            "{\"download\":{\"url\":\"" + url + "\",\"sha256\":\"" + sha +
            "\",\"version\":\"debian-12.5\",\"sizeBytes\":" + payload.Length +
            ",\"attestation\":\"https://flagshipserver.com/attest.json\"}}";

        var cache = new IsoBaseCache(
            manifestHandler: new IsoManifestClientTests.StubHandler((req, ct) => Task.FromResult(Ok(manifest))),
            downloadHandler: new IsoManifestClientTests.StubHandler((req, ct) => Task.FromResult(OkBytes(payload))),
            cacheDir: _dir);

        string? downloadUrl = null;
        var logs = new System.Collections.Generic.List<string>();
        var result = await cache.EnsureAsync(
            progress: _ => { },
            onDownloadStart: phase => downloadUrl = phase.Url,
            log: m => logs.Add(m));

        Assert.True(result.Downloaded);
        Assert.Equal(cache.PathFor("debian-12.5"), result.Path);
        Assert.True(File.Exists(result.Path));
        Assert.Equal(payload, File.ReadAllBytes(result.Path));
        // The URL was surfaced for the UI.
        Assert.Equal(url, downloadUrl);
        // Post-download log: "downloaded <path> sha256=<hex> from <url>".
        Assert.Contains(logs, l =>
            l.Contains("downloaded", StringComparison.OrdinalIgnoreCase) &&
            l.Contains(sha, StringComparison.OrdinalIgnoreCase) &&
            l.Contains(url, StringComparison.Ordinal));
    }

    [Fact]
    public async Task Ensure_ShaMismatch_DeletesPartial_AndThrows()
    {
        var payload = System.Text.Encoding.ASCII.GetBytes("actual-bytes");
        string wrongSha = new string('e', 64); // deliberately not the real digest
        const string url = "https://flagshipserver.com/build/iso/flagship-base-debian.iso";
        string manifest =
            "{\"download\":{\"url\":\"" + url + "\",\"sha256\":\"" + wrongSha +
            "\",\"version\":\"debian-12.5\",\"sizeBytes\":" + payload.Length +
            ",\"attestation\":\"https://a\"}}";

        var cache = new IsoBaseCache(
            manifestHandler: new IsoManifestClientTests.StubHandler((req, ct) => Task.FromResult(Ok(manifest))),
            downloadHandler: new IsoManifestClientTests.StubHandler((req, ct) => Task.FromResult(OkBytes(payload))),
            cacheDir: _dir);

        await Assert.ThrowsAsync<IsoBaseCache.CacheException>(() =>
            cache.EnsureAsync(progress: _ => { }));

        // Neither the final nor the .partial file may survive a mismatch.
        var dest = cache.PathFor("debian-12.5");
        Assert.False(File.Exists(dest));
        Assert.False(File.Exists(dest + ".partial"));
    }

    [Fact]
    public async Task Ensure_ManifestUnreachable_WithCache_UsesCache()
    {
        // Manifest POST throws; a cached base exists ⇒ fall back to it.
        var cache = new IsoBaseCache(
            manifestHandler: new IsoManifestClientTests.StubHandler((req, ct) =>
                Task.FromException<HttpResponseMessage>(new HttpRequestException("offline"))),
            cacheDir: _dir);
        var path = cache.PathFor("debian-12.5");
        File.WriteAllBytes(path, new byte[] { 7, 7 });

        var result = await cache.EnsureAsync(progress: _ => { });
        Assert.Equal(path, result.Path);
        Assert.False(result.Downloaded);
    }

    [Fact]
    public async Task Ensure_ManifestUnreachable_NoCache_Throws()
    {
        var cache = new IsoBaseCache(
            manifestHandler: new IsoManifestClientTests.StubHandler((req, ct) =>
                Task.FromException<HttpResponseMessage>(new HttpRequestException("offline"))),
            cacheDir: _dir);
        await Assert.ThrowsAsync<IsoBaseCache.CacheException>(() =>
            cache.EnsureAsync(progress: _ => { }));
    }

    private static HttpResponseMessage Ok(string json) =>
        new(HttpStatusCode.OK) { Content = new StringContent(json) };

    private static HttpResponseMessage OkBytes(byte[] bytes) =>
        new(HttpStatusCode.OK) { Content = new ByteArrayContent(bytes) };
}
