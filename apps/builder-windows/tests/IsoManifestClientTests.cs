using System;
using System.Net;
using System.Net.Http;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Xunit;
using Flagship.Builder;

namespace Flagship.Builder.Tests;

/// <summary>
/// IsoManifestClient pins — the locked wire contract for POST /api/iso-manifest.
/// Request shape, response parsing (download present / null), validation, and a
/// full round trip against a stubbed HTTP handler that asserts the request body.
/// Mirrors the Swift/Python siblings' manifest-client tests.
/// </summary>
public class IsoManifestClientTests
{
    [Fact]
    public void SerializeRequest_WithCurrent_EmitsContract()
    {
        var json = IsoManifestClient.SerializeRequest(
            "1.2.3",
            new IsoManifestClient.Current("debian-12.5", new string('a', 64)));
        using var doc = JsonDocument.Parse(json);
        var root = doc.RootElement;
        Assert.Equal("windows", root.GetProperty("platform").GetString());
        Assert.Equal("1.2.3", root.GetProperty("builderVersion").GetString());
        var cur = root.GetProperty("current");
        Assert.Equal(JsonValueKind.Object, cur.ValueKind);
        Assert.Equal("debian-12.5", cur.GetProperty("version").GetString());
        Assert.Equal(new string('a', 64), cur.GetProperty("sha256").GetString());
    }

    [Fact]
    public void SerializeRequest_NoCurrent_EmitsNull()
    {
        var json = IsoManifestClient.SerializeRequest("1.2.3", null);
        using var doc = JsonDocument.Parse(json);
        var root = doc.RootElement;
        Assert.Equal("windows", root.GetProperty("platform").GetString());
        Assert.Equal(JsonValueKind.Null, root.GetProperty("current").ValueKind);
    }

    [Fact]
    public void ParseResponse_NullDownload_KeepsCache()
    {
        var resp = IsoManifestClient.ParseResponse("{\"download\":null}");
        Assert.Null(resp.Download);
    }

    [Fact]
    public void ParseResponse_DownloadPresent_AllFields()
    {
        string sha = new string('b', 64);
        string body =
            "{\"download\":{" +
            "\"url\":\"https://flagshipserver.com/build/iso/flagship-base-debian.iso\"," +
            $"\"sha256\":\"{sha}\"," +
            "\"version\":\"debian-12.5\"," +
            "\"sizeBytes\":640000000," +
            "\"attestation\":\"https://flagshipserver.com/attest/debian-12.5.json\"}}";
        var resp = IsoManifestClient.ParseResponse(body);
        Assert.NotNull(resp.Download);
        Assert.Equal("https://flagshipserver.com/build/iso/flagship-base-debian.iso", resp.Download!.Url);
        Assert.Equal(sha, resp.Download.Sha256);
        Assert.Equal("debian-12.5", resp.Download.Version);
        Assert.Equal(640000000L, resp.Download.SizeBytes);
        Assert.Equal("https://flagshipserver.com/attest/debian-12.5.json", resp.Download.Attestation);
    }

    [Fact]
    public void ParseResponse_RejectsNonHttpsUrl()
    {
        string sha = new string('c', 64);
        string body =
            "{\"download\":{\"url\":\"http://evil/x.iso\",\"sha256\":\"" + sha +
            "\",\"version\":\"v\",\"sizeBytes\":1,\"attestation\":\"https://a\"}}";
        Assert.Throws<IsoManifestClient.ManifestException>(() => IsoManifestClient.ParseResponse(body));
    }

    [Fact]
    public void ParseResponse_RejectsBadSha()
    {
        string body =
            "{\"download\":{\"url\":\"https://x/x.iso\",\"sha256\":\"deadbeef\"," +
            "\"version\":\"v\",\"sizeBytes\":1,\"attestation\":\"https://a\"}}";
        Assert.Throws<IsoManifestClient.ManifestException>(() => IsoManifestClient.ParseResponse(body));
    }

    [Fact]
    public void ParseResponse_RejectsMissingDownloadKey()
    {
        Assert.Throws<IsoManifestClient.ManifestException>(() => IsoManifestClient.ParseResponse("{}"));
    }

    [Fact]
    public void ParseResponse_RejectsNonJson()
    {
        Assert.Throws<IsoManifestClient.ManifestException>(() => IsoManifestClient.ParseResponse("not json"));
    }

    [Fact]
    public async Task FetchAsync_PostsContractAndParsesNull()
    {
        string? capturedBody = null;
        string? capturedUrl = null;
        var handler = new StubHandler(async (req, ct) =>
        {
            capturedUrl = req.RequestUri?.ToString();
            capturedBody = req.Content == null ? null : await req.Content.ReadAsStringAsync(ct);
            return new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent("{\"download\":null}"),
            };
        });
        var client = new IsoManifestClient(handler, "https://example.test/api/iso-manifest");
        var resp = await client.FetchAsync("9.9.9", new IsoManifestClient.Current("v1", new string('a', 64)));
        Assert.Null(resp.Download);
        Assert.Equal("https://example.test/api/iso-manifest", capturedUrl);
        Assert.NotNull(capturedBody);
        using var doc = JsonDocument.Parse(capturedBody!);
        Assert.Equal("windows", doc.RootElement.GetProperty("platform").GetString());
        Assert.Equal("9.9.9", doc.RootElement.GetProperty("builderVersion").GetString());
        Assert.Equal("v1", doc.RootElement.GetProperty("current").GetProperty("version").GetString());
    }

    [Fact]
    public async Task FetchAsync_NonSuccess_Throws()
    {
        var handler = new StubHandler((req, ct) =>
            Task.FromResult(new HttpResponseMessage(HttpStatusCode.InternalServerError)
            {
                Content = new StringContent("boom"),
            }));
        var client = new IsoManifestClient(handler, "https://example.test/api/iso-manifest");
        await Assert.ThrowsAsync<IsoManifestClient.ManifestException>(
            () => client.FetchAsync("1.0.0", null));
    }

    /// <summary>A trivial stubbed handler returning canned responses for tests.</summary>
    internal sealed class StubHandler : HttpMessageHandler
    {
        private readonly Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> _fn;
        public StubHandler(Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> fn) => _fn = fn;
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
            => _fn(request, cancellationToken);
    }
}
