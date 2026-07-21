using System;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Flagship.Builder.VM;

/// <summary>
/// Where a recipe was applied. The one input to the tier badge.
/// Mirrors apps/builder-mac FlagshipBuilderCore/VM/ServerTier.swift.
/// </summary>
public enum ServerDestination
{
    BurnToUSB,   // "usb"
    HostHere,    // "host-here"
}

/// <summary>
/// The honest security-tier badge (docs/desktop-vm-appliance.md "Security
/// model + honest tiering"): bare metal stays the gold standard; a hosted VM
/// is labeled as such — legible, never silently equivalent.
/// </summary>
public enum ServerTier
{
    Hardware,    // "hardware"
    HostedVM,    // "hosted-vm"
}

public static class ServerTierExtensions
{
    public static string BadgeLabel(this ServerTier tier) => tier switch
    {
        ServerTier.Hardware => "Appliance (hardware)",
        ServerTier.HostedVM => "Appliance (hosted VM)",
        _ => throw new ArgumentOutOfRangeException(nameof(tier)),
    };

    public static ServerTier ToTier(this ServerDestination destination) => destination switch
    {
        ServerDestination.BurnToUSB => ServerTier.Hardware,
        ServerDestination.HostHere => ServerTier.HostedVM,
        _ => throw new ArgumentOutOfRangeException(nameof(destination)),
    };
}

/// <summary>JSON string forms match the Swift raw values ("hardware" / "hosted-vm").</summary>
public sealed class ServerTierJsonConverter : JsonConverter<ServerTier>
{
    public override ServerTier Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
        => reader.GetString() switch
        {
            "hardware" => ServerTier.Hardware,
            "hosted-vm" => ServerTier.HostedVM,
            var s => throw new JsonException($"Unknown server tier '{s}'."),
        };

    public override void Write(Utf8JsonWriter writer, ServerTier value, JsonSerializerOptions options)
        => writer.WriteStringValue(value == ServerTier.Hardware ? "hardware" : "hosted-vm");
}
