using System;
using System.IO;
using System.Net.Http;
using System.Security.Cryptography;
using System.Threading;
using System.Threading.Tasks;

namespace Flagship.Burner;

/// <summary>
/// One-time base-ISO cache. Pure-C# port of apps/burner-mac BaseIsoCache.swift.
///
/// The burner downloads the stock Flagship Alpine base ISO ONCE, verifies its
/// sha256, and keeps it under %LOCALAPPDATA%\flagship-burner. Every subsequent
/// server reuses the cached copy — no re-download — so the user only ever pays
/// the ~240 MB transfer the first time. The recipe trailer is then appended
/// locally (AlpinePersonalize).
/// </summary>
public static class BaseIsoCache
{
    /// <summary>Pinned base ISO. Bump both together when the base is rebuilt.</summary>
    public const string Version = "alpine-3.21.0";
    public const string Sha256Hex = "f63e57b0ad4a94444f3141bf29877dbe4502553725b7c883900215ad4d3c08cd";

    /// <summary>
    /// Served straight from R2 via the /build/iso/:filename route (returns the
    /// R2 body directly — runtime-native, no truncation).
    /// </summary>
    public const string Url = "https://flagshipserver.com/build/iso/flagship-alpine-base.iso";

    public sealed class CacheException : Exception
    {
        public CacheException(string message) : base(message) { }
    }

    /// <summary>%LOCALAPPDATA%\flagship-burner\flagship-base-alpine-3.21.0.iso</summary>
    public static string CachedPath()
    {
        string local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        if (string.IsNullOrEmpty(local))
        {
            // Fallback for non-Windows test hosts that don't populate LocalAppData.
            local = Path.Combine(Path.GetTempPath(), "LocalAppData");
        }
        string dir = Path.Combine(local, "flagship-burner");
        Directory.CreateDirectory(dir);
        return Path.Combine(dir, $"flagship-base-{Version}.iso");
    }

    /// <summary>
    /// True if a verified base ISO is already cached (so the UI can skip the
    /// "one-time download" phase + its messaging).
    /// </summary>
    public static bool IsCached()
    {
        try { return File.Exists(CachedPath()); }
        catch { return false; }
    }

    /// <summary>
    /// Return the cached base ISO, downloading + verifying it once if absent.
    /// <paramref name="progress"/> is called 0…1 during the download phase only.
    /// <paramref name="onDownloadStart"/> fires once when a download is actually
    /// starting (so the UI can show the one-time-download banner); it does NOT
    /// fire when served from cache.
    /// </summary>
    public static async Task<string> EnsureAsync(
        Action<double> progress,
        Action? onDownloadStart = null,
        CancellationToken cancellation = default)
    {
        string dest = CachedPath();
        if (File.Exists(dest))
        {
            // Trust the cached copy; a corrupt cache surfaces at flash time.
            return dest;
        }
        onDownloadStart?.Invoke();

        string tmp = dest + ".partial";
        using var http = new HttpClient { Timeout = Timeout.InfiniteTimeSpan };

        HttpResponseMessage response;
        try
        {
            response = await http.GetAsync(Url, HttpCompletionOption.ResponseHeadersRead, cancellation)
                .ConfigureAwait(false);
        }
        catch (HttpRequestException e)
        {
            throw new CacheException($"Couldn't download the base image — check your internet connection. ({e.Message})");
        }
        catch (TaskCanceledException e) when (!cancellation.IsCancellationRequested)
        {
            // HttpClient surfaces connect/read timeouts as TaskCanceledException.
            throw new CacheException($"Couldn't download the base image — check your internet connection. ({e.Message})");
        }

        using (response)
        {
            if (!response.IsSuccessStatusCode)
                throw new CacheException($"Base-image download failed (HTTP {(int)response.StatusCode}).");

            long expectedLen = response.Content.Headers.ContentLength ?? -1;

            using var sha = SHA256.Create();
            long received = 0;
            try
            {
                using var src = await response.Content.ReadAsStreamAsync(cancellation).ConfigureAwait(false);
                using var dst = new FileStream(tmp, FileMode.Create, FileAccess.Write, FileShare.None);
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
            progress(1.0);

            string got = Hex.Encode(sha.Hash!);
            if (!string.Equals(got, Sha256Hex, StringComparison.Ordinal))
            {
                TryDelete(tmp);
                throw new CacheException(
                    $"Base image failed its integrity check (expected {Sha256Hex[..12]}…, got {got[..12]}…). Try again.");
            }
        }

        // Atomic-ish move into place.
        TryDelete(dest);
        File.Move(tmp, dest);
        return dest;
    }

    private static void TryDelete(string path)
    {
        try { if (File.Exists(path)) File.Delete(path); } catch { /* best effort */ }
    }
}
