using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Flagship.Burner.VM;

/// <summary>One persisted hosted server: its spec + last known lifecycle state.</summary>
public sealed record VMRecord
{
    public required VMConfig Config { get; init; }
    [JsonConverter(typeof(VMStateJsonConverter))]
    public VMState State { get; init; } = VMState.Created;
    public required DateTimeOffset CreatedAt { get; init; }
    // When the current state was entered (mirrors macOS VMRecord.stateChangedAt /
    // Linux state_changed_at). Drives the "still coming up" stall advisory. Legacy
    // bundles predate it ⇒ default(DateTimeOffset); callers fall back to CreatedAt.
    public DateTimeOffset StateChangedAt { get; init; }
    [JsonConverter(typeof(ServerTierJsonConverter))]
    public ServerTier Tier { get; init; } = ServerTier.HostedVM;
}

/// <summary>
/// The on-disk layout of one VM bundle under the inventory root:
///
///     &lt;root&gt;\&lt;name&gt;\config.json     — VMRecord (spec + state)
///     &lt;root&gt;\&lt;name&gt;\disk.qcow2      — the guest's main disk (sparse qcow2)
///     &lt;root&gt;\&lt;name&gt;\installer.iso   — the remastered installer (install phase only)
///     &lt;root&gt;\&lt;name&gt;\efi-vars.fd     — OVMF UEFI variable store (per-VM NVRAM copy)
///     &lt;root&gt;\&lt;name&gt;\console.log     — serial output (debug-enabled VMs only)
///
/// Mirrors the Mac's VMBundleLayout with Windows-native storage formats
/// (qcow2 keeps the 64 GiB main disk sparse on NTFS; OVMF vars replace the
/// VZEFIVariableStore).
/// </summary>
public sealed record VMBundleLayout(string Root)
{
    /// <summary>Production default: %LOCALAPPDATA%\FlagshipBurner\VMs.</summary>
    public static VMBundleLayout DefaultRoot()
    {
        var appData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        if (string.IsNullOrEmpty(appData))
            appData = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "AppData", "Local");
        return new VMBundleLayout(Path.Combine(appData, "FlagshipBurner", "VMs"));
    }

    public string BundleDir(string name) => Path.Combine(Root, name);
    public string ConfigPath(string name) => Path.Combine(BundleDir(name), "config.json");
    public string DiskImagePath(string name) => Path.Combine(BundleDir(name), "disk.qcow2");
    public string InstallerIsoPath(string name) => Path.Combine(BundleDir(name), "installer.iso");
    public string EfiVariableStorePath(string name) => Path.Combine(BundleDir(name), "efi-vars.fd");
    public string ConsoleLogPath(string name) => Path.Combine(BundleDir(name), "console.log");
}

public enum VMStoreErrorKind { InvalidName, AlreadyExists, NotFound }

public sealed class VMStoreException : Exception
{
    public VMStoreErrorKind Kind { get; }
    public string Name { get; }

    public VMStoreException(VMStoreErrorKind kind, string name)
        : base(kind switch
        {
            VMStoreErrorKind.InvalidName => $"'{name}' is not a valid server name.",
            VMStoreErrorKind.AlreadyExists => $"A hosted server named '{name}' already exists.",
            VMStoreErrorKind.NotFound => $"No hosted server named '{name}'.",
            _ => name,
        })
    {
        Kind = kind;
        Name = name;
    }
}

/// <summary>
/// Inventory of hosted VMs under an injected filesystem root — the app passes
/// VMBundleLayout.DefaultRoot(), tests a temp dir. Multi-server per spec:
/// each bundle is an independent appliance (different owners per VM are fine —
/// each guest phones its own owner).
/// </summary>
public sealed class VMInventoryStore
{
    public VMBundleLayout Layout { get; }

    public VMInventoryStore(VMBundleLayout layout)
    {
        Layout = layout;
    }

    /// <summary>
    /// All persisted records, sorted by name. Entries whose config.json is
    /// missing or unreadable are skipped (never fatal to the rest).
    /// </summary>
    public IReadOnlyList<VMRecord> List()
    {
        string[] names;
        try
        {
            names = Directory.EnumerateDirectories(Layout.Root)
                             .Select(d => Path.GetFileName(d)!)
                             .OrderBy(n => n, StringComparer.Ordinal)
                             .ToArray();
        }
        catch (Exception e) when (e is DirectoryNotFoundException or IOException or UnauthorizedAccessException)
        {
            return Array.Empty<VMRecord>();
        }
        var records = new List<VMRecord>();
        foreach (var name in names)
        {
            try { records.Add(Load(name)); }
            catch { /* skip unreadable bundles, never fatal to the rest */ }
        }
        return records;
    }

    public VMRecord Load(string name)
    {
        var path = Layout.ConfigPath(name);
        if (!File.Exists(path)) throw new VMStoreException(VMStoreErrorKind.NotFound, name);
        var json = File.ReadAllBytes(path);
        return JsonSerializer.Deserialize<VMRecord>(json, SerializerOptions)
               ?? throw new VMStoreException(VMStoreErrorKind.NotFound, name);
    }

    /// <summary>Create the bundle directory + initial config.json. Refuses to clobber.</summary>
    public void Create(VMRecord record)
    {
        var name = record.Config.Name;
        ValidateName(name);
        var dir = Layout.BundleDir(name);
        if (Directory.Exists(dir) || File.Exists(dir))
            throw new VMStoreException(VMStoreErrorKind.AlreadyExists, name);
        Directory.CreateDirectory(dir);
        Write(record);
    }

    /// <summary>Persist an updated record (state changes etc.). The bundle must exist.</summary>
    public void Save(VMRecord record)
    {
        var name = record.Config.Name;
        if (!Directory.Exists(Layout.BundleDir(name)))
            throw new VMStoreException(VMStoreErrorKind.NotFound, name);
        Write(record);
    }

    /// <summary>Remove the whole bundle (disk image included).</summary>
    public void Delete(string name)
    {
        var dir = Layout.BundleDir(name);
        if (!Directory.Exists(dir)) throw new VMStoreException(VMStoreErrorKind.NotFound, name);
        Directory.Delete(dir, recursive: true);
    }

    private void Write(VMRecord record)
    {
        var json = JsonSerializer.SerializeToUtf8Bytes(record, SerializerOptions);
        var path = Layout.ConfigPath(record.Config.Name);
        // Atomic-ish: write a sibling temp file then move over the target.
        var tmp = path + ".tmp";
        File.WriteAllBytes(tmp, json);
        File.Move(tmp, path, overwrite: true);
    }

    /// <summary>
    /// Bundle names are server FQDNs — plain hostnames. Reject anything that
    /// could escape the root or collide with the filesystem. Mirrors the Mac
    /// rule (lowercase a-z 0-9 . - only; no leading dot; not "."/".."), plus
    /// one Windows-required tightening pinned in the shared vectors: no
    /// TRAILING dot (Win32 silently strips it, and no FQDN ends in a dot).
    /// </summary>
    public static void ValidateName(string name)
    {
        if (string.IsNullOrEmpty(name) || name == "." || name == ".."
            || name.StartsWith('.') || name.EndsWith('.')
            || !name.All(c => c is (>= 'a' and <= 'z') or (>= '0' and <= '9') or '.' or '-'))
        {
            throw new VMStoreException(VMStoreErrorKind.InvalidName, name);
        }
    }

    public static bool IsValidName(string name)
    {
        try { ValidateName(name); return true; }
        catch (VMStoreException) { return false; }
    }

    public static readonly JsonSerializerOptions SerializerOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = true,
        WriteIndented = true,
    };
}

/// <summary>
/// Persisted shape: {"kind":"running"} or
/// {"kind":"failed","failure":{"phase":"install","reason":"…"}}.
/// </summary>
public sealed class VMStateJsonConverter : JsonConverter<VMState>
{
    public override VMState Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
    {
        using var doc = JsonDocument.ParseValue(ref reader);
        var root = doc.RootElement;
        var kind = root.GetProperty("kind").GetString();
        return kind switch
        {
            "created" => VMState.Created,
            "installing" => VMState.Installing,
            "installed" => VMState.Installed,
            "awaitingPhoneUnlock" => VMState.AwaitingPhoneUnlock,
            "running" => VMState.Running,
            "stopped" => VMState.Stopped,
            "failed" => ReadFailed(root),
            var s => throw new JsonException($"Unknown VM state '{s}'."),
        };
    }

    private static VMState ReadFailed(JsonElement root)
    {
        var f = root.GetProperty("failure");
        var phase = f.GetProperty("phase").GetString() switch
        {
            "install" => VMFailurePhase.Install,
            "run" => VMFailurePhase.Run,
            var s => throw new JsonException($"Unknown VM failure phase '{s}'."),
        };
        return VMState.Failed(phase, f.GetProperty("reason").GetString() ?? "");
    }

    public override void Write(Utf8JsonWriter writer, VMState value, JsonSerializerOptions options)
    {
        writer.WriteStartObject();
        writer.WriteString("kind", value.Kind switch
        {
            VMStateKind.Created => "created",
            VMStateKind.Installing => "installing",
            VMStateKind.Installed => "installed",
            VMStateKind.AwaitingPhoneUnlock => "awaitingPhoneUnlock",
            VMStateKind.Running => "running",
            VMStateKind.Stopped => "stopped",
            VMStateKind.Failed => "failed",
            _ => throw new JsonException($"Unknown VM state kind {value.Kind}."),
        });
        if (value.Kind == VMStateKind.Failed && value.Failure is { } failure)
        {
            writer.WriteStartObject("failure");
            writer.WriteString("phase", failure.Phase == VMFailurePhase.Install ? "install" : "run");
            writer.WriteString("reason", failure.Reason);
            writer.WriteEndObject();
        }
        writer.WriteEndObject();
    }
}
