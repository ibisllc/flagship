using System;
using System.IO;
using System.Net.Http;
using System.Security.Cryptography;
using System.Threading;
using System.Threading.Tasks;

namespace Flagship.Burner;

/// <summary>
/// Manifest-driven base-ISO cache. Pure-C# port of the sibling burners'
/// manifest-driven cache (apps/burner-mac IsoBaseCache.swift,
/// apps/burner-linux iso_base_cache.py). Replaces the retired hardcoded-Alpine
/// BaseIsoCache (recovered for mechanics only via
/// `git show alpine:apps/burner-windows/src/BaseIsoCache.cs`).
///
/// The burner is a DUMB EXECUTOR. On every Simple-mode bake it:
///   1. INSPECTS the cached base ISO (if any): reads its path + SHA256, LOGS them.
///   2. POSTs the manifest with `current` = {version, sha256} or null.
///   3. If `download` is null → keeps the cache, returns the cached path.
///   4. If `download` is non-null → fetches `download.url` (the URL is surfaced
///      to the UI so it appears under the progress bar), stream-verifies the
///      bytes' SHA256 == download.sha256 (mismatch ⇒ delete + error), stores the
///      verified ISO under the platform cache dir, LOGS
///      `downloaded &lt;path&gt; sha256=&lt;hex&gt; from &lt;url&gt;`, and returns it.
///
/// It NEVER decides "do I already have this?" by comparing shas client-side — it
/// reports `current`, obeys the directive, and verifies the bytes it downloads.
/// </summary>
public sealed class IsoBaseCache
{
    private readonly IsoManifestClient _client;
    private readonly HttpMessageHandler? _downloadHandler;
    private readonly string _cacheDir;
    private readonly string _burnerVersion;

    public sealed class CacheException : Exception
    {
        public CacheException(string message) : base(message) { }
    }

    /// <summary>
    /// What a download phase exposes to the UI so the URL + byte progress can be
    /// rendered under the progress bar.
    /// </summary>
    public sealed class DownloadPhase
    {
        public string Url { get; }
        public long TotalBytes { get; }
        public DownloadPhase(string url, long totalBytes) { Url = url; TotalBytes = totalBytes; }
    }

    /// <summary>The result of ensuring a base ISO: the local path + whether a
    /// download actually happened (false ⇒ served from cache).</summary>
    public sealed record EnsureResult(string Path, bool Downloaded);

    /// <param name="manifestHandler">Injectable for tests — stubs the manifest POST.</param>
    /// <param name="downloadHandler">Injectable for tests — stubs the byte download.</param>
    /// <param name="cacheDir">Overridable for tests; defaults to the platform dir.</param>
    /// <param name="burnerVersion">Reported in the manifest request.</param>
    /// <param name="endpoint">Manifest endpoint (default = the production URL).</param>
    public IsoBaseCache(
        HttpMessageHandler? manifestHandler = null,
        HttpMessageHandler? downloadHandler = null,
        string? cacheDir = null,
        string burnerVersion = "0.0.1",
        string endpoint = IsoManifestClient.DefaultEndpoint)
    {
        _client = new IsoManifestClient(manifestHandler, endpoint);
        _downloadHandler = downloadHandler;
        _cacheDir = cacheDir ?? DefaultCacheDir();
        _burnerVersion = burnerVersion;
        Directory.CreateDirectory(_cacheDir);
    }

    /// <summary>%LOCALAPPDATA%\flagship-burner (created on demand).</summary>
    public static string DefaultCacheDir()
    {
        string local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        if (string.IsNullOrEmpty(local))
        {
            // Fallback for non-Windows test/CI hosts that don't populate LocalAppData.
            local = Path.Combine(Path.GetTempPath(), "LocalAppData");
        }
        return Path.Combine(local, "flagship-burner");
    }

    /// <summary>Path a base ISO of <paramref name="version"/> lives at.</summary>
    public string PathFor(string version) =>
        Path.Combine(_cacheDir, $"flagship-base-{version}.iso");

    /// <summary>
    /// The single cached base ISO on disk (the most recently written
    /// flagship-base-*.iso), or null. The manifest server holds the authority on
    /// versions; we just report the bytes we have.
    /// </summary>
    public string? CachedIsoPath()
    {
        try
        {
            string? newest = null;
            DateTime newestTime = DateTime.MinValue;
            foreach (var f in Directory.EnumerateFiles(_cacheDir, "flagship-base-*.iso"))
            {
                var t = File.GetLastWriteTimeUtc(f);
                if (newest == null || t > newestTime) { newest = f; newestTime = t; }
            }
            return newest;
        }
        catch { return null; }
    }

    /// <summary>
    /// Inspect the cached base ISO: returns the (path, sha256, version) of what's
    /// on disk, or null if nothing is cached. SHA256 is computed over the bytes
    /// (NOT trusted from the filename). LOGS the path + sha (or "no base cached").
    /// </summary>
    public async Task<IsoManifestClient.Current?> InspectAsync(
        Action<string>? log = null,
        CancellationToken cancellation = default)
    {
        string? path = CachedIsoPath();
        if (path == null)
        {
            log?.Invoke("no base image cached — will ask the server for one");
            return null;
        }
        string sha = await Sha256FileAsync(path, cancellation).ConfigureAwait(false);
        string version = VersionFromPath(path);
        log?.Invoke($"cached base {path} sha256={sha}");
        return new IsoManifestClient.Current(version, sha);
    }

    /// <summary>
    /// Ensure a base ISO is present per the server manifest, downloading +
    /// verifying on order. Returns the local base ISO path.
    ///
    /// <paramref name="onDownloadStart"/> fires once (with the URL + total bytes)
    /// when a download actually begins — so the UI can reveal the download row
    /// and show the URL under the bar. It does NOT fire on a cache-keep.
    /// <paramref name="progress"/> reports 0…1 during the download only.
    /// <paramref name="log"/> receives the inspect + post-download log lines.
    /// </summary>
    public async Task<EnsureResult> EnsureAsync(
        Action<double> progress,
        Action<DownloadPhase>? onDownloadStart = null,
        Action<string>? log = null,
        CancellationToken cancellation = default)
    {
        // 1. Inspect the cache + report it verbatim (never decide by sha here).
        IsoManifestClient.Current? current = await InspectAsync(log, cancellation).ConfigureAwait(false);

        // 2. Ask the server what to do.
        IsoManifestClient.ManifestResponse manifest;
        try
        {
            manifest = await _client.FetchAsync(_burnerVersion, current, cancellation).ConfigureAwait(false);
        }
        catch (IsoManifestClient.ManifestException e)
        {
            // Offline but we DO have a cached base → use it rather than block a
            // burn. No cache + no manifest → we genuinely can't proceed.
            string? cached = CachedIsoPath();
            if (cached != null)
            {
                log?.Invoke($"image server unreachable ({e.Message}) — using cached base {cached}");
                return new EnsureResult(cached, false);
            }
            throw new CacheException(e.Message);
        }

        // 3. Obey: null download ⇒ keep the cache.
        if (manifest.Download is not IsoManifestClient.Download dl)
        {
            string? cached = CachedIsoPath();
            if (cached == null)
                throw new CacheException("The server reported no base image is needed, but none is cached. Try again.");
            log?.Invoke($"server: no download needed — keeping cached base {cached}");
            return new EnsureResult(cached, false);
        }

        // 4. Download → verify → store.
        string dest = PathFor(dl.Version);
        onDownloadStart?.Invoke(new DownloadPhase(dl.Url, dl.SizeBytes));
        log?.Invoke($"downloading base image from {dl.Url}");
        await DownloadVerifyStoreAsync(dl, dest, progress, cancellation).ConfigureAwait(false);
        progress(1.0);

        log?.Invoke($"downloaded {dest} sha256={dl.Sha256} from {dl.Url}");
        return new EnsureResult(dest, true);
    }

    private async Task DownloadVerifyStoreAsync(
        IsoManifestClient.Download dl,
        string dest,
        Action<double> progress,
        CancellationToken cancellation)
    {
        string tmp = dest + ".partial";
        var http = _downloadHandler != null
            ? new HttpClient(_downloadHandler, disposeHandler: false)
            : new HttpClient();
        http.Timeout = Timeout.InfiniteTimeSpan;

        try
        {
            HttpResponseMessage response;
            try
            {
                response = await http.GetAsync(dl.Url, HttpCompletionOption.ResponseHeadersRead, cancellation)
                    .ConfigureAwait(false);
            }
            catch (HttpRequestException e)
            {
                throw new CacheException($"Couldn't download the base image — check your internet connection. ({e.Message})");
            }
            catch (TaskCanceledException e) when (!cancellation.IsCancellationRequested)
            {
                throw new CacheException($"Couldn't download the base image — check your internet connection. ({e.Message})");
            }

            using (response)
            {
                if (!response.IsSuccessStatusCode)
                    throw new CacheException($"Base-image download failed (HTTP {(int)response.StatusCode}).");

                long expectedLen = response.Content.Headers.ContentLength ?? dl.SizeBytes;
                using var sha = SHA256.Create();
                long received = 0;
                try
                {
                    using (var src = await response.Content.ReadAsStreamAsync(cancellation).ConfigureAwait(false))
                    using (var dst = new FileStream(tmp, FileMode.Create, FileAccess.Write, FileShare.None))
                    {
                        byte[] buffer = new byte[1 << 20];
                        int read;
                        while ((read = await src.ReadAsync(buffer.AsMemory(0, buffer.Length), cancellation).ConfigureAwait(false)) > 0)
                        {
                            await dst.WriteAsync(buffer.AsMemory(0, read), cancellation).ConfigureAwait(false);
                            sha.TransformBlock(buffer, 0, read, null, 0);
                            received += read;
                            if (expectedLen > 0) progress(Math.Min(1.0, (double)received / expectedLen));
                        }
                        sha.TransformFinalBlock(Array.Empty<byte>(), 0, 0);
                    }
                }
                catch (CacheException)
                {
                    TryDelete(tmp);
                    throw;
                }
                catch (HttpRequestException e)
                {
                    TryDelete(tmp);
                    throw new CacheException($"Couldn't download the base image — check your internet connection. ({e.Message})");
                }
                catch (IOException e)
                {
                    TryDelete(tmp);
                    throw new CacheException($"Couldn't download the base image — check your internet connection. ({e.Message})");
                }

                // Stream-verify: mismatch ⇒ delete the partial + error.
                string got = Hex.Encode(sha.Hash!);
                if (!string.Equals(got, dl.Sha256, StringComparison.OrdinalIgnoreCase))
                {
                    TryDelete(tmp);
                    throw new CacheException(
                        $"Base image failed its integrity check (expected {dl.Sha256[..12]}…, got {got[..12]}…). The download was discarded — try again.");
                }
            }

            // Atomic-ish move into place.
            TryDelete(dest);
            File.Move(tmp, dest);
        }
        finally
        {
            if (_downloadHandler == null) http.Dispose();
        }
    }

    // ---- helpers ----

    private static string VersionFromPath(string path)
    {
        string name = Path.GetFileNameWithoutExtension(path); // flagship-base-<version>
        const string prefix = "flagship-base-";
        return name.StartsWith(prefix, StringComparison.Ordinal) ? name[prefix.Length..] : name;
    }

    private static async Task<string> Sha256FileAsync(string path, CancellationToken cancellation)
    {
        using var sha = SHA256.Create();
        using var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read);
        byte[] hash = await sha.ComputeHashAsync(fs, cancellation).ConfigureAwait(false);
        return Hex.Encode(hash);
    }

    private static void TryDelete(string path)
    {
        try { if (File.Exists(path)) File.Delete(path); } catch { /* best effort */ }
    }
}
