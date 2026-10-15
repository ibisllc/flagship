using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;

namespace Flagship.Builder.VM;

public sealed class ApplianceCacheException : Exception
{
    /// <summary>unavailable | ref-mismatch | invalid-manifest | offline |
    /// http-status | checksum | insufficient-space</summary>
    public string Kind { get; }

    public ApplianceCacheException(string kind, string message) : base(message) { Kind = kind; }

    /// <summary>Failures that mean "use the installer ISO instead" rather
    /// than "something is wrong with what we downloaded".</summary>
    public bool FallsBackToInstaller => Kind is "unavailable" or "ref-mismatch" or "invalid-manifest";
}

public sealed record AppliancePart(string Name, long SizeBytes, string Sha256);

/// <summary>/downloads/FlagshipVMAppliance-&lt;arch&gt;.json: a compressed qcow2
/// split into parts, plus the hash of the raw disk it expands to.</summary>
public sealed record ApplianceDistribution(
    string Arch, string InstallerGitRef, string Sha256, long SizeBytes,
    IReadOnlyList<AppliancePart> Parts, string RawSha256, long RawSizeBytes)
{
    private static readonly Regex Hex64 = new("^[0-9a-f]{64}$", RegexOptions.CultureInvariant);
    private static readonly Regex PartName = new("^part-[0-9]{2}$", RegexOptions.CultureInvariant);

    public static ApplianceDistribution Parse(byte[] body)
    {
        try
        {
            using var doc = JsonDocument.Parse(body);
            var d = doc.RootElement;
            var parts = d.GetProperty("parts").EnumerateArray()
                .Select(p => new AppliancePart(p.GetProperty("name").GetString()!,
                                               p.GetProperty("sizeBytes").GetInt64(),
                                               p.GetProperty("sha256").GetString()!))
                .ToArray();
            var dist = new ApplianceDistribution(
                d.GetProperty("arch").GetString()!, d.GetProperty("installerGitRef").GetString()!,
                d.GetProperty("sha256").GetString()!, d.GetProperty("sizeBytes").GetInt64(), parts,
                d.GetProperty("rawSha256").GetString()!, d.GetProperty("rawSizeBytes").GetInt64());
            var ok = d.GetProperty("version").GetInt32() == 1
                && d.GetProperty("format").GetString() == "qcow2"
                && Hex64.IsMatch(dist.Sha256) && Hex64.IsMatch(dist.RawSha256)
                && dist.SizeBytes > 0 && dist.RawSizeBytes > 0 && parts.Length > 0
                && parts.All(p => PartName.IsMatch(p.Name) && Hex64.IsMatch(p.Sha256) && p.SizeBytes > 0)
                && parts.Sum(p => p.SizeBytes) == dist.SizeBytes;
            if (ok) return dist;
        }
        catch (Exception e) when (e is JsonException or KeyNotFoundException or InvalidOperationException or FormatException or NullReferenceException) { }
        throw ApplianceCache.Invalid();
    }

    /// <summary>R2 key prefix the factory workflow publishes the parts under.</summary>
    public string KeyPrefix
    {
        get
        {
            var slug = new string(InstallerGitRef.Select(c => char.IsAscii(c) && char.IsLetterOrDigit(c) || c is '.' or '-' ? c : '-').ToArray());
            return $"flagship-vm-appliance-{Arch}-{slug}-{Sha256[..12]}.qcow2";
        }
    }
}

/// <summary>
/// The published prebuilt VM appliance: downloaded once per release, verified,
/// kept, and used as the read-only qcow2 backing file of every new server.
/// Mirrors the Mac ApplianceCache (and apps/builder-linux appliance_cache.py)
/// with one deliberate difference: QEMU reads qcow2 itself, so the verified
/// archive (the concatenated parts) IS the base and nothing is expanded. The
/// trust model is the Mac's: flagshipserver.com names the image over TLS, and
/// every part and the whole archive are checked against that manifest before
/// use. A base stays while any server's overlay still reads from it.
/// </summary>
public sealed class ApplianceCache
{
    public const string DefaultOrigin = "https://flagshipserver.com";
    private const long HeadroomBytes = 2_000_000_000;

    public delegate Task<(byte[] Body, int Status)> FetchFn(string url, CancellationToken ct);
    public delegate Task<int> DownloadFn(string url, Stream sink, CancellationToken ct);

    private readonly string _arch;
    private readonly string _root;
    private readonly string _origin;
    private readonly FetchFn _fetch;
    private readonly DownloadFn _download;
    private readonly Func<string, long?> _freeBytes;
    private readonly Func<ISet<string>> _inUse;
    private readonly Action<string> _log;

    public ApplianceCache(string arch, string? root = null, string origin = DefaultOrigin,
                          FetchFn? fetch = null, DownloadFn? download = null,
                          Func<string, long?>? freeBytes = null, Func<ISet<string>>? inUse = null,
                          Action<string>? log = null)
    {
        _arch = arch;
        _root = root ?? DefaultRoot();
        _origin = origin.TrimEnd('/');
        _fetch = fetch ?? LiveFetchAsync;
        _download = download ?? LiveDownloadAsync;
        _freeBytes = freeBytes ?? LiveFreeBytes;
        _inUse = inUse ?? (() => new HashSet<string>());
        _log = log ?? (_ => { });
    }

    /// <summary>%LOCALAPPDATA%\FlagshipBuilder\Appliances.</summary>
    public static string DefaultRoot()
    {
        var local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        if (string.IsNullOrEmpty(local)) local = Path.Combine(Path.GetTempPath(), "LocalAppData");
        return Path.Combine(local, "FlagshipBuilder", "Appliances");
    }

    public string ArchRoot => Path.Combine(_root, $"appliance-{_arch}");
    public string ManifestUrl => $"{_origin}/downloads/FlagshipVMAppliance-{_arch}.json";

    internal static ApplianceCacheException Invalid() =>
        new("invalid-manifest", "The prebuilt server image's manifest is malformed.");

    /// <summary>A verified base (qcow2) with its runtime manifest beside it
    /// (`&lt;base&gt;.json`). progress(phase, fraction): "download" | "verify" | "ready".</summary>
    public async Task<string> EnsureAsync(string installerGitRef,
                                          Action<string, double?>? progress = null,
                                          CancellationToken ct = default)
    {
        progress ??= (_, _) => { };
        byte[] body;
        int status;
        try
        {
            (body, status) = await _fetch(ManifestUrl, ct).ConfigureAwait(false);
        }
        catch (Exception e) when (e is HttpRequestException or IOException
                                  || (e is TaskCanceledException && !ct.IsCancellationRequested))
        {
            if (NewestReadyBase(installerGitRef) is { } cached)
            {
                _log($"appliance: offline ({e.Message}); using cached {cached}");
                progress("ready", null);
                return cached;
            }
            throw new ApplianceCacheException("offline", $"Couldn't download the prebuilt server image: {e.Message}");
        }
        if (status == 404)
            throw new ApplianceCacheException("unavailable", $"No prebuilt {_arch} server image is published yet.");
        if (status is < 200 or > 299) throw Http(status);
        var dist = ApplianceDistribution.Parse(body);
        if (dist.Arch != _arch) throw Invalid();
        if (dist.InstallerGitRef != installerGitRef)
            throw new ApplianceCacheException("ref-mismatch",
                $"The prebuilt server image is for {dist.InstallerGitRef}, but this recipe installs {installerGitRef}.");

        var dir = Path.Combine(ArchRoot, dist.Sha256[..16]);
        var basePath = Path.Combine(dir, "base.qcow2");
        if (IsReady(basePath, dist.Sha256, dist.SizeBytes))
        {
            _log($"appliance: cached {basePath} sha256={dist.Sha256}");
            Prune(dir);
            progress("ready", null);
            return basePath;
        }

        Directory.CreateDirectory(dir);
        var partial = basePath + ".partial";
        var have = File.Exists(partial) ? new FileInfo(partial).Length : 0;
        var needed = dist.SizeBytes - have + HeadroomBytes;
        if (_freeBytes(dir) is long free && free < needed)
            throw new ApplianceCacheException("insufficient-space",
                $"Not enough free disk space for the server image: needs {needed / 1e9:0.0} GB, {free / 1e9:0.0} GB free.");

        long offset = 0;
        using (File.Open(partial, FileMode.OpenOrCreate)) { }
        foreach (var part in dist.Parts)
        {
            if (RangeSha256(partial, offset, part.SizeBytes) == part.Sha256)
            {
                offset += part.SizeBytes;
                continue;
            }
            Truncate(partial, offset);
            var url = $"{_origin}/build/iso/{dist.KeyPrefix}.{part.Name}";
            var file = new FileStream(partial, FileMode.Append, FileAccess.Write, FileShare.None);
            var sink = new HashingStream(file, len => progress("download", Math.Min(1.0, (double)(offset + len) / dist.SizeBytes)));
            int partStatus;
            try
            {
                partStatus = await _download(url, sink, ct).ConfigureAwait(false);
            }
            catch (Exception e)
            {
                sink.Dispose();
                file.Dispose();
                Truncate(partial, offset);
                if (e is HttpRequestException or IOException || (e is TaskCanceledException && !ct.IsCancellationRequested))
                    throw new ApplianceCacheException("offline", $"Couldn't download the prebuilt server image: {e.Message}");
                throw;
            }
            var got = sink.HexDigest();
            var written = sink.Written;
            sink.Dispose();
            file.Dispose();
            if (partStatus is < 200 or > 299)
            {
                Truncate(partial, offset);
                throw Http(partStatus);
            }
            if (written != part.SizeBytes || got != part.Sha256)
            {
                Truncate(partial, offset);
                throw Checksum(part.Name);
            }
            offset += part.SizeBytes;
        }

        progress("verify", null);
        if (new FileInfo(partial).Length != dist.SizeBytes || RangeSha256(partial, 0, dist.SizeBytes) != dist.Sha256)
        {
            TryDelete(partial);
            throw Checksum("archive");
        }
        File.Move(partial, basePath, overwrite: true);
        var runtime = new ApplianceBaseManifest(1, dist.Arch, dist.InstallerGitRef, dist.Sha256, dist.SizeBytes, dist.RawSizeBytes);
        var tmp = basePath + ".json.tmp";
        File.WriteAllBytes(tmp, JsonSerializer.SerializeToUtf8Bytes(runtime, ApplianceBaseManifest.Json));
        File.Move(tmp, basePath + ".json", overwrite: true);
        Prune(dir);
        _log($"appliance: downloaded {basePath} sha256={dist.Sha256}");
        progress("ready", null);
        return basePath;
    }

    private static ApplianceCacheException Http(int code) =>
        new("http-status", $"The server returned HTTP {code} for the prebuilt server image.");

    private static ApplianceCacheException Checksum(string what) =>
        new("checksum", $"The prebuilt server image failed its integrity check ({what}).");

    // ---- helpers ----

    public bool IsReady(string basePath, string sha256, long size)
        => ApplianceBaseManifest.TryLoad(basePath) is { } m && m.Sha256 == sha256
           && File.Exists(basePath) && new FileInfo(basePath).Length == size;

    public string? NewestReadyBase(string installerGitRef)
    {
        if (!Directory.Exists(ArchRoot)) return null;
        return Directory.EnumerateDirectories(ArchRoot)
            .Select(d => Path.Combine(d, "base.qcow2"))
            .Where(b => ApplianceBaseManifest.TryLoad(b) is { } m && m.InstallerGitRef == installerGitRef
                        && File.Exists(b) && new FileInfo(b).Length == m.SizeBytes)
            .OrderByDescending(File.GetLastWriteTimeUtc)
            .FirstOrDefault();
    }

    /// <summary>Keep one release per arch, plus any older base a server's
    /// overlay still reads from.</summary>
    public void Prune(string keep)
    {
        if (!Directory.Exists(ArchRoot)) return;
        var inUse = _inUse();
        var keepFull = Path.GetFullPath(keep);
        foreach (var dir in Directory.EnumerateDirectories(ArchRoot))
        {
            if (string.Equals(Path.GetFullPath(dir), keepFull, StringComparison.OrdinalIgnoreCase)) continue;
            var basePath = Path.GetFullPath(Path.Combine(dir, "base.qcow2"));
            if (inUse.Any(u => string.Equals(u, basePath, StringComparison.OrdinalIgnoreCase))) continue;
            try
            {
                Directory.Delete(dir, recursive: true);
                _log($"appliance: removed superseded {dir}");
            }
            catch { }
        }
    }

    internal static string? RangeSha256(string path, long offset, long length)
    {
        try
        {
            using var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
            if (fs.Length < offset + length) return null;
            fs.Seek(offset, SeekOrigin.Begin);
            using var sha = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
            var buffer = new byte[1 << 20];
            var remaining = length;
            while (remaining > 0)
            {
                var read = fs.Read(buffer, 0, (int)Math.Min(buffer.Length, remaining));
                if (read <= 0) return null;
                sha.AppendData(buffer, 0, read);
                remaining -= read;
            }
            return Convert.ToHexString(sha.GetHashAndReset()).ToLowerInvariant();
        }
        catch (IOException) { return null; }
    }

    private static void Truncate(string path, long size)
    {
        try
        {
            using var fs = new FileStream(path, FileMode.Open, FileAccess.Write, FileShare.None);
            fs.SetLength(size);
        }
        catch { }
    }

    private static void TryDelete(string path)
    {
        try { File.Delete(path); } catch { }
    }

    // ---- live transport ----

    private static readonly HttpClient Http1 = new() { Timeout = Timeout.InfiniteTimeSpan };

    private static async Task<(byte[] Body, int Status)> LiveFetchAsync(string url, CancellationToken ct)
    {
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        cts.CancelAfter(TimeSpan.FromSeconds(30));
        using var request = new HttpRequestMessage(HttpMethod.Get, url);
        request.Headers.CacheControl = new System.Net.Http.Headers.CacheControlHeaderValue { NoCache = true };
        using var response = await Http1.SendAsync(request, cts.Token).ConfigureAwait(false);
        return (await response.Content.ReadAsByteArrayAsync(cts.Token).ConfigureAwait(false), (int)response.StatusCode);
    }

    private static async Task<int> LiveDownloadAsync(string url, Stream sink, CancellationToken ct)
    {
        using var response = await Http1.GetAsync(url, HttpCompletionOption.ResponseHeadersRead, ct).ConfigureAwait(false);
        if (!response.IsSuccessStatusCode) return (int)response.StatusCode;
        await using var body = await response.Content.ReadAsStreamAsync(ct).ConfigureAwait(false);
        await body.CopyToAsync(sink, 1 << 20, ct).ConfigureAwait(false);
        return (int)response.StatusCode;
    }

    private static long? LiveFreeBytes(string path)
    {
        try { return new DriveInfo(Path.GetPathRoot(Path.GetFullPath(path))!).AvailableFreeSpace; }
        catch { return null; }
    }

    /// <summary>Write-through stream that hashes and counts what passes.</summary>
    private sealed class HashingStream : Stream
    {
        private readonly Stream _inner;
        private readonly IncrementalHash _sha = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        private readonly Action<long> _onWritten;
        public long Written { get; private set; }

        public HashingStream(Stream inner, Action<long> onWritten) { _inner = inner; _onWritten = onWritten; }

        public string HexDigest() => Convert.ToHexString(_sha.GetHashAndReset()).ToLowerInvariant();

        public override void Write(byte[] buffer, int offset, int count)
        {
            _inner.Write(buffer, offset, count);
            _sha.AppendData(buffer, offset, count);
            Written += count;
            _onWritten(Written);
        }

        public override async ValueTask WriteAsync(ReadOnlyMemory<byte> buffer, CancellationToken ct = default)
        {
            await _inner.WriteAsync(buffer, ct).ConfigureAwait(false);
            _sha.AppendData(buffer.Span);
            Written += buffer.Length;
            _onWritten(Written);
        }

        public override Task WriteAsync(byte[] buffer, int offset, int count, CancellationToken ct)
            => WriteAsync(buffer.AsMemory(offset, count), ct).AsTask();

        public override void Flush() => _inner.Flush();
        public override bool CanRead => false;
        public override bool CanSeek => false;
        public override bool CanWrite => true;
        public override long Length => throw new NotSupportedException();
        public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }
        public override int Read(byte[] buffer, int offset, int count) => throw new NotSupportedException();
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();

        protected override void Dispose(bool disposing)
        {
            if (disposing) _sha.Dispose();
            base.Dispose(disposing);
        }
    }
}

/// <summary>The runtime manifest beside a verified base (`&lt;base&gt;.json`).</summary>
public sealed record ApplianceBaseManifest(int Version, string Arch, string InstallerGitRef,
                                           string Sha256, long SizeBytes, long VirtualSizeBytes)
{
    internal static readonly JsonSerializerOptions Json = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };

    public static ApplianceBaseManifest? TryLoad(string basePath)
    {
        try { return JsonSerializer.Deserialize<ApplianceBaseManifest>(File.ReadAllBytes(basePath + ".json"), Json); }
        catch { return null; }
    }
}
