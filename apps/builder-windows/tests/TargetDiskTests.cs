using System;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text.Json;
using Flagship.Builder;
using Xunit;

namespace Flagship.Builder.Tests;

/// "Disk to install on" (B2 #9): the field's check is the generator's, pinned by test-vectors/install-disk-stop.json,
/// and the burn options carry targetDisk only when it is set.
public sealed class TargetDiskTests
{
    static JsonElement Vectors()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir != null)
        {
            var f = Path.Combine(dir.FullName, "test-vectors", "install-disk-stop.json");
            if (File.Exists(f)) return JsonDocument.Parse(File.ReadAllText(f)).RootElement;
            dir = dir.Parent;
        }
        throw new FileNotFoundException("test-vectors/install-disk-stop.json not found above " + AppContext.BaseDirectory);
    }

    [Fact]
    public void PatternIsTheGenerators()
    {
        Assert.Equal(Vectors().GetProperty("targetDiskPattern").GetString(), TargetDisk.Pattern.ToString());
    }

    [Fact]
    public void AcceptsTheValidVectorsAndRefusesTheInvalidOnes()
    {
        var v = Vectors().GetProperty("targetDisk");
        foreach (var ok in v.GetProperty("valid").EnumerateArray().Select(e => e.GetString()!))
        {
            Assert.True(TargetDisk.IsValid(ok), ok);
            Assert.True(TargetDisk.IsValid("  " + ok + " "), ok);
            Assert.Equal(ok, TargetDisk.Normalize(" " + ok + "\t"));
        }
        foreach (var bad in v.GetProperty("invalid").EnumerateArray().Select(e => e.GetString()!))
            Assert.False(TargetDisk.IsValid(bad), bad);
    }

    [Fact]
    public void BlankMeansNoOption()
    {
        Assert.True(TargetDisk.IsValid(""));
        Assert.True(TargetDisk.IsValid("   "));
        Assert.True(TargetDisk.IsValid(null));
        Assert.Null(TargetDisk.Normalize("  "));
    }

    [Fact]
    public void BurnOptionsCarryTargetDiskOnlyWhenSet()
    {
        Assert.DoesNotContain("targetDisk", new NativePreseedEngine.BurnOptions().ToJson());
        Assert.DoesNotContain("targetDisk", new NativePreseedEngine.BurnOptions(TargetDisk: "  ").ToJson());
        var json = new NativePreseedEngine.BurnOptions(TargetDisk: " serial:S64ANS0T123456 ").ToJson();
        Assert.Equal("serial:S64ANS0T123456", JsonDocument.Parse(json).RootElement.GetProperty("targetDisk").GetString());
    }

    [Fact]
    public void TheEngineErasesOnlyTheNamedDisk()
    {
        var asm = typeof(TargetDiskTests).Assembly;
        using var s = asm.GetManifestResourceStream("Flagship.Builder.Tests.Resources.preseed-vectors.json")!;
        var recipe = JsonDocument.Parse(new StreamReader(s).ReadToEnd()).RootElement.GetProperty("vectors")[0].GetProperty("recipeJson").GetString()!;
        var engine = new NativePreseedEngine();
        var pinned = engine.BuildPreseed(recipe, new NativePreseedEngine.BurnOptions(TargetDisk: "by-id:ata-WDC_WD20_WD-XYZ"));
        Assert.Contains("/dev/disk/by-id/ata-WDC_WD20_WD-XYZ", pinned);
        Assert.DoesNotContain("/dev/disk/by-id/ata-WDC_WD20_WD-XYZ", engine.BuildPreseed(recipe));
    }
}
