using System;
using System.IO;
using System.Text;
using System.Text.Json;
using Xunit;
using Flagship.Burner;

namespace Flagship.Burner.Tests;

/// <summary>
/// Verifies the local Alpine personalize matches the server's trailer wire
/// format AND places the trailer where the box's volume-size find reads it.
/// Mirror of apps/burner-mac AlpinePersonalizeTests.swift — no boot needed,
/// we check the bytes directly.
/// </summary>
public class AlpinePersonalizeTests
{
    private static Recipe SampleRecipe()
    {
        var ac = new RecipeAuthCode
        {
            Version = 1,
            Serial = "CPSERIAL0001",
            Username = "dani",
            ServerName = "home",
            ServerDomain = "home.dani.flagship.services",
            DelegatedPubKeyHex = new string('a', 0) + Repeat("ab", 32),
            UserPubKeyHex = Repeat("cd", 32),
            IssuedAt = 1_780_276_747_131L,
            ExpiresAt = 1_780_298_347_131L,
        };
        return new Recipe
        {
            Version = 2,
            ServerDomain = "home.dani.flagship.services",
            Username = "dani",
            ServerName = "home",
            PhoneDelegatedPubKeyHex = Repeat("ab", 32),
            RegistrationUrl = "https://flagship.services/api/server/register",
            AuthCode = ac,
            AuthCodeUserSignatureHex = Repeat("11", 64),
            InstallerGitRef = "main",
            RckPubKeyHex = Repeat("ef", 32),
            BlobSignatureHex = Repeat("22", 64),
            BootUnlockMode = null,
        };
    }

    private static string Repeat(string unit, int count)
    {
        var sb = new StringBuilder(unit.Length * count);
        for (int i = 0; i < count; i++) sb.Append(unit);
        return sb.ToString();
    }

    private static uint U32Le(byte[] d, int off)
        => (uint)(d[off] | (d[off + 1] << 8) | (d[off + 2] << 16) | (d[off + 3] << 24));

    [Fact]
    public void TrailerWireFormatMatchesServer()
    {
        var r = SampleRecipe();
        var t = AlpinePersonalize.BuildTrailer(r);

        // MAGIC_HEADER(16) || version(1) || u32le(jsonLen) || json || sig(64) ||
        // MAGIC_FOOTER(16) || u32le(totalSize)
        Assert.Equal(Encoding.ASCII.GetBytes("FLAGSHIP-BOOT\0\0\0"), t[..16]);
        Assert.Equal(0x01, t[16]);
        int jsonLen = (int)U32Le(t, 17);
        var json = t[21..(21 + jsonLen)];
        using var doc = JsonDocument.Parse(json);
        var obj = doc.RootElement;
        Assert.Equal("home.dani.flagship.services", obj.GetProperty("serverDomain").GetString());
        Assert.Equal("main", obj.GetProperty("installerGitRef").GetString());
        // installBlobToJson omits bootUnlockMode (server parity).
        Assert.False(obj.TryGetProperty("bootUnlockMode", out _));
        var acj = obj.GetProperty("authCode");
        Assert.Equal("CPSERIAL0001", acj.GetProperty("serial").GetString());

        // signature is the recipe's 64-byte blobSignature, verbatim.
        var sig = t[(21 + jsonLen)..(21 + jsonLen + 64)];
        Assert.Equal(Hex.Decode(r.BlobSignatureHex), sig);

        // footer + self-describing totalSize at the very end.
        int total = t.Length;
        Assert.Equal(Encoding.ASCII.GetBytes("\0\0\0FLAGSHIP-END\0"), t[(total - 20)..(total - 4)]);
        Assert.Equal(total, (int)U32Le(t, total - 4));
    }

    [Fact]
    public void TrailerJsonIsCompactAndInExactFieldOrder()
    {
        // The box re-derives canonical bytes from this JSON, so the field order
        // + compactness (no spaces) must match installBlobToJson exactly.
        var r = SampleRecipe();
        var t = AlpinePersonalize.BuildTrailer(r);
        int jsonLen = (int)U32Le(t, 17);
        var jsonStr = Encoding.UTF8.GetString(t, 21, jsonLen);

        Assert.DoesNotContain(": ", jsonStr); // compact
        Assert.StartsWith("{\"version\":2,\"serverDomain\":\"home.dani.flagship.services\"", jsonStr);
        // authCode nested object order.
        Assert.Contains("\"authCode\":{\"version\":1,\"serial\":\"CPSERIAL0001\"", jsonStr);
        // tail order: authCodeUserSignature, installerGitRef, rckPubKey, no trailing comma.
        Assert.EndsWith("\"authCodeUserSignature\":\"" + Repeat("11", 64) +
                        "\",\"installerGitRef\":\"main\",\"rckPubKey\":\"" + Repeat("ef", 32) + "\"}", jsonStr);
    }

    [Fact]
    public void PersonalizePlacesTrailerAtVolumeOffsetAndAligns()
    {
        // Synthetic ISO9660: 16 system sectors + a PVD + 10 trailing "xorriso
        // padding" blocks, so file > volume — exactly the shape that broke the
        // download path (box reads at the volume offset, not file-end).
        int lbs = 2048, volBlocks = 100, padBlocks = 10;
        int fileBlocks = volBlocks + padBlocks;
        var iso = new byte[fileBlocks * lbs];
        int pvd = 16 * lbs;
        iso[pvd] = 0x01;
        Encoding.ASCII.GetBytes("CD001").CopyTo(iso, pvd + 1);
        // vss (both-endian u32) at PVD+80.
        uint vss = (uint)volBlocks;
        int leP = pvd + 80;
        iso[leP] = (byte)(vss & 0xff); iso[leP + 1] = (byte)((vss >> 8) & 0xff);
        iso[leP + 2] = (byte)((vss >> 16) & 0xff); iso[leP + 3] = (byte)((vss >> 24) & 0xff);
        iso[leP + 4] = (byte)((vss >> 24) & 0xff); iso[leP + 5] = (byte)((vss >> 16) & 0xff);
        iso[leP + 6] = (byte)((vss >> 8) & 0xff); iso[leP + 7] = (byte)(vss & 0xff);
        // lbs (both-endian u16) at PVD+128.
        iso[pvd + 128] = (byte)(lbs & 0xff); iso[pvd + 129] = (byte)((lbs >> 8) & 0xff);
        iso[pvd + 130] = (byte)((lbs >> 8) & 0xff); iso[pvd + 131] = (byte)(lbs & 0xff);

        string tmp = Path.GetTempPath();
        string basePath = Path.Combine(tmp, $"base-{Guid.NewGuid():N}.iso");
        string outPath = Path.Combine(tmp, $"out-{Guid.NewGuid():N}.iso");
        File.WriteAllBytes(basePath, iso);
        try
        {
            AlpinePersonalize.Personalize(basePath, SampleRecipe(), outPath, sectorSize: 512);
            var outBytes = File.ReadAllBytes(outPath);
            int fileSize = fileBlocks * lbs;

            // PVD volume-space-size patched to fileSize/lbs so the box's
            // `volumeSpaceSize × lbs` lands on the trailer (not in the padding).
            Assert.Equal(fileBlocks, (int)U32Le(outBytes, pvd + 80));
            // The both-endian big half is patched too.
            int beP = pvd + 84;
            uint be = (uint)((outBytes[beP] << 24) | (outBytes[beP + 1] << 16) | (outBytes[beP + 2] << 8) | outBytes[beP + 3]);
            Assert.Equal((uint)fileBlocks, be);
            // The trailer header sits at that offset (== fileSize).
            Assert.Equal(Encoding.ASCII.GetBytes("FLAGSHIP-BOOT\0\0\0"), outBytes[fileSize..(fileSize + 16)]);
            // Output padded to the device sector so the raw write is aligned.
            Assert.Equal(0, outBytes.Length % 512);
            Assert.True(outBytes.Length >= fileSize + 16);
        }
        finally
        {
            TryDelete(basePath); TryDelete(outPath);
        }
    }

    [Fact]
    public void PersonalizeRejectsNonIso9660()
    {
        // 64 KB of zeros — passes the size floor but has no CD001 PVD.
        var bytes = new byte[128 * 1024];
        string tmp = Path.GetTempPath();
        string basePath = Path.Combine(tmp, $"base-{Guid.NewGuid():N}.iso");
        string outPath = Path.Combine(tmp, $"out-{Guid.NewGuid():N}.iso");
        File.WriteAllBytes(basePath, bytes);
        try
        {
            var ex = Assert.Throws<AlpinePersonalize.PersonalizeException>(
                () => AlpinePersonalize.Personalize(basePath, SampleRecipe(), outPath));
            Assert.Contains("ISO9660", ex.Message);
        }
        finally { TryDelete(basePath); TryDelete(outPath); }
    }

    [Fact]
    public void PersonalizeRejectsTooSmallBase()
    {
        var bytes = new byte[1024];
        string tmp = Path.GetTempPath();
        string basePath = Path.Combine(tmp, $"base-{Guid.NewGuid():N}.iso");
        string outPath = Path.Combine(tmp, $"out-{Guid.NewGuid():N}.iso");
        File.WriteAllBytes(basePath, bytes);
        try
        {
            Assert.Throws<AlpinePersonalize.PersonalizeException>(
                () => AlpinePersonalize.Personalize(basePath, SampleRecipe(), outPath));
        }
        finally { TryDelete(basePath); TryDelete(outPath); }
    }

    [Fact]
    public void SectorAlignmentHoldsForOddSectorSizes()
    {
        // Same synthetic ISO, but a 4096-byte device sector — the pad math must
        // still land the total on a multiple of the chosen sector.
        int lbs = 2048, fileBlocks = 50;
        var iso = MakeSyntheticIso(lbs, fileBlocks, fileBlocks - 5);
        string tmp = Path.GetTempPath();
        string basePath = Path.Combine(tmp, $"base-{Guid.NewGuid():N}.iso");
        string outPath = Path.Combine(tmp, $"out-{Guid.NewGuid():N}.iso");
        File.WriteAllBytes(basePath, iso);
        try
        {
            AlpinePersonalize.Personalize(basePath, SampleRecipe(), outPath, sectorSize: 4096);
            var outBytes = File.ReadAllBytes(outPath);
            Assert.Equal(0, outBytes.Length % 4096);
        }
        finally { TryDelete(basePath); TryDelete(outPath); }
    }

    private static byte[] MakeSyntheticIso(int lbs, int fileBlocks, int volBlocks)
    {
        var iso = new byte[fileBlocks * lbs];
        int pvd = 16 * lbs;
        iso[pvd] = 0x01;
        Encoding.ASCII.GetBytes("CD001").CopyTo(iso, pvd + 1);
        uint vss = (uint)volBlocks;
        int leP = pvd + 80;
        iso[leP] = (byte)(vss & 0xff); iso[leP + 1] = (byte)((vss >> 8) & 0xff);
        iso[leP + 2] = (byte)((vss >> 16) & 0xff); iso[leP + 3] = (byte)((vss >> 24) & 0xff);
        iso[leP + 4] = (byte)((vss >> 24) & 0xff); iso[leP + 5] = (byte)((vss >> 16) & 0xff);
        iso[leP + 6] = (byte)((vss >> 8) & 0xff); iso[leP + 7] = (byte)(vss & 0xff);
        iso[pvd + 128] = (byte)(lbs & 0xff); iso[pvd + 129] = (byte)((lbs >> 8) & 0xff);
        iso[pvd + 130] = (byte)((lbs >> 8) & 0xff); iso[pvd + 131] = (byte)(lbs & 0xff);
        return iso;
    }

    private static void TryDelete(string p)
    {
        try { if (File.Exists(p)) File.Delete(p); } catch { }
    }
}
