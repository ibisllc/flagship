using System;
using System.IO;
using System.Text;
using System.Text.Json;

namespace Flagship.Burner;

/// <summary>
/// A phone-signed install recipe (InstallBlob v2). Parsing + verification is
/// a pure-C# reimplementation of packages/flagship-burner loadBlob +
/// @flagship/protocol verifyInstallBlob, mirroring
/// apps/burner-mac Recipe.swift byte-for-byte. The canonical-byte layout
/// MUST match the TypeScript exactly or signatures fail.
/// </summary>
public sealed record RecipeAuthCode
{
    public int Version { get; init; }
    public string Serial { get; init; } = "";
    public string Username { get; init; } = "";
    public string ServerName { get; init; } = "";
    public string ServerDomain { get; init; } = "";
    public string DelegatedPubKeyHex { get; init; } = "";
    public string UserPubKeyHex { get; init; } = "";
    public long IssuedAt { get; init; }
    public long ExpiresAt { get; init; }
}

public sealed record Recipe
{
    public int Version { get; init; }
    public string ServerDomain { get; init; } = "";
    public string Username { get; init; } = "";
    public string ServerName { get; init; } = "";
    public string PhoneDelegatedPubKeyHex { get; init; } = "";
    public string RegistrationUrl { get; init; } = "";
    public RecipeAuthCode AuthCode { get; init; } = new();
    public string AuthCodeUserSignatureHex { get; init; } = "";
    public string InstallerGitRef { get; init; } = "";
    public string RckPubKeyHex { get; init; } = "";
    public string BlobSignatureHex { get; init; } = "";

    /// <summary>
    /// Boot-unlock policy (docs/security-phone-as-unlock-endpoint.md §7a.1).
    /// Phone-signed in the blob; null (absent) ⇒ treat as "auto" (default).
    /// OPTIONAL so the canonical-bytes match the TS exactly.
    /// </summary>
    public string? BootUnlockMode { get; init; }

    /// <summary>The effective mode the box bakes/dispatches on (absence ⇒ "auto").</summary>
    public string EffectiveBootUnlockMode => BootUnlockMode == "approve" ? "approve" : "auto";

    /// <summary>
    /// Disk-encryption policy — phone-signed; null (absent) omits it from the
    /// canonical bytes. Mirrors @flagship/protocol InstallBlob.diskEncryption.
    /// null ⇒ "luks" (the box encrypts unless the recipe explicitly says "none").
    /// </summary>
    public string? DiskEncryption { get; init; }

    /// <summary>
    /// Whether the box should LUKS-encrypt the root. Absence ⇒ encrypted; only
    /// an explicit "none" opts out (the Wi-Fi-only fallback).
    /// </summary>
    public bool EncryptsDisk => DiskEncryption != "none";

    public DateTimeOffset ExpiresAtDate =>
        DateTimeOffset.FromUnixTimeMilliseconds(AuthCode.ExpiresAt);
}

public sealed class RecipeException : Exception
{
    public RecipeException(string message) : base(message) { }
}

public static class RecipeLoader
{
    public static Recipe Load(string path, DateTimeOffset? now = null)
    {
        byte[] data;
        try { data = File.ReadAllBytes(path); }
        catch (Exception e)
        {
            throw new RecipeException($"Not a valid recipe: cannot read {Path.GetFileName(path)}: {e.Message}");
        }
        return Load(data, now);
    }

    public static Recipe Load(byte[] data, DateTimeOffset? now = null)
    {
        var at = now ?? DateTimeOffset.UtcNow;
        var recipe = Parse(data);
        if (recipe.Version != 2)
            throw new RecipeException($"Unsupported recipe version {recipe.Version} (expected 2).");
        // v2: the auth-code expiry is the recipe expiry. Refuse before any work.
        long nowMs = at.ToUnixTimeMilliseconds();
        if (nowMs > recipe.AuthCode.ExpiresAt)
            throw new RecipeException($"This recipe expired {recipe.ExpiresAtDate.LocalDateTime:g}.");
        if (!VerifySignature(recipe))
            throw new RecipeException("The recipe's signature doesn't verify — it may be tampered or corrupt.");
        return recipe;
    }

    /// <summary>
    /// canonicalInstallBlob — must match @flagship/protocol byte-for-byte.
    /// Hex fields are lowercased to mirror the TS `hex(bytes)` output.
    /// </summary>
    public static byte[] CanonicalBytes(Recipe r)
    {
        var parts = new System.Collections.Generic.List<string>
        {
            "flagship/install-blob/v1",
            r.Version.ToString(System.Globalization.CultureInfo.InvariantCulture),
            r.ServerDomain,
            r.Username,
            r.ServerName,
            r.PhoneDelegatedPubKeyHex.ToLowerInvariant(),
            r.RegistrationUrl,
            r.AuthCode.Serial,
            r.AuthCode.UserPubKeyHex.ToLowerInvariant(),
            r.AuthCodeUserSignatureHex.ToLowerInvariant(),
            r.InstallerGitRef,
            r.RckPubKeyHex.ToLowerInvariant(),
        };
        // Backward-compatible extension (matches @flagship/protocol exactly): a
        // blob WITHOUT bootUnlockMode produces the pre-existing canonical bytes
        // (old signatures keep verifying); present ⇒ appended.
        if (r.BootUnlockMode != null) parts.Add(r.BootUnlockMode);
        // diskEncryption appended after bootUnlockMode with a `de=` prefix. MUST
        // match @flagship/protocol canonicalInstallBlob byte-for-byte.
        if (r.DiskEncryption != null) parts.Add($"de={r.DiskEncryption}");
        return Encoding.UTF8.GetBytes(string.Join("|", parts));
    }

    public static bool VerifySignature(Recipe r)
    {
        var pub = Hex.Decode(r.AuthCode.UserPubKeyHex);
        var sig = Hex.Decode(r.BlobSignatureHex);
        if (pub == null || pub.Length != 32 || sig == null || sig.Length != 64) return false;
        return Ed25519Verify.Verify(sig, CanonicalBytes(r), pub);
    }

    // ---- JSON ----

    /// <summary>
    /// Accept both the flattened recipe and the issued envelope that .com /
    /// the website hand out: { "blob": {…}, "blobSignature": "…" }. The
    /// envelope is flattened (blob fields + blobSignatureHex) before decoding.
    /// </summary>
    private static byte[] NormalizeEnvelope(byte[] data)
    {
        try
        {
            using var doc = JsonDocument.Parse(data);
            var root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object) return data;
            if (root.TryGetProperty("blob", out var blob) &&
                blob.ValueKind == JsonValueKind.Object &&
                root.TryGetProperty("blobSignature", out var sig) &&
                sig.ValueKind == JsonValueKind.String)
            {
                // Re-serialize blob with blobSignatureHex spliced in.
                using var ms = new MemoryStream();
                using (var w = new Utf8JsonWriter(ms))
                {
                    w.WriteStartObject();
                    foreach (var prop in blob.EnumerateObject())
                        prop.WriteTo(w);
                    w.WriteString("blobSignatureHex", sig.GetString());
                    w.WriteEndObject();
                }
                return ms.ToArray();
            }
        }
        catch (JsonException) { /* fall through to raw */ }
        return data;
    }

    private static Recipe Parse(byte[] data)
    {
        JsonDocument doc;
        try { doc = JsonDocument.Parse(NormalizeEnvelope(data)); }
        catch (JsonException e) { throw new RecipeException($"Not a valid recipe: {e.Message}"); }
        using (doc)
        {
            var root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object)
                throw new RecipeException("Not a valid recipe: top-level is not an object.");

            string topUsername = ReqStr(root, "username");
            string topServerName = ReqStr(root, "serverName");
            string topServerDomain = ReqStr(root, "serverDomain");
            string phoneDelegated = ReqStr(root, "phoneDelegatedPubKey");

            if (!root.TryGetProperty("authCode", out var ac) || ac.ValueKind != JsonValueKind.Object)
                throw new RecipeException("Not a valid recipe: missing authCode.");

            var authCode = new RecipeAuthCode
            {
                Version = OptInt(ac, "version") ?? 1,
                Serial = ReqStr(ac, "serial"),
                Username = OptStr(ac, "username") ?? topUsername,
                ServerName = OptStr(ac, "serverName") ?? topServerName,
                ServerDomain = OptStr(ac, "serverDomain") ?? topServerDomain,
                DelegatedPubKeyHex = OptStr(ac, "delegatedPubKey") ?? phoneDelegated,
                UserPubKeyHex = ReqStr(ac, "userPubKey"),
                IssuedAt = ReqLong(ac, "issuedAt"),
                ExpiresAt = ReqLong(ac, "expiresAt"),
            };

            return new Recipe
            {
                Version = ReqInt(root, "version"),
                ServerDomain = topServerDomain,
                Username = topUsername,
                ServerName = topServerName,
                PhoneDelegatedPubKeyHex = phoneDelegated,
                RegistrationUrl = ReqStr(root, "registrationUrl"),
                AuthCode = authCode,
                AuthCodeUserSignatureHex = ReqStr(root, "authCodeUserSignature"),
                InstallerGitRef = OptStr(root, "installerGitRef") ?? "",
                RckPubKeyHex = ReqStr(root, "rckPubKey"),
                BlobSignatureHex = ReqStr(root, "blobSignatureHex"),
                BootUnlockMode = OptStr(root, "bootUnlockMode"),
                DiskEncryption = OptStr(root, "diskEncryption"),
            };
        }
    }

    private static string ReqStr(JsonElement el, string name)
    {
        if (!el.TryGetProperty(name, out var v) || v.ValueKind != JsonValueKind.String)
            throw new RecipeException($"Not a valid recipe: missing field \"{name}\".");
        return v.GetString() ?? "";
    }

    private static string? OptStr(JsonElement el, string name)
        => el.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

    private static int ReqInt(JsonElement el, string name)
    {
        if (!el.TryGetProperty(name, out var v) || v.ValueKind != JsonValueKind.Number || !v.TryGetInt32(out var n))
            throw new RecipeException($"Not a valid recipe: missing/invalid field \"{name}\".");
        return n;
    }

    private static int? OptInt(JsonElement el, string name)
        => el.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Number && v.TryGetInt32(out var n) ? n : null;

    private static long ReqLong(JsonElement el, string name)
    {
        if (!el.TryGetProperty(name, out var v) || v.ValueKind != JsonValueKind.Number || !v.TryGetInt64(out var n))
            throw new RecipeException($"Not a valid recipe: missing/invalid field \"{name}\".");
        return n;
    }
}

/// <summary>Hex codec mirroring the Swift Data(hexString:) / .hexString helpers.</summary>
public static class Hex
{
    public static byte[]? Decode(string s)
    {
        if (s.Length % 2 != 0) return null;
        var outBuf = new byte[s.Length / 2];
        for (int i = 0; i < outBuf.Length; i++)
        {
            int hi = FromHex(s[i * 2]);
            int lo = FromHex(s[i * 2 + 1]);
            if (hi < 0 || lo < 0) return null;
            outBuf[i] = (byte)((hi << 4) | lo);
        }
        return outBuf;
    }

    public static string Encode(ReadOnlySpan<byte> bytes)
    {
        var sb = new StringBuilder(bytes.Length * 2);
        foreach (var b in bytes) sb.Append(b.ToString("x2", System.Globalization.CultureInfo.InvariantCulture));
        return sb.ToString();
    }

    private static int FromHex(char c)
    {
        if (c >= '0' && c <= '9') return c - '0';
        if (c >= 'a' && c <= 'f') return c - 'a' + 10;
        if (c >= 'A' && c <= 'F') return c - 'A' + 10;
        return -1;
    }
}

/// <summary>
/// Which assembly flow the wizard runs. Mirrors apps/burner-mac BurnerMode.swift
/// and apps/burner-linux's BurnerMode.
///
/// - Simple (default): the user supplies only a recipe. The burner fetches the
///   stock Debian-netinst base ISO per the SERVER manifest (cached, verified by
///   sha256), then runs the SAME remaster+flash path Advanced uses — the recipe
///   preseed is baked into the fetched base, then flashed. No user ISO.
/// - Advanced: the user supplies their own stock Debian/Ubuntu ISO + a JSON
///   recipe; the burner remasters that ISO in-place (via the Node CLI) then
///   flashes.
/// </summary>
public enum BurnerMode { Simple, Advanced }

public static class BurnerModeExtensions
{
    public static bool RequiresRecipe(this BurnerMode m) => true;

    /// <summary>Simple fetches the base from the server; only Advanced needs a user ISO.</summary>
    public static bool RequiresUserISO(this BurnerMode m) => m == BurnerMode.Advanced;

    public static string BakeCtaLabel(this BurnerMode m) =>
        m == BurnerMode.Simple ? "Flash to USB" : "Assemble and flash";

    public static string MenuLabel(this BurnerMode m) =>
        m == BurnerMode.Simple ? "Simple" : "Advanced";
}
