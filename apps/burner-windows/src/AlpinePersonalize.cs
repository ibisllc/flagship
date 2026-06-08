using System;
using System.IO;
using System.Text;

namespace Flagship.Burner;

/// <summary>
/// Local Alpine personalize — the burner-owns-the-ISO path. Pure-C# port of
/// apps/burner-mac AlpinePersonalize.swift (byte-for-byte).
///
/// Instead of the website streaming a 240 MB personalized ISO per server, the
/// burner caches the base Alpine ISO once (BaseIsoCache) and appends the recipe
/// trailer LOCALLY, exactly as the server's iso-personalizer/streamPersonalize
/// would. Owning both ends here lets us fix the three seams the download path
/// had:
///   1. no per-server 240 MB download (just the ~1 KB recipe),
///   2. the output is padded to the device sector so the raw write is aligned,
///   3. the trailer lands EXACTLY where the box's volume-size find reads it.
///
/// Trailer wire format (byte-identical to packages/iso-personalizer/trailer.ts):
///   MAGIC_HEADER(16) || version(1) || u32le(jsonLen) || json ||
///   signature(64) || MAGIC_FOOTER(16) || u32le(totalSize)
///
/// `json` is JSON.stringify(installBlobToJson(blob)) — built in the SAME field
/// order so the bytes match the server. The box parses it back via
/// installBlobFromJson and verifies the Ed25519 signature over the canonical
/// InstallBlob bytes.
/// </summary>
public static class AlpinePersonalize
{
    public sealed class PersonalizeException : Exception
    {
        public PersonalizeException(string message) : base(message) { }
    }

    // Trailer constants — must match trailer.ts exactly.
    // "FLAGSHIP-BOOT\0\0\0" (16) and "\0\0\0FLAGSHIP-END\0" (16).
    public static readonly byte[] MagicHeader = Encoding.ASCII.GetBytes("FLAGSHIP-BOOT\0\0\0");
    public static readonly byte[] MagicFooter = Encoding.ASCII.GetBytes("\0\0\0FLAGSHIP-END\0");
    public const byte FormatVersion = 0x01;
    public const int SigLen = 64;
    public const int MaxTrailerBytes = 65_536;

    // ISO9660 Primary Volume Descriptor: sector 16 (byte 32768). The
    // volume-space-size is a both-endian u32 at PVD offset 80; the logical
    // block size a both-endian u16 at PVD offset 128.
    public const int PvdOffset = 16 * 2048;
    public const int VssOffset = 16 * 2048 + 80;
    public const int LbsOffset = 16 * 2048 + 128;

    /// <summary>
    /// Build the trailer bytes for a verified recipe. Pure; unit-tested against
    /// the TS golden vector.
    /// </summary>
    public static byte[] BuildTrailer(Recipe recipe)
    {
        byte[] json = InstallBlobJson(recipe);
        int jsonLen = json.Length;
        int totalSize = MagicHeader.Length + 1 + 4 + jsonLen + SigLen + MagicFooter.Length + 4;
        if (totalSize > MaxTrailerBytes)
            throw new PersonalizeException($"Recipe trailer too large ({totalSize} bytes).");

        byte[]? sig = Hex.Decode(recipe.BlobSignatureHex);
        if (sig == null || sig.Length != SigLen)
            throw new PersonalizeException($"Recipe trailer too large (0 bytes).");

        using var ms = new MemoryStream(totalSize);
        ms.Write(MagicHeader, 0, MagicHeader.Length);
        ms.WriteByte(FormatVersion);
        WriteU32Le(ms, (uint)jsonLen);
        ms.Write(json, 0, json.Length);
        ms.Write(sig, 0, sig.Length);
        ms.Write(MagicFooter, 0, MagicFooter.Length);
        WriteU32Le(ms, (uint)totalSize);
        return ms.ToArray();
    }

    /// <summary>
    /// Produce a flashable personalized image from the cached base ISO + recipe.
    /// Writes to <paramref name="outPath"/>. The result = base bytes (with the
    /// PVD volume size patched so the trailer sits at the volume boundary) +
    /// trailer + zero pad to <paramref name="sectorSize"/>, so a raw-device
    /// write is block-aligned.
    /// </summary>
    public static void Personalize(string basePath, Recipe recipe, string outPath, int sectorSize = 512)
    {
        long fileSize;
        try { fileSize = new FileInfo(basePath).Length; }
        catch { fileSize = 0; }
        if (fileSize < 64 * 1024)
            throw new PersonalizeException($"Base ISO is too small ({fileSize} bytes).");

        using var baseStream = new FileStream(basePath, FileMode.Open, FileAccess.Read, FileShare.Read);

        // ISO9660 PVD descriptor type 1 + "CD001" identifier at sector 16.
        baseStream.Seek(PvdOffset, SeekOrigin.Begin);
        byte[] pvdHead = ReadExactly(baseStream, 8);
        if (pvdHead.Length < 6 || pvdHead[0] != 0x01 ||
            pvdHead[1] != 0x43 || pvdHead[2] != 0x44 || pvdHead[3] != 0x30 ||
            pvdHead[4] != 0x30 || pvdHead[5] != 0x31)
            throw new PersonalizeException("Cached base ISO isn't a valid ISO9660 image.");

        baseStream.Seek(LbsOffset, SeekOrigin.Begin);
        int lbs = ReadU16Le(ReadExactly(baseStream, 2));
        int blockSize = lbs > 0 ? lbs : 2048;
        if (fileSize % blockSize != 0)
            throw new PersonalizeException(
                $"Base ISO size {fileSize} isn't a multiple of its {blockSize}-byte logical block.");
        uint newVss = (uint)(fileSize / blockSize);

        byte[] trailer = BuildTrailer(recipe);

        // Build the output: copy base, patch the PVD vss to newVss (both-endian),
        // append the trailer, pad to the sector size.
        using var outStream = new FileStream(outPath, FileMode.Create, FileAccess.ReadWrite, FileShare.None);

        baseStream.Seek(0, SeekOrigin.Begin);
        byte[] chunk = new byte[4 * 1024 * 1024];
        int read;
        while ((read = baseStream.Read(chunk, 0, chunk.Length)) > 0)
        {
            outStream.Write(chunk, 0, read);
        }
        // Patch the volume-space-size in place: u32le at vssOffset, u32be next.
        outStream.Seek(VssOffset, SeekOrigin.Begin);
        WriteU32Le(outStream, newVss);
        WriteU32Be(outStream, newVss);
        // Append the trailer at fileSize (== newVss × lbs == the box's read offset).
        outStream.Seek(fileSize, SeekOrigin.Begin);
        outStream.Write(trailer, 0, trailer.Length);
        // Pad the whole image to a sector multiple so the raw write is aligned.
        long total = fileSize + trailer.Length;
        int pad = (int)(((sectorSize - (total % sectorSize)) % sectorSize));
        if (pad > 0) outStream.Write(new byte[pad], 0, pad);
        outStream.Flush(true);
    }

    /// <summary>
    /// JSON.stringify(installBlobToJson(blob)) — same field order + compact
    /// (no spaces) so the bytes match trailer.ts. Optional bootUnlockMode +
    /// certAutonomy are appended last (in that order), only when present, exactly
    /// as installBlobToJson does — the embedded blob round-trips through the
    /// daemon → Worker re-verify, which rebuilds the canonical bytes from them.
    /// </summary>
    public static byte[] InstallBlobJson(Recipe r)
    {
        var s = new StringBuilder();
        s.Append('{');
        s.Append("\"version\":").Append(r.Version).Append(',');
        s.Append("\"serverDomain\":").Append(Js(r.ServerDomain)).Append(',');
        s.Append("\"username\":").Append(Js(r.Username)).Append(',');
        s.Append("\"serverName\":").Append(Js(r.ServerName)).Append(',');
        s.Append("\"phoneDelegatedPubKey\":").Append(Js(r.PhoneDelegatedPubKeyHex.ToLowerInvariant())).Append(',');
        s.Append("\"registrationUrl\":").Append(Js(r.RegistrationUrl)).Append(',');
        s.Append("\"authCode\":{");
        s.Append("\"version\":").Append(r.AuthCode.Version).Append(',');
        s.Append("\"serial\":").Append(Js(r.AuthCode.Serial)).Append(',');
        s.Append("\"username\":").Append(Js(r.AuthCode.Username)).Append(',');
        s.Append("\"serverName\":").Append(Js(r.AuthCode.ServerName)).Append(',');
        s.Append("\"serverDomain\":").Append(Js(r.AuthCode.ServerDomain)).Append(',');
        s.Append("\"delegatedPubKey\":").Append(Js(r.AuthCode.DelegatedPubKeyHex.ToLowerInvariant())).Append(',');
        s.Append("\"userPubKey\":").Append(Js(r.AuthCode.UserPubKeyHex.ToLowerInvariant())).Append(',');
        s.Append("\"issuedAt\":").Append(r.AuthCode.IssuedAt).Append(',');
        s.Append("\"expiresAt\":").Append(r.AuthCode.ExpiresAt);
        s.Append("},");
        s.Append("\"authCodeUserSignature\":").Append(Js(r.AuthCodeUserSignatureHex.ToLowerInvariant())).Append(',');
        s.Append("\"installerGitRef\":").Append(Js(r.InstallerGitRef)).Append(',');
        s.Append("\"rckPubKey\":").Append(Js(r.RckPubKeyHex.ToLowerInvariant()));
        if (r.BootUnlockMode != null)
            s.Append(",\"bootUnlockMode\":").Append(Js(r.BootUnlockMode));
        if (r.CertAutonomy != null)
        {
            s.Append(",\"certAutonomy\":{\"mode\":").Append(Js(r.CertAutonomy.Mode));
            if (r.CertAutonomy.OfflineWindowDays != null)
                s.Append(",\"offlineWindowDays\":").Append(r.CertAutonomy.OfflineWindowDays.Value);
            s.Append('}');
        }
        s.Append('}');
        return Encoding.UTF8.GetBytes(s.ToString());
    }

    /// <summary>
    /// Minimal JSON string encoder matching JSON.stringify for the characters
    /// that appear in recipe fields (escapes ", \\, and control chars).
    /// </summary>
    private static string Js(string value)
    {
        var sb = new StringBuilder(value.Length + 2);
        sb.Append('"');
        foreach (char ch in value)
        {
            switch (ch)
            {
                case '"': sb.Append("\\\""); break;
                case '\\': sb.Append("\\\\"); break;
                case '\n': sb.Append("\\n"); break;
                case '\r': sb.Append("\\r"); break;
                case '\t': sb.Append("\\t"); break;
                default:
                    if (ch < 0x20)
                        sb.Append("\\u").Append(((int)ch).ToString("x4", System.Globalization.CultureInfo.InvariantCulture));
                    else
                        sb.Append(ch);
                    break;
            }
        }
        sb.Append('"');
        return sb.ToString();
    }

    private static void WriteU32Le(Stream s, uint n)
    {
        s.WriteByte((byte)(n & 0xff));
        s.WriteByte((byte)((n >> 8) & 0xff));
        s.WriteByte((byte)((n >> 16) & 0xff));
        s.WriteByte((byte)((n >> 24) & 0xff));
    }

    private static void WriteU32Be(Stream s, uint n)
    {
        s.WriteByte((byte)((n >> 24) & 0xff));
        s.WriteByte((byte)((n >> 16) & 0xff));
        s.WriteByte((byte)((n >> 8) & 0xff));
        s.WriteByte((byte)(n & 0xff));
    }

    private static int ReadU16Le(byte[] d)
    {
        if (d.Length < 2) return 0;
        return d[0] | (d[1] << 8);
    }

    private static byte[] ReadExactly(Stream s, int count)
    {
        var buf = new byte[count];
        int off = 0;
        while (off < count)
        {
            int r = s.Read(buf, off, count - off);
            if (r <= 0) break;
            off += r;
        }
        if (off < count) Array.Resize(ref buf, off);
        return buf;
    }
}
