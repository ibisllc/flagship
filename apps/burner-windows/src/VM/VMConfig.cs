using System;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Flagship.Burner.VM;

public enum VMNetworkMode
{
    /// <summary>
    /// User-mode NAT (QEMU -netdev user) — the guest gets outbound internet
    /// with zero host configuration, which is all the appliance needs (it
    /// dials OUT to .com/.services; inbound arrives over the tunnel).
    /// Bridged mode is future work.
    /// </summary>
    Nat,
}

/// <summary>
/// The deterministic spec for one hosted VM — a pure function of the recipe +
/// host resources. All decisions live HERE; the QEMU adapter merely translates
/// this into a command line. Mirrors apps/burner-mac
/// FlagshipBurnerCore/VM/VMConfig.swift.
/// </summary>
public sealed record VMConfig
{
    /// <summary>Stable identifier + bundle-directory name. The server FQDN —
    /// already a hostname, so filesystem-safe, and unique per server.</summary>
    public required string Name { get; init; }
    public required string ServerDomain { get; init; }
    public required string Username { get; init; }
    public required string ServerName { get; init; }
    public required int CpuCount { get; init; }
    public required ulong MemoryBytes { get; init; }
    public required ulong MainDiskSizeBytes { get; init; }
    [JsonConverter(typeof(VMNetworkModeJsonConverter))]
    public required VMNetworkMode NetworkMode { get; init; }
    /// <summary>
    /// True iff the recipe carries the unsigned debugGrant sibling. Gates the
    /// serial console: a production VM gets NO console device at all. This
    /// mirrors the burner's debug-access hard guardrail — the host app must
    /// NEVER mount a production VM's disk or inject users to get around it;
    /// console access is gated on the phone-signed grant, period.
    /// </summary>
    public required bool SerialConsoleEnabled { get; init; }
    /// <summary>From the SIGNED blob: "auto" | "approve" (absent ⇒ "auto").</summary>
    public required string BootUnlockMode { get; init; }
    /// <summary>From the SIGNED blob: whether the guest root is LUKS-encrypted.</summary>
    public required bool DiskEncrypted { get; init; }

    /// <summary>
    /// Whether a boot passes through the sealed "waiting for you to unlock"
    /// state: an encrypted guest halts in the initramfs until the phone-home
    /// unlock supplies the key (auto = a held lease answers, approve = the
    /// owner taps). An unencrypted guest boots straight through.
    /// </summary>
    [JsonIgnore]
    public bool AwaitsPhoneUnlockAtBoot => DiskEncrypted;

    /// <summary>
    /// Build the spec for a verified recipe on this host. Deterministic: the
    /// same recipe bytes + host always produce the same config.
    ///
    /// recipeJson is the RAW recipe document (needed for the unsigned
    /// debugGrant sibling, which the parsed Recipe deliberately omits).
    /// </summary>
    public static VMConfig Plan(Recipe recipe,
                                byte[] recipeJson,
                                HostResources host,
                                ulong mainDiskSizeBytes = VMResourcePlan.DefaultMainDiskSizeBytes)
        => new()
        {
            Name = recipe.ServerDomain,
            ServerDomain = recipe.ServerDomain,
            Username = recipe.Username,
            ServerName = recipe.ServerName,
            CpuCount = VMResourcePlan.VmCpuCount(host),
            MemoryBytes = VMResourcePlan.VmMemoryBytes(host),
            MainDiskSizeBytes = mainDiskSizeBytes,
            NetworkMode = VMNetworkMode.Nat,
            SerialConsoleEnabled = RecipeSiblings.DebugGrant(recipeJson) != null,
            BootUnlockMode = recipe.EffectiveBootUnlockMode,
            DiskEncrypted = recipe.EncryptsDisk,
        };
}

/// <summary>JSON string form matches the Swift raw value ("nat").</summary>
public sealed class VMNetworkModeJsonConverter : JsonConverter<VMNetworkMode>
{
    public override VMNetworkMode Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
        => reader.GetString() switch
        {
            "nat" => VMNetworkMode.Nat,
            var s => throw new JsonException($"Unknown network mode '{s}'."),
        };

    public override void Write(Utf8JsonWriter writer, VMNetworkMode value, JsonSerializerOptions options)
        => writer.WriteStringValue("nat");
}
