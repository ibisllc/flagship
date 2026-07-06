using System.Text;
using System.Text.Json;
using Xunit;
using Flagship.Burner.VM;

namespace Flagship.Burner.Tests;

/// <summary>
/// Direct port of apps/burner-mac RecipeSiblingsTests.swift: the UNSIGNED
/// debugGrant sibling rides at the TOP level of the raw recipe document, in
/// both the flattened and issued-envelope shapes; presence is the only
/// signal (consent-as-crypto — the box verifies the grant, the host only
/// decides whether to attach a console device).
/// </summary>
public class RecipeSiblingsTests
{
    private static byte[] B(string s) => Encoding.UTF8.GetBytes(s);

    [Fact]
    public void NonEmptyStringPassesThrough()
    {
        var grant = "{\"grant\":{\"purpose\":\"debug-access\"},\"signatureHex\":\"ab\"}";
        var json = JsonSerializer.Serialize(new { version = 2, debugGrant = grant });
        Assert.Equal(grant, RecipeSiblings.DebugGrant(B(json)));
    }

    [Fact]
    public void ObjectFormIsStringified()
    {
        var json = "{\"version\":2,\"debugGrant\":{\"grant\":{\"issuedAt\":1},\"signatureHex\":\"ab\"}}";
        var got = RecipeSiblings.DebugGrant(B(json));
        Assert.NotNull(got);
        // Round-trips as JSON carrying the same fields.
        using var doc = JsonDocument.Parse(got!);
        Assert.Equal("ab", doc.RootElement.GetProperty("signatureHex").GetString());
        Assert.Equal(1, doc.RootElement.GetProperty("grant").GetProperty("issuedAt").GetInt32());
    }

    [Fact]
    public void EnvelopeShapeTopLevelSiblingIsRead()
    {
        var json = "{\"blob\":{\"version\":2},\"blobSignature\":\"f1\",\"debugGrant\":\"g\"}";
        Assert.Equal("g", RecipeSiblings.DebugGrant(B(json)));
    }

    [Fact]
    public void AbsentEmptyOrWrongTypedGrantIsNull()
    {
        Assert.Null(RecipeSiblings.DebugGrant(B("{\"version\":2}")));
        Assert.Null(RecipeSiblings.DebugGrant(B("{\"version\":2,\"debugGrant\":\"\"}")));
        Assert.Null(RecipeSiblings.DebugGrant(B("{\"version\":2,\"debugGrant\":42}")));
        Assert.Null(RecipeSiblings.DebugGrant(B("{\"version\":2,\"debugGrant\":null}")));
        Assert.Null(RecipeSiblings.DebugGrant(B("{\"version\":2,\"debugGrant\":true}")));
        Assert.Null(RecipeSiblings.DebugGrant(B("{\"version\":2,\"debugGrant\":[\"x\"]}")));
    }

    [Fact]
    public void NonObjectRootAndGarbageAreNull()
    {
        Assert.Null(RecipeSiblings.DebugGrant(B("[1,2,3]")));
        Assert.Null(RecipeSiblings.DebugGrant(B("\"just a string\"")));
        Assert.Null(RecipeSiblings.DebugGrant(B("not json at all")));
    }
}
