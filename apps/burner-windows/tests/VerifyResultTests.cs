using Xunit;
using Flagship.Burner;

namespace Flagship.Burner.Tests;

/// <summary>
/// Mirrors VerifyResultTests.swift / parse_verify_json tests in
/// burner-linux. The CLI's verify output is JSON; we must tolerate a
/// noisy prefix because some shells timestamp lines before forwarding
/// them to our pipe.
/// </summary>
public class VerifyResultTests
{
    [Fact]
    public void Parse_HappyPath()
    {
        const string text = """
        {
          "ok": true,
          "source": "blob",
          "serverDomain": "alice.flagship.services",
          "username": "alice",
          "serverName": "kitchen",
          "expiresAt": "2026-06-20T10:11:12.000Z",
          "installerGitRef": "v0.1.0",
          "signatureValid": true
        }
        """;
        var r = VerifyResult.Parse(text);
        Assert.NotNull(r);
        Assert.True(r!.Ok);
        Assert.Equal("alice.flagship.services", r.ServerDomain);
        Assert.Equal("alice", r.Username);
        Assert.Equal("kitchen", r.ServerName);
        Assert.Equal("2026-06-20T10:11:12.000Z", r.ExpiresAt);
        Assert.Equal("v0.1.0", r.InstallerGitRef);
        Assert.True(r.SignatureValid);
    }

    [Fact]
    public void Parse_TolerantOfPrefixNoise()
    {
        const string text = "[2026-05-21 09:11:42] verify start\n" +
            "loading blob from /tmp/recipe.json\n" +
            "{\"ok\":true,\"serverDomain\":\"alice.flagship.services\"}";
        var r = VerifyResult.Parse(text);
        Assert.NotNull(r);
        Assert.Equal("alice.flagship.services", r!.ServerDomain);
    }

    [Fact]
    public void Parse_ReturnsNullOnEmpty()
    {
        Assert.Null(VerifyResult.Parse(""));
        Assert.Null(VerifyResult.Parse("   "));
    }

    [Fact]
    public void Parse_ReturnsNullOnNoOpeningBrace()
    {
        Assert.Null(VerifyResult.Parse("verify failed: bad signature"));
    }

    [Fact]
    public void Parse_ReturnsNullOnUnbalancedBraces()
    {
        Assert.Null(VerifyResult.Parse("{\"ok\":true,\"serverDomain\":\"x\""));
    }

    [Fact]
    public void Parse_PreservesStringWithBraceInValue()
    {
        // A '}' inside a string literal must not end the object early.
        const string text = "{\"ok\":true,\"serverDomain\":\"alice}.flagship.services\"}";
        var r = VerifyResult.Parse(text);
        Assert.NotNull(r);
        Assert.Equal("alice}.flagship.services", r!.ServerDomain);
    }

    [Fact]
    public void Parse_PreservesEscapedQuoteInString()
    {
        const string text = "{\"ok\":true,\"serverDomain\":\"al\\\"ce.flagship\"}";
        var r = VerifyResult.Parse(text);
        Assert.NotNull(r);
        Assert.Equal("al\"ce.flagship", r!.ServerDomain);
    }

    [Fact]
    public void ExtractFirstJsonObject_FindsOuterObjectOnly()
    {
        var slice = VerifyResult.ExtractFirstJsonObject("{ \"a\": {\"b\": 1}, \"c\": 2 } trailing junk");
        Assert.Equal("{ \"a\": {\"b\": 1}, \"c\": 2 }", slice);
    }
}
