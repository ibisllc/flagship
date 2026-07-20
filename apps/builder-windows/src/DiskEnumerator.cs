using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text;

namespace Flagship.Builder;

/// <summary>
/// One physical disk Windows knows about, after enumeration + the
/// Flagship safety classifier. Mirrors devices.ts::DeviceInfo /
/// USBDisk.swift / disk_enumerator.py::DeviceInfo.
///
/// Whole-disk only — we never expose partitions, and we never offer
/// devices that the classifier rejected.
/// </summary>
public sealed record DiskInfo
{
    /// <summary>e.g. "\\.\PhysicalDrive2"</summary>
    public string DevicePath { get; init; } = "";
    public long SizeBytes { get; init; }
    public string Model { get; init; } = "";
    /// <summary>"USB", "SATA", "NVMe", "Virtual", etc.</summary>
    public string Bus { get; init; } = "";
    public bool Removable { get; init; }
    public bool Internal { get; init; }
    public SafetyVerdict Verdict { get; init; } = SafetyVerdict.Unknown;
    public string VerdictReason { get; init; } = "";

    public string HumanSize => DiskEnumerator.FmtSize(SizeBytes);

    public string DisplayName =>
        $"{(string.IsNullOrEmpty(Model) ? "(unknown model)" : Model)} ({HumanSize}, {Bus})";

    public bool IsSafe => Verdict == SafetyVerdict.RemovableUsb;
}

public enum SafetyVerdict
{
    RemovableUsb,  // safe to offer in the picker
    Internal,      // refused even with --device
    TooSmall,      // <500MB
    Unknown,       // classifier couldn't decide; treated as internal
}

/// <summary>
/// Removable-storage enumeration + safety classifier for Windows.
///
/// We shell out to `wmic diskdrive get ...` (or PowerShell
/// `Get-PhysicalDisk` as fallback) and reuse the same 500MB–500GB band,
/// the same internal/NVMe-without-removable refusal, and the same
/// system-drive (`\\.\PhysicalDrive0`) hard-block that
/// packages/flagship-builder/src/devices.ts enforces.
///
/// The parser is pure — feed canned strings to ParseWmicCsv / ParsePowershellJson
/// for unit tests without touching real hardware. This matches the
/// "InjectableRunCommand" shape used by devices.ts / DiskEnumerator.swift.
/// </summary>
public static class DiskEnumerator
{
    public const long MinDeviceSizeBytes = 500L * 1024 * 1024;          // 500 MB
    public const long MaxDeviceSizeBytes = 500L * 1024 * 1024 * 1024;   // 500 GB

    /// <summary>
    /// Production entry point. Calls `wmic` first (ships on every Win10/11),
    /// falls back to PowerShell `Get-PhysicalDisk` if wmic is absent
    /// (Windows 11 deprecated it on some SKUs).
    /// </summary>
    public static DiskInfo[] Enumerate(Func<string, string[], (int code, string stdout, string stderr)>? runCommand = null)
    {
        var run = runCommand ?? DefaultRunCommand;
        // First try wmic.
        var wmic = run("wmic", new[] {
            "diskdrive", "get",
            "DeviceID,Model,Size,InterfaceType,MediaType,PNPDeviceID",
            "/format:csv",
        });
        if (wmic.code == 0 && !string.IsNullOrWhiteSpace(wmic.stdout))
        {
            var rows = ParseWmicCsv(wmic.stdout);
            return Classify(rows);
        }
        // Fallback: PowerShell.
        var ps = run("powershell", new[] {
            "-NoProfile", "-NonInteractive", "-Command",
            "Get-PhysicalDisk | Select-Object DeviceId,FriendlyName,Size,BusType,MediaType | ConvertTo-Json -Compress",
        });
        if (ps.code == 0 && !string.IsNullOrWhiteSpace(ps.stdout))
        {
            var rows = ParsePowershellJson(ps.stdout);
            return Classify(rows);
        }
        return Array.Empty<DiskInfo>();
    }

    /// <summary>Apply ComputeVerdict to every raw row, return the lot
    /// (rejected disks included — the caller decides whether to filter).</summary>
    public static DiskInfo[] Classify(IEnumerable<RawDisk> raw)
    {
        var list = new List<DiskInfo>();
        foreach (var r in raw)
        {
            var devicePath = r.DevicePath;
            // wmic returns "\\\\.\\PHYSICALDRIVE2"; normalize to forward-slash spelling so the
            // comparison with \\.\PhysicalDrive0 below + the CLI's --device argument both agree.
            devicePath = NormalizePhysicalDrive(devicePath);
            var verdict = ComputeVerdict(devicePath, r.SizeBytes, r.Internal, r.Removable, r.Bus);
            list.Add(new DiskInfo
            {
                DevicePath = devicePath,
                SizeBytes = r.SizeBytes,
                Model = string.IsNullOrEmpty(r.Model) ? "(unknown model)" : r.Model.Trim(),
                Bus = string.IsNullOrEmpty(r.Bus) ? "UNKNOWN" : r.Bus,
                Removable = r.Removable,
                Internal = r.Internal,
                Verdict = verdict.verdict,
                VerdictReason = verdict.reason,
            });
        }
        // Only return safe entries — same posture as Linux's safe_devices().
        // The "raw" full list is available via SafetyClassify for tests.
        return list.Where(d => d.Verdict == SafetyVerdict.RemovableUsb).ToArray();
    }

    /// <summary>Run the classifier without filtering — useful for tests.</summary>
    public static DiskInfo[] SafetyClassify(IEnumerable<RawDisk> raw)
    {
        var list = new List<DiskInfo>();
        foreach (var r in raw)
        {
            var devicePath = NormalizePhysicalDrive(r.DevicePath);
            var verdict = ComputeVerdict(devicePath, r.SizeBytes, r.Internal, r.Removable, r.Bus);
            list.Add(new DiskInfo
            {
                DevicePath = devicePath,
                SizeBytes = r.SizeBytes,
                Model = string.IsNullOrEmpty(r.Model) ? "(unknown model)" : r.Model.Trim(),
                Bus = string.IsNullOrEmpty(r.Bus) ? "UNKNOWN" : r.Bus,
                Removable = r.Removable,
                Internal = r.Internal,
                Verdict = verdict.verdict,
                VerdictReason = verdict.reason,
            });
        }
        return list.ToArray();
    }

    public static (SafetyVerdict verdict, string reason) ComputeVerdict(
        string devicePath, long sizeBytes, bool isInternal, bool removable, string bus)
    {
        // Windows boot-drive hard guard: \\.\PhysicalDrive0 is the
        // system disk on every Windows install. Refuse even if WMIC
        // somehow forgets to mark it as internal.
        if (string.Equals(devicePath, @"\\.\PhysicalDrive0", StringComparison.OrdinalIgnoreCase))
        {
            return (SafetyVerdict.Internal, "Windows system drive (\\\\.\\PhysicalDrive0)");
        }
        if (sizeBytes > 0 && sizeBytes < MinDeviceSizeBytes)
        {
            return (SafetyVerdict.TooSmall,
                $"device is {FmtSize(sizeBytes)} (need >= {FmtSize(MinDeviceSizeBytes)})");
        }
        if (sizeBytes > MaxDeviceSizeBytes)
        {
            return (SafetyVerdict.Internal,
                $"device is {FmtSize(sizeBytes)} (>{FmtSize(MaxDeviceSizeBytes)} — almost certainly an internal drive)");
        }
        if (isInternal)
        {
            return (SafetyVerdict.Internal, $"OS marks {devicePath} as internal media");
        }
        // NVMe/SATA with no Removable bit → internal. Same rule as the
        // Linux classifier: a fixed NVMe is the laptop SSD.
        var b = (bus ?? "").Trim().ToUpperInvariant();
        if ((b == "NVMe".ToUpperInvariant() || b == "SATA" || b == "ATA") && !removable)
        {
            return (SafetyVerdict.Internal, $"{b} disk without removable bit — likely internal");
        }
        if (removable || b == "USB")
        {
            if (sizeBytes == 0)
            {
                return (SafetyVerdict.Unknown, "removable but size unknown — refusing");
            }
            return (SafetyVerdict.RemovableUsb, $"removable {b} device, {FmtSize(sizeBytes)}");
        }
        return (SafetyVerdict.Unknown, "cannot determine if device is removable");
    }

    /// <summary>
    /// Parse the CSV output of `wmic diskdrive get ... /format:csv`.
    /// WMIC CSV: first non-empty line is the header, then rows.
    /// Columns we care about: DeviceID, Model, Size, InterfaceType, MediaType.
    /// </summary>
    public static List<RawDisk> ParseWmicCsv(string csv)
    {
        var rows = new List<RawDisk>();
        if (string.IsNullOrWhiteSpace(csv)) return rows;
        // Normalize CRLF + drop empty leading lines.
        var lines = csv.Replace("\r\n", "\n").Split('\n')
            .Select(l => l.Trim()).Where(l => l.Length > 0).ToList();
        if (lines.Count < 2) return rows;
        var header = lines[0].Split(',').Select(s => s.Trim()).ToList();
        int idxDeviceId = header.IndexOf("DeviceID");
        int idxModel = header.IndexOf("Model");
        int idxSize = header.IndexOf("Size");
        int idxIface = header.IndexOf("InterfaceType");
        int idxMedia = header.IndexOf("MediaType");
        if (idxDeviceId < 0) return rows;
        for (int i = 1; i < lines.Count; i++)
        {
            var cells = SplitCsvLine(lines[i]);
            if (cells.Count <= idxDeviceId) continue;
            var deviceId = cells[idxDeviceId];
            if (string.IsNullOrEmpty(deviceId)) continue;
            string model = idxModel >= 0 && idxModel < cells.Count ? cells[idxModel] : "";
            long sizeBytes = 0;
            if (idxSize >= 0 && idxSize < cells.Count && long.TryParse(cells[idxSize], out var sz)) sizeBytes = sz;
            string iface = idxIface >= 0 && idxIface < cells.Count ? cells[idxIface] : "";
            string media = idxMedia >= 0 && idxMedia < cells.Count ? cells[idxMedia] : "";
            // WMIC InterfaceType: "USB" / "IDE" / "SCSI"; MediaType:
            // "Removable Media" / "Fixed hard disk media".
            var removable = media != null && media.IndexOf("Removable", StringComparison.OrdinalIgnoreCase) >= 0;
            var isInternal = !removable && (
                media != null && media.IndexOf("Fixed", StringComparison.OrdinalIgnoreCase) >= 0
            );
            rows.Add(new RawDisk
            {
                DevicePath = deviceId,
                Model = model,
                SizeBytes = sizeBytes,
                Bus = MapWmicBus(iface, media),
                Removable = removable,
                Internal = isInternal,
            });
        }
        return rows;
    }

    /// <summary>
    /// Map WMIC InterfaceType/MediaType pairs to the bus tag we use
    /// across all three builder GUIs. Keeps the classifier's bus-string
    /// shape uniform.
    /// </summary>
    public static string MapWmicBus(string interfaceType, string mediaType)
    {
        var i = (interfaceType ?? "").Trim();
        if (string.Equals(i, "USB", StringComparison.OrdinalIgnoreCase)) return "USB";
        if ((mediaType ?? "").IndexOf("Removable", StringComparison.OrdinalIgnoreCase) >= 0
            && string.IsNullOrEmpty(i)) return "USB";
        if (string.Equals(i, "IDE", StringComparison.OrdinalIgnoreCase)) return "SATA";
        if (string.Equals(i, "SCSI", StringComparison.OrdinalIgnoreCase)) return "SCSI";
        if (i.Length == 0) return "UNKNOWN";
        return i.ToUpperInvariant();
    }

    /// <summary>
    /// Parse `Get-PhysicalDisk | ConvertTo-Json -Compress`. PowerShell
    /// emits a single JSON object (when only one row) or a JSON array.
    /// We tolerate both via a tiny hand-rolled JSON-tolerant parser.
    /// </summary>
    public static List<RawDisk> ParsePowershellJson(string json)
    {
        var rows = new List<RawDisk>();
        if (string.IsNullOrWhiteSpace(json)) return rows;
        // System.Text.Json is fine here; we keep it lightweight + only
        // unwrap fields we use.
        try
        {
            using var doc = System.Text.Json.JsonDocument.Parse(json);
            void IngestOne(System.Text.Json.JsonElement el)
            {
                if (el.ValueKind != System.Text.Json.JsonValueKind.Object) return;
                string deviceId = GetStr(el, "DeviceId") ?? GetStr(el, "DeviceID") ?? "";
                if (string.IsNullOrEmpty(deviceId)) return;
                // Get-PhysicalDisk's DeviceId is just a number, eg "2"; turn
                // it into the canonical "\\\\.\\PhysicalDrive2" spelling.
                if (int.TryParse(deviceId, out var pdNum))
                {
                    deviceId = $@"\\.\PhysicalDrive{pdNum}";
                }
                string model = GetStr(el, "FriendlyName") ?? "";
                long size = 0;
                if (el.TryGetProperty("Size", out var sizeEl))
                {
                    size = sizeEl.ValueKind switch
                    {
                        System.Text.Json.JsonValueKind.Number => sizeEl.TryGetInt64(out var s) ? s : 0,
                        System.Text.Json.JsonValueKind.String => long.TryParse(sizeEl.GetString(), out var ss) ? ss : 0,
                        _ => 0,
                    };
                }
                string bus = GetStr(el, "BusType") ?? "";
                string media = GetStr(el, "MediaType") ?? "";
                var removable = string.Equals(media, "Removable", StringComparison.OrdinalIgnoreCase)
                    || string.Equals(bus, "USB", StringComparison.OrdinalIgnoreCase);
                var isInternal = !removable
                    && (string.Equals(media, "HDD", StringComparison.OrdinalIgnoreCase)
                        || string.Equals(media, "SSD", StringComparison.OrdinalIgnoreCase))
                    && !string.Equals(bus, "USB", StringComparison.OrdinalIgnoreCase);
                rows.Add(new RawDisk
                {
                    DevicePath = deviceId,
                    Model = model,
                    SizeBytes = size,
                    Bus = MapPowershellBus(bus),
                    Removable = removable,
                    Internal = isInternal,
                });
            }
            if (doc.RootElement.ValueKind == System.Text.Json.JsonValueKind.Array)
            {
                foreach (var el in doc.RootElement.EnumerateArray()) IngestOne(el);
            }
            else
            {
                IngestOne(doc.RootElement);
            }
        }
        catch (System.Text.Json.JsonException)
        {
            return rows;
        }
        return rows;
    }

    public static string MapPowershellBus(string busType)
    {
        var b = (busType ?? "").Trim();
        if (string.IsNullOrEmpty(b)) return "UNKNOWN";
        if (string.Equals(b, "NVMe", StringComparison.OrdinalIgnoreCase)) return "NVMe";
        if (string.Equals(b, "USB", StringComparison.OrdinalIgnoreCase)) return "USB";
        if (string.Equals(b, "SATA", StringComparison.OrdinalIgnoreCase)) return "SATA";
        if (string.Equals(b, "ATA", StringComparison.OrdinalIgnoreCase)) return "ATA";
        if (string.Equals(b, "SCSI", StringComparison.OrdinalIgnoreCase)) return "SCSI";
        return b.ToUpperInvariant();
    }

    /// <summary>
    /// Split a single CSV row, honoring quoted fields. WMIC sometimes
    /// emits "Hitachi, Ltd." which collides with the comma delimiter.
    /// </summary>
    public static List<string> SplitCsvLine(string line)
    {
        var cells = new List<string>();
        var sb = new StringBuilder();
        bool inQuotes = false;
        for (int i = 0; i < line.Length; i++)
        {
            var c = line[i];
            if (c == '"')
            {
                inQuotes = !inQuotes;
                continue;
            }
            if (c == ',' && !inQuotes)
            {
                cells.Add(sb.ToString().Trim());
                sb.Clear();
                continue;
            }
            sb.Append(c);
        }
        cells.Add(sb.ToString().Trim());
        return cells;
    }

    public static string FmtSize(long bytes)
    {
        if (bytes < 1024) return $"{bytes}B";
        if (bytes < 1024 * 1024) return $"{bytes / 1024.0:F1}KB";
        if (bytes < 1024L * 1024 * 1024) return $"{bytes / (1024.0 * 1024.0):F1}MB";
        return $"{bytes / (1024.0 * 1024.0 * 1024.0):F2}GB";
    }

    /// <summary>WMIC reports DeviceID as `\\\\.\\PHYSICALDRIVE2`;
    /// normalize to `\\.\PhysicalDrive2` (Windows canonical mixed case)
    /// so it matches both the boot-drive guard and the CLI's --device
    /// argument expected shape.</summary>
    public static string NormalizePhysicalDrive(string raw)
    {
        if (string.IsNullOrEmpty(raw)) return raw;
        var trimmed = raw.Trim();
        var lower = trimmed.ToLowerInvariant();
        const string prefix = @"\\.\physicaldrive";
        int idx = lower.IndexOf(prefix, StringComparison.Ordinal);
        if (idx < 0) return trimmed;
        var rest = trimmed.Substring(idx + prefix.Length);
        return @"\\.\PhysicalDrive" + rest;
    }

    // --- helpers ---

    private static (int code, string stdout, string stderr) DefaultRunCommand(string cmd, string[] argv)
    {
        var psi = new ProcessStartInfo
        {
            FileName = cmd,
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8,
        };
        foreach (var a in argv) psi.ArgumentList.Add(a);
        try
        {
            using var p = Process.Start(psi);
            if (p == null) return (1, "", "");
            var stdout = p.StandardOutput.ReadToEnd();
            var stderr = p.StandardError.ReadToEnd();
            p.WaitForExit();
            return (p.ExitCode, stdout, stderr);
        }
        catch (Exception e)
        {
            return (1, "", e.Message);
        }
    }

    private static string? GetStr(System.Text.Json.JsonElement el, string key)
    {
        if (!el.TryGetProperty(key, out var v)) return null;
        return v.ValueKind switch
        {
            System.Text.Json.JsonValueKind.String => v.GetString(),
            System.Text.Json.JsonValueKind.Number => v.GetRawText(),
            _ => null,
        };
    }
}

/// <summary>Raw WMIC/PS-shape row, pre-classification. Public so tests
/// can feed canned rows directly into Classify().</summary>
public sealed record RawDisk
{
    public string DevicePath { get; init; } = "";
    public string Model { get; init; } = "";
    public long SizeBytes { get; init; }
    public string Bus { get; init; } = "";
    public bool Removable { get; init; }
    public bool Internal { get; init; }
}
