using System;
using System.Text;
using System.Text.Json;
using Xunit;
using Flagship.Builder;
using Flagship.Builder.VM;

namespace Flagship.Builder.Tests;

/// <summary>Direct port of apps/builder-mac VMConfigTests.swift.</summary>
public class VMConfigTests
{
    // ---- Fixtures ----

    private static Recipe MakeRecipe(string? bootUnlockMode = null, string? diskEncryption = null)
        => new()
        {
            Version = 2,
            ServerDomain = "home.harry.flagship.services",
            Username = "harry",
            ServerName = "home",
            PhoneDelegatedPubKeyHex = new string('1', 64),
            RegistrationUrl = "https://flagship.services/api/server/register",
            AuthCode = new RecipeAuthCode
            {
                Version = 1,
                Serial = "01VMTEST",
                Username = "harry",
                ServerName = "home",
                ServerDomain = "home.harry.flagship.services",
                DelegatedPubKeyHex = new string('1', 64),
                UserPubKeyHex = new string('e', 64),
                IssuedAt = 1_899_996_400_000,
                ExpiresAt = 1_900_000_000_000,
            },
            AuthCodeUserSignatureHex = new string('0', 128),
            InstallerGitRef = "main",
            RckPubKeyHex = new string('f', 64),
            BlobSignatureHex = new string('f', 128),
            BootUnlockMode = bootUnlockMode,
            DiskEncryption = diskEncryption,
        };

    private static byte[] Json(string s) => Encoding.UTF8.GetBytes(s);

    private static readonly HostResources Host16 = new(8, 16 * VMResourcePlan.GiB);

    // ---- Determinism + shape ----

    [Fact]
    public void PlanIsDeterministic()
    {
        var recipe = MakeRecipe();
        var raw = Json("{\"version\":2}");
        var a = VMConfig.Plan(recipe, raw, Host16);
        var b = VMConfig.Plan(recipe, raw, Host16);
        Assert.Equal(a, b);
    }

    [Fact]
    public void PlanCarriesTheServerIdentityAndResources()
    {
        var cfg = VMConfig.Plan(MakeRecipe(), Json("{}"), Host16);
        Assert.Equal("home.harry.flagship.services", cfg.Name);
        Assert.Equal("home.harry.flagship.services", cfg.ServerDomain);
        Assert.Equal("harry", cfg.Username);
        Assert.Equal("home", cfg.ServerName);
        Assert.Equal(VMResourcePlan.VmCpuCount(Host16), cfg.CpuCount);
        Assert.Equal(VMResourcePlan.VmMemoryBytes(Host16), cfg.MemoryBytes);
        Assert.Equal(VMResourcePlan.DefaultMainDiskSizeBytes, cfg.MainDiskSizeBytes);
        Assert.Equal(VMNetworkMode.Nat, cfg.NetworkMode);
    }

    // ---- Serial console ⇔ debug grant (the hard guardrail) ----

    [Fact]
    public void ProductionRecipeGetsNoSerialConsole()
    {
        var cfg = VMConfig.Plan(MakeRecipe(), Json("{\"version\":2}"), Host16);
        Assert.False(cfg.SerialConsoleEnabled);
    }

    [Fact]
    public void DebugGrantSiblingEnablesTheSerialConsole()
    {
        var raw = Json("{\"version\":2,\"debugGrant\":\"{\\\"grant\\\":{},\\\"signatureHex\\\":\\\"ab\\\"}\"}");
        var cfg = VMConfig.Plan(MakeRecipe(), raw, Host16);
        Assert.True(cfg.SerialConsoleEnabled);
    }

    [Fact]
    public void DebugGrantInsideTheEnvelopeShapeEnablesTheConsole()
    {
        // The sibling rides at the TOP level of the issued envelope, beside
        // blob/blobSignature — exactly where the canonical engine reads it.
        var raw = Json("{\"blob\":{\"version\":2},\"blobSignature\":\"f1\",\"debugGrant\":{\"grant\":{\"issuedAt\":1},\"signatureHex\":\"ab\"}}");
        var cfg = VMConfig.Plan(MakeRecipe(), raw, Host16);
        Assert.True(cfg.SerialConsoleEnabled);
    }

    [Fact]
    public void EmptyDebugGrantStringDoesNotEnableTheConsole()
    {
        // Mirrors the engine's asStr: an empty string is "absent".
        var raw = Json("{\"version\":2,\"debugGrant\":\"\"}");
        var cfg = VMConfig.Plan(MakeRecipe(), raw, Host16);
        Assert.False(cfg.SerialConsoleEnabled);
    }

    // ---- Unlock policy from the signed blob ----

    [Fact]
    public void EncryptedGuestAwaitsPhoneUnlockAtBoot()
    {
        // Absent diskEncryption ⇒ LUKS ⇒ boots into the sealed state.
        var cfg = VMConfig.Plan(MakeRecipe(), Json("{}"), Host16);
        Assert.True(cfg.DiskEncrypted);
        Assert.True(cfg.AwaitsPhoneUnlockAtBoot);
        Assert.Equal("auto", cfg.BootUnlockMode);
    }

    [Fact]
    public void ApproveModeIsCarriedThrough()
    {
        var cfg = VMConfig.Plan(MakeRecipe(bootUnlockMode: "approve"), Json("{}"), Host16);
        Assert.Equal("approve", cfg.BootUnlockMode);
        Assert.True(cfg.AwaitsPhoneUnlockAtBoot);
    }

    [Fact]
    public void UnencryptedGuestBootsStraightThrough()
    {
        var cfg = VMConfig.Plan(MakeRecipe(diskEncryption: "none"), Json("{}"), Host16);
        Assert.False(cfg.DiskEncrypted);
        Assert.False(cfg.AwaitsPhoneUnlockAtBoot);
    }

    // ---- JSON round-trip (persisted in config.json) ----

    [Fact]
    public void JsonRoundTrip()
    {
        var raw = Json("{\"debugGrant\":\"x\"}");
        var cfg = VMConfig.Plan(MakeRecipe(bootUnlockMode: "approve"), raw, Host16);
        var json = JsonSerializer.Serialize(cfg, VMInventoryStore.SerializerOptions);
        var back = JsonSerializer.Deserialize<VMConfig>(json, VMInventoryStore.SerializerOptions);
        Assert.Equal(cfg, back);
        // The network mode serializes as the shared raw value.
        Assert.Contains("\"networkMode\": \"nat\"", json);
    }
}
