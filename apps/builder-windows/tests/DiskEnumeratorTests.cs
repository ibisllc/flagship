using Xunit;
using Flagship.Builder;

namespace Flagship.Builder.Tests;

/// <summary>
/// Mirror of apps/builder-mac DiskEnumeratorTests.swift +
/// builder-linux tests/test_disk_enumerator.py — feeds canned WMIC /
/// PowerShell strings to the pure parser and asserts the safety
/// classifier matches devices.ts's verdict logic exactly.
/// </summary>
public class DiskEnumeratorTests
{
    // ---- compute-verdict rules ----

    [Fact]
    public void ComputeVerdict_RejectsWindowsBootDrive()
    {
        var (v, reason) = DiskEnumerator.ComputeVerdict(@"\\.\PhysicalDrive0", 16_000_000_000, false, true, "USB");
        Assert.Equal(SafetyVerdict.Internal, v);
        Assert.Contains("system", reason, System.StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void ComputeVerdict_RejectsBelowMinSize()
    {
        var (v, reason) = DiskEnumerator.ComputeVerdict(@"\\.\PhysicalDrive2", 100_000_000, false, true, "USB");
        Assert.Equal(SafetyVerdict.TooSmall, v);
        Assert.Contains("need >=", reason);
    }

    [Fact]
    public void ComputeVerdict_RejectsAboveMaxSize()
    {
        var (v, _) = DiskEnumerator.ComputeVerdict(
            @"\\.\PhysicalDrive2", 600L * 1024 * 1024 * 1024, false, false, "SATA");
        Assert.Equal(SafetyVerdict.Internal, v);
    }

    [Fact]
    public void ComputeVerdict_AcceptsRemovableUsb_InBand()
    {
        var (v, _) = DiskEnumerator.ComputeVerdict(
            @"\\.\PhysicalDrive2", 16_000_000_000, false, true, "USB");
        Assert.Equal(SafetyVerdict.RemovableUsb, v);
    }

    [Fact]
    public void ComputeVerdict_RejectsInternalEvenWhenBusIsUSB()
    {
        // Bus reported as USB but the OS marked it internal — the
        // explicit internal flag wins. Same posture as devices.ts:
        // we never override an `Internal=true` marker.
        var (v, _) = DiskEnumerator.ComputeVerdict(
            @"\\.\PhysicalDrive2", 16_000_000_000, true, true, "USB");
        Assert.Equal(SafetyVerdict.Internal, v);
    }

    [Fact]
    public void ComputeVerdict_RejectsNVMeWithoutRemovable()
    {
        var (v, _) = DiskEnumerator.ComputeVerdict(
            @"\\.\PhysicalDrive1", 256L * 1024 * 1024 * 1024, false, false, "NVMe");
        Assert.Equal(SafetyVerdict.Internal, v);
    }

    [Fact]
    public void ComputeVerdict_UnknownWhenSizeZero()
    {
        var (v, _) = DiskEnumerator.ComputeVerdict(
            @"\\.\PhysicalDrive2", 0, false, true, "USB");
        Assert.Equal(SafetyVerdict.Unknown, v);
    }

    [Fact]
    public void ComputeVerdict_UnknownWhenNotRemovableNotInternalUnknownBus()
    {
        var (v, _) = DiskEnumerator.ComputeVerdict(
            @"\\.\PhysicalDrive2", 16_000_000_000, false, false, "UNKNOWN");
        Assert.Equal(SafetyVerdict.Unknown, v);
    }

    // ---- normalize ----

    [Fact]
    public void Normalize_HandlesUppercasePhysicalDrive()
    {
        Assert.Equal(@"\\.\PhysicalDrive3",
            DiskEnumerator.NormalizePhysicalDrive(@"\\.\PHYSICALDRIVE3"));
    }

    [Fact]
    public void Normalize_HandlesAlreadyCanonical()
    {
        Assert.Equal(@"\\.\PhysicalDrive0",
            DiskEnumerator.NormalizePhysicalDrive(@"\\.\PhysicalDrive0"));
    }

    [Fact]
    public void Normalize_LeavesUnknownShapeAlone()
    {
        // Not a PhysicalDrive prefix → return as-is so callers can
        // still match against it. The classifier will refuse it
        // downstream via the unknown-verdict path.
        Assert.Equal("/dev/sdb",
            DiskEnumerator.NormalizePhysicalDrive("/dev/sdb"));
    }

    // ---- WMIC CSV parser ----

    [Fact]
    public void ParseWmic_KeepsAllRowsFromCanonicalOutput()
    {
        // Real WMIC output (CRLF + blank first line stripped). Three
        // disks: the boot SSD, an internal SATA HDD, and a USB stick.
        const string csv =
            "Node,DeviceID,InterfaceType,MediaType,Model,PNPDeviceID,Size\r\n" +
            "DESKTOP,\\\\.\\PHYSICALDRIVE0,SCSI,Fixed hard disk media,Samsung SSD 970 EVO Plus 1TB,PCI\\VEN_...,1000204886016\r\n" +
            "DESKTOP,\\\\.\\PHYSICALDRIVE1,IDE,Fixed hard disk media,WDC WD40EZAZ-00,IDE\\DISKWDC...,4000787030016\r\n" +
            "DESKTOP,\\\\.\\PHYSICALDRIVE2,USB,Removable Media,SanDisk Cruzer Glide,USBSTOR\\DISK&VEN_SANDISK...,16008609792\r\n";
        var rows = DiskEnumerator.ParseWmicCsv(csv);
        Assert.Equal(3, rows.Count);
        Assert.Equal(@"\\.\PhysicalDrive0", DiskEnumerator.NormalizePhysicalDrive(rows[0].DevicePath));
        Assert.Equal("USB", rows[2].Bus);
        Assert.True(rows[2].Removable);
        Assert.False(rows[2].Internal);
        Assert.Equal(16008609792, rows[2].SizeBytes);
        Assert.Contains("SanDisk", rows[2].Model);
    }

    [Fact]
    public void ParseWmic_ReturnsEmptyOnGarbage()
    {
        Assert.Empty(DiskEnumerator.ParseWmicCsv(""));
        Assert.Empty(DiskEnumerator.ParseWmicCsv("not csv\n"));
    }

    [Fact]
    public void ParseWmic_HandlesQuotedModelWithComma()
    {
        const string csv =
            "Node,DeviceID,InterfaceType,MediaType,Model,Size\r\n" +
            "DESKTOP,\\\\.\\PHYSICALDRIVE2,USB,Removable Media,\"Hitachi, Ltd. HCS5,16008609792\"\r\n";
        // This canned line is wrong-on-purpose (the quote is unterminated
        // in real WMIC, but most WMIC versions emit unquoted commas in
        // models anyway). We don't crash on either shape.
        var rows = DiskEnumerator.ParseWmicCsv(csv);
        // At minimum: don't throw. May or may not get a row depending
        // on quoting. The contract is "robust to malformed input".
        Assert.NotNull(rows);
    }

    [Fact]
    public void ParseWmic_RecognizesRemovableMediaTypeAsRemovable()
    {
        const string csv =
            "Node,DeviceID,InterfaceType,MediaType,Model,Size\r\n" +
            "DESKTOP,\\\\.\\PHYSICALDRIVE3,,Removable Media,Generic Mass Storage,2147483648\r\n";
        var rows = DiskEnumerator.ParseWmicCsv(csv);
        Assert.Single(rows);
        Assert.True(rows[0].Removable);
        Assert.Equal("USB", rows[0].Bus); // empty InterfaceType + Removable → bus tagged USB
    }

    // ---- PowerShell JSON parser ----

    [Fact]
    public void ParsePowershell_ParsesArray()
    {
        const string json =
            "[{\"DeviceId\":\"0\",\"FriendlyName\":\"Samsung 970 EVO\",\"Size\":1000204886016,\"BusType\":\"NVMe\",\"MediaType\":\"SSD\"}," +
            " {\"DeviceId\":\"2\",\"FriendlyName\":\"SanDisk Cruzer\",\"Size\":16008609792,\"BusType\":\"USB\",\"MediaType\":\"Removable\"}]";
        var rows = DiskEnumerator.ParsePowershellJson(json);
        Assert.Equal(2, rows.Count);
        Assert.Equal(@"\\.\PhysicalDrive0", rows[0].DevicePath);
        Assert.Equal("NVMe", rows[0].Bus);
        Assert.False(rows[0].Removable);
        Assert.Equal(@"\\.\PhysicalDrive2", rows[1].DevicePath);
        Assert.True(rows[1].Removable);
        Assert.Equal("USB", rows[1].Bus);
    }

    [Fact]
    public void ParsePowershell_ParsesSingleObject()
    {
        const string json =
            "{\"DeviceId\":\"2\",\"FriendlyName\":\"SanDisk\",\"Size\":16008609792,\"BusType\":\"USB\",\"MediaType\":\"Removable\"}";
        var rows = DiskEnumerator.ParsePowershellJson(json);
        Assert.Single(rows);
        Assert.True(rows[0].Removable);
    }

    [Fact]
    public void ParsePowershell_ReturnsEmptyOnGarbage()
    {
        Assert.Empty(DiskEnumerator.ParsePowershellJson(""));
        Assert.Empty(DiskEnumerator.ParsePowershellJson("not json"));
        Assert.Empty(DiskEnumerator.ParsePowershellJson("{ not json"));
    }

    // ---- end-to-end through Classify() ----

    [Fact]
    public void Classify_HidesInternal_OffersOnlyRemovableUsb()
    {
        var raw = new[] {
            new RawDisk
            {
                DevicePath = @"\\.\PHYSICALDRIVE0",
                Model = "Samsung 970 EVO",
                SizeBytes = 1000204886016,
                Bus = "NVMe",
                Removable = false,
                Internal = false,
            },
            new RawDisk
            {
                DevicePath = @"\\.\PHYSICALDRIVE1",
                Model = "WDC WD40EZAZ",
                SizeBytes = 4_000_000_000_000,
                Bus = "SATA",
                Removable = false,
                Internal = true,
            },
            new RawDisk
            {
                DevicePath = @"\\.\PHYSICALDRIVE2",
                Model = "SanDisk Cruzer",
                SizeBytes = 16_008_609_792,
                Bus = "USB",
                Removable = true,
                Internal = false,
            },
        };
        var safe = DiskEnumerator.Classify(raw);
        Assert.Single(safe);
        Assert.Equal(@"\\.\PhysicalDrive2", safe[0].DevicePath);
        Assert.Equal(SafetyVerdict.RemovableUsb, safe[0].Verdict);
    }

    [Fact]
    public void SafetyClassify_KeepsAllRowsWithVerdicts()
    {
        // The unfiltered API surface — useful for explaining "why
        // is the picker empty?" debug.
        var raw = new[] {
            new RawDisk { DevicePath = @"\\.\PHYSICALDRIVE0", Bus = "NVMe", SizeBytes = 256_000_000_000 },
            new RawDisk { DevicePath = @"\\.\PHYSICALDRIVE2", Bus = "USB", Removable = true, SizeBytes = 16_000_000_000 },
        };
        var rows = DiskEnumerator.SafetyClassify(raw);
        Assert.Equal(2, rows.Length);
        Assert.Equal(SafetyVerdict.Internal, rows[0].Verdict); // boot-drive hard-guard
        Assert.Equal(SafetyVerdict.RemovableUsb, rows[1].Verdict);
    }

    // ---- enumeration via injected runCommand ----

    [Fact]
    public void Enumerate_UsesWmicWhenAvailable()
    {
        string fakeWmic =
            "Node,DeviceID,InterfaceType,MediaType,Model,Size\r\n" +
            "DESKTOP,\\\\.\\PHYSICALDRIVE2,USB,Removable Media,SanDisk Cruzer,16008609792\r\n";
        var disks = DiskEnumerator.Enumerate((cmd, _) =>
            cmd == "wmic" ? (0, fakeWmic, "") : (1, "", "wmic should win"));
        Assert.Single(disks);
        Assert.Equal(SafetyVerdict.RemovableUsb, disks[0].Verdict);
    }

    [Fact]
    public void Enumerate_FallsBackToPowershell()
    {
        const string fakeJson =
            "{\"DeviceId\":\"2\",\"FriendlyName\":\"SanDisk\",\"Size\":16008609792,\"BusType\":\"USB\",\"MediaType\":\"Removable\"}";
        var disks = DiskEnumerator.Enumerate((cmd, _) => cmd switch
        {
            "wmic" => (1, "", "wmic not present"),
            "powershell" => (0, fakeJson, ""),
            _ => (1, "", "unexpected"),
        });
        Assert.Single(disks);
        Assert.Equal(SafetyVerdict.RemovableUsb, disks[0].Verdict);
    }

    [Fact]
    public void Enumerate_ReturnsEmptyWhenBothFail()
    {
        var disks = DiskEnumerator.Enumerate((_, _) => (1, "", "neither tool works"));
        Assert.Empty(disks);
    }

    // ---- formatting ----

    [Fact]
    public void FmtSize_HumanReadable()
    {
        Assert.Equal("100B", DiskEnumerator.FmtSize(100));
        Assert.Equal("1.0KB", DiskEnumerator.FmtSize(1024));
        Assert.Equal("1.0MB", DiskEnumerator.FmtSize(1024 * 1024));
        Assert.Equal("16.00GB", DiskEnumerator.FmtSize(16L * 1024 * 1024 * 1024));
    }
}
