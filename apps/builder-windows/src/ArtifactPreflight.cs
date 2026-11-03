using System;
using System.Linq;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;

namespace Flagship.Builder;

/// <summary>
/// Before Studio makes a server (a hosted VM, a remastered ISO or a USB stick), check that the signed box
/// release the install will download is published. The bootstrap (SEC-INSTALL-001) fetches
/// <c>&lt;control host&gt;/build/iso/flagship-box-&lt;commit12&gt;-&lt;arch&gt;.{tar.gz,manifest.json}</c> and stops for
/// good when it is missing (2026-11-02, home.serene-parrot). Contract: the <c>artifactPreflight</c> section of
/// apps/desktop-shared/golden/vm-core-vectors.json, shared with the Mac and Linux Studios.
/// </summary>
public static class ArtifactPreflight
{
    public enum Verdict { Published, Missing, Unreachable }

    public static readonly TimeSpan Timeout = TimeSpan.FromSeconds(15);

    public static string MissingMessage => Strings.T("softwarePackageNotPublished");
    public static string UnreachableMessage => Strings.T("couldntCheckSoftwarePackage");

    /// <summary>The refusal for a verdict; null when the install may go ahead.</summary>
    public static string? Message(Verdict verdict) => verdict switch
    {
        Verdict.Missing => MissingMessage,
        Verdict.Unreachable => UnreachableMessage,
        _ => null,
    };

    /// <summary>The control plane Studio follows: FLAGSHIP_CONTROL_HOST (the gym), else production.</summary>
    public static string ControlHost()
    {
        var h = Environment.GetEnvironmentVariable("FLAGSHIP_CONTROL_HOST")?.Trim();
        return string.IsNullOrEmpty(h) ? "flagshipserver.com" : h;
    }

    /// <summary>The manifest the bootstrap will download, or null when the recipe names no exact commit or the
    /// architecture is one no box runs (the bootstrap would refuse those too).</summary>
    public static string? ManifestUrl(string controlHost, string? commit, string arch)
    {
        if (commit is null || commit.Length != 40 || !commit.All(c => c is >= '0' and <= '9' or >= 'a' and <= 'f')) return null;
        if (arch != "amd64" && arch != "arm64") return null;
        return $"https://{controlHost}/build/iso/flagship-box-{commit[..12]}-{arch}.manifest.json";
    }

    /// <summary>null status = no answer (timeout, DNS, TLS, offline).</summary>
    public static Verdict VerdictFor(int? httpStatus) => httpStatus switch
    {
        null => Verdict.Unreachable,
        >= 200 and < 300 => Verdict.Published,
        404 or 410 => Verdict.Missing,
        _ => Verdict.Unreachable,
    };

    /// <summary>One HEAD for the manifest of <paramref name="commit"/> on <paramref name="arch"/>.
    /// <paramref name="handler"/> lets tests answer without the network.</summary>
    public static async Task<Verdict> CheckAsync(string? commit, string arch, CancellationToken ct = default,
                                                 HttpMessageHandler? handler = null, string? controlHost = null)
    {
        var url = ManifestUrl(controlHost ?? ControlHost(), commit, arch);
        if (url is null) return Verdict.Missing;
        using var http = handler is null ? new HttpClient() : new HttpClient(handler, disposeHandler: false);
        http.Timeout = Timeout;
        try
        {
            using var request = new HttpRequestMessage(HttpMethod.Head, url);
            request.Headers.CacheControl = new System.Net.Http.Headers.CacheControlHeaderValue { NoCache = true };
            using var response = await http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct);
            return VerdictFor((int)response.StatusCode);
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception)
        {
            return Verdict.Unreachable;
        }
    }
}
