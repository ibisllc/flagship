using System;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace Flagship.Burner;

/// <summary>
/// Talks to the server's ISO-manifest endpoint. Pure-C# port of the sibling
/// burners' manifest client (apps/burner-mac IsoManifestClient.swift,
/// apps/burner-linux iso_manifest_client.py). Same locked wire contract:
///
///   POST https://flagshipserver.com/api/iso-manifest
///   Request  { platform, burnerVersion, current: {version, sha256} | null }
///   Response { download: {url, sha256, version, sizeBytes, attestation} | null }
///
/// The burner is a DUMB EXECUTOR: it reports the SHA256 of whatever base ISO it
/// has cached (or null) and the server decides whether a download is needed. The
/// client NEVER decides by comparing shas itself — it reports `current`, obeys
/// the `download` directive, and verifies the downloaded bytes against
/// `download.sha256`.
/// </summary>
public sealed class IsoManifestClient
{
    /// <summary>The default manifest endpoint. Mirrors the Swift/Python siblings.</summary>
    public const string DefaultEndpoint = "https://flagshipserver.com/api/iso-manifest";

    /// <summary>The platform tag this burner reports.</summary>
    public const string Platform = "windows";

    private readonly HttpClient _http;
    private readonly string _endpoint;

    /// <summary>
    /// <paramref name="handler"/> is injectable so tests can stub the HTTP round
    /// trip without touching the network. Production passes null → a default
    /// HttpClient with no read timeout (the manifest body is tiny, but the
    /// caller may share this client for the large download too).
    /// </summary>
    public IsoManifestClient(
        HttpMessageHandler? handler = null,
        string endpoint = DefaultEndpoint)
    {
        _http = handler != null
            ? new HttpClient(handler, disposeHandler: false)
            : new HttpClient();
        _http.Timeout = TimeSpan.FromSeconds(30);
        _endpoint = endpoint;
    }

    public sealed class ManifestException : Exception
    {
        public ManifestException(string message) : base(message) { }
    }

    /// <summary>The current cached base ISO the burner is reporting, or null.</summary>
    public sealed record Current(string Version, string Sha256);

    /// <summary>The server's download directive (present ⇒ fetch + verify it).</summary>
    public sealed record Download(
        string Url,
        string Sha256,
        string Version,
        long SizeBytes,
        string Attestation);

    /// <summary>The whole response: at most one Download (null ⇒ keep cache).</summary>
    public sealed record ManifestResponse(Download? Download);

    /// <summary>
    /// POST the manifest with the burner version + the currently-cached base (or
    /// null) and return the server's decision. Throws ManifestException on
    /// network failure / non-2xx / unparseable body.
    /// </summary>
    public async Task<ManifestResponse> FetchAsync(
        string burnerVersion,
        Current? current,
        CancellationToken cancellation = default)
    {
        string body = SerializeRequest(burnerVersion, current);
        using var req = new HttpRequestMessage(HttpMethod.Post, _endpoint)
        {
            Content = new StringContent(body, Encoding.UTF8, "application/json"),
        };
        req.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));

        HttpResponseMessage resp;
        try
        {
            resp = await _http.SendAsync(req, HttpCompletionOption.ResponseContentRead, cancellation)
                .ConfigureAwait(false);
        }
        catch (HttpRequestException e)
        {
            throw new ManifestException($"Couldn't reach the image server — check your internet connection. ({e.Message})");
        }
        catch (TaskCanceledException e) when (!cancellation.IsCancellationRequested)
        {
            throw new ManifestException($"Couldn't reach the image server — check your internet connection. ({e.Message})");
        }

        using (resp)
        {
            string text = await resp.Content.ReadAsStringAsync(cancellation).ConfigureAwait(false);
            if (!resp.IsSuccessStatusCode)
                throw new ManifestException($"Image-manifest request failed (HTTP {(int)resp.StatusCode}).");
            return ParseResponse(text);
        }
    }

    /// <summary>
    /// Build the request body exactly per the locked contract. `current` is
    /// emitted as null (literal) when absent. Pure + unit-testable.
    /// </summary>
    public static string SerializeRequest(string burnerVersion, Current? current)
    {
        using var ms = new System.IO.MemoryStream();
        using (var w = new Utf8JsonWriter(ms))
        {
            w.WriteStartObject();
            w.WriteString("platform", Platform);
            w.WriteString("burnerVersion", burnerVersion);
            if (current == null)
            {
                w.WriteNull("current");
            }
            else
            {
                w.WritePropertyName("current");
                w.WriteStartObject();
                w.WriteString("version", current.Version);
                w.WriteString("sha256", current.Sha256);
                w.WriteEndObject();
            }
            w.WriteEndObject();
        }
        return Encoding.UTF8.GetString(ms.ToArray());
    }

    /// <summary>
    /// Parse the response body. Exactly one of `download: {...}` or
    /// `download: null` per the contract. Pure + unit-testable.
    /// </summary>
    public static ManifestResponse ParseResponse(string json)
    {
        JsonDocument doc;
        try { doc = JsonDocument.Parse(json); }
        catch (JsonException e) { throw new ManifestException($"Image manifest was not valid JSON: {e.Message}"); }
        using (doc)
        {
            var root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object)
                throw new ManifestException("Image manifest top-level is not an object.");
            if (!root.TryGetProperty("download", out var dl))
                throw new ManifestException("Image manifest missing \"download\".");
            if (dl.ValueKind == JsonValueKind.Null)
                return new ManifestResponse(null);
            if (dl.ValueKind != JsonValueKind.Object)
                throw new ManifestException("Image-manifest \"download\" is neither an object nor null.");

            string url = ReqStr(dl, "url");
            string sha = ReqStr(dl, "sha256");
            string version = ReqStr(dl, "version");
            long size = ReqLong(dl, "sizeBytes");
            string attestation = ReqStr(dl, "attestation");

            if (!url.StartsWith("https://", StringComparison.Ordinal))
                throw new ManifestException("Image-manifest download URL is not https.");
            if (sha.Length != 64 || Hex.Decode(sha) is not { Length: 32 })
                throw new ManifestException("Image-manifest sha256 is not a 64-char hex digest.");

            return new ManifestResponse(new Download(url, sha.ToLowerInvariant(), version, size, attestation));
        }
    }

    private static string ReqStr(JsonElement el, string name)
    {
        if (!el.TryGetProperty(name, out var v) || v.ValueKind != JsonValueKind.String)
            throw new ManifestException($"Image manifest missing/invalid field \"{name}\".");
        return v.GetString() ?? "";
    }

    private static long ReqLong(JsonElement el, string name)
    {
        if (!el.TryGetProperty(name, out var v) || v.ValueKind != JsonValueKind.Number || !v.TryGetInt64(out var n))
            throw new ManifestException($"Image manifest missing/invalid field \"{name}\".");
        return n;
    }
}
