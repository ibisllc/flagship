using System;
using System.Text.Json;

namespace Flagship.Burner;

/// <summary>
/// Parsed `flagship-burn verify` JSON output. Mirror of
/// VerifyResult.swift / parse_verify_json() in burner-linux.
///
/// The CLI prints a small JSON object on success:
///   {
///     "ok": true,
///     "source": "blob",
///     "serverDomain": "alice.flagship.services",
///     "username": "alice",
///     "serverName": "kitchen",
///     "expiresAt": "2026-06-20T10:11:12.000Z",
///     "installerGitRef": "v0.1.0",
///     "signatureValid": true
///   }
///
/// We tolerate noise before the JSON (the CLI logs may prefix
/// timestamps in some configurations). Brace-balance scan picks the
/// first balanced object out of the stream.
/// </summary>
public sealed record VerifyResult
{
    public bool Ok { get; init; }
    public string ServerDomain { get; init; } = "";
    public string? Username { get; init; }
    public string? ServerName { get; init; }
    public string? ExpiresAt { get; init; }
    public string? InstallerGitRef { get; init; }
    public bool? SignatureValid { get; init; }

    public static VerifyResult? Parse(string text)
    {
        if (string.IsNullOrEmpty(text)) return null;
        var slice = ExtractFirstJsonObject(text);
        if (slice == null) return null;
        try
        {
            using var doc = JsonDocument.Parse(slice);
            var root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object) return null;
            return new VerifyResult
            {
                Ok = root.TryGetProperty("ok", out var ok) && ok.ValueKind == JsonValueKind.True,
                ServerDomain = TryString(root, "serverDomain") ?? "",
                Username = TryString(root, "username"),
                ServerName = TryString(root, "serverName"),
                ExpiresAt = TryString(root, "expiresAt"),
                InstallerGitRef = TryString(root, "installerGitRef"),
                SignatureValid = TryBool(root, "signatureValid"),
            };
        }
        catch (JsonException)
        {
            return null;
        }
    }

    /// <summary>
    /// Tolerant brace-balance extractor. Walks the string from the
    /// first '{' counting depth. Returns the first object whose depth
    /// hits zero. Public so DiskEnumerator tests can reuse it if needed.
    /// </summary>
    public static string? ExtractFirstJsonObject(string text)
    {
        int start = text.IndexOf('{');
        if (start < 0) return null;
        int depth = 0;
        bool inString = false;
        bool escape = false;
        for (int i = start; i < text.Length; i++)
        {
            var c = text[i];
            if (escape) { escape = false; continue; }
            if (inString)
            {
                if (c == '\\') { escape = true; continue; }
                if (c == '"') { inString = false; }
                continue;
            }
            switch (c)
            {
                case '"': inString = true; break;
                case '{': depth++; break;
                case '}':
                    depth--;
                    if (depth == 0)
                    {
                        return text.Substring(start, i - start + 1);
                    }
                    break;
            }
        }
        return null;
    }

    private static string? TryString(JsonElement el, string name)
    {
        if (!el.TryGetProperty(name, out var v)) return null;
        return v.ValueKind == JsonValueKind.String ? v.GetString() : null;
    }

    private static bool? TryBool(JsonElement el, string name)
    {
        if (!el.TryGetProperty(name, out var v)) return null;
        return v.ValueKind switch
        {
            JsonValueKind.True => true,
            JsonValueKind.False => false,
            _ => null,
        };
    }
}
