using System.Text.Json;

namespace Flagship.Burner.VM;

/// <summary>
/// Reads the UNSIGNED top-level siblings that ride beside the signed blob in
/// the recipe JSON. Mirrors the canonical engine's readSiblings
/// (packages/flagship-burner engine/preseed-engine.js): the sibling lives at
/// the TOP level of the raw recipe document in both shapes — the flattened
/// recipe and the issued {blob, blobSignature, …} envelope — so this reads the
/// raw bytes, not the flattened form RecipeLoader.NormalizeEnvelope produces.
/// </summary>
public static class RecipeSiblings
{
    /// <summary>
    /// The owner-IRK-signed flagship/debug-access/v1 grant, if the phone
    /// baked one in at mint time. Its PRESENCE is the only debug signal the
    /// host app may act on (consent-as-crypto): the box verifies the grant
    /// against the owner IRK; the host merely decides whether a serial
    /// console is worth attaching. Absent ⇒ production ⇒ no console, ever.
    ///
    /// Matches the engine's asStr: a non-empty string is passed through; an
    /// object is stringified; anything else (missing/empty/other types) ⇒ null.
    /// </summary>
    public static string? DebugGrant(byte[] recipeJson)
    {
        try
        {
            using var doc = JsonDocument.Parse(recipeJson);
            var root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object) return null;
            if (!root.TryGetProperty("debugGrant", out var raw)) return null;
            return raw.ValueKind switch
            {
                JsonValueKind.String => string.IsNullOrEmpty(raw.GetString()) ? null : raw.GetString(),
                JsonValueKind.Object => raw.GetRawText(),
                _ => null,
            };
        }
        catch (JsonException)
        {
            return null;
        }
    }
}
