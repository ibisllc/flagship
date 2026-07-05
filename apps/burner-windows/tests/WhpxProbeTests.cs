using Xunit;
using Flagship.Burner.VM;

namespace Flagship.Burner.Tests;

/// <summary>The pure stderr classifier behind the honest WHPX errors.</summary>
public class WhpxProbeTests
{
    [Fact]
    public void ExitZeroIsAvailable()
    {
        Assert.True(WhpxProbe.Classify(0, "").IsAvailable);
    }

    [Fact]
    public void WhpxRefusalMapsToHypervisorPlatformDisabled()
    {
        var v = WhpxProbe.Classify(1,
            "qemu-system-x86_64.exe: -accel whpx: WHPX: No accelerator found, hr=00000000\r\n" +
            "qemu-system-x86_64.exe: failed to initialize whpx: Function not implemented");
        Assert.Equal(WhpxVerdictKind.HypervisorPlatformDisabled, v.Kind);
        Assert.Contains("Windows Hypervisor Platform", v.Message);
    }

    [Fact]
    public void WhpxInitFailureMentioningFirmwareMapsToBiosGuidance()
    {
        var v = WhpxProbe.Classify(1,
            "WHPX: initialization failed — VMX not enabled in firmware/BIOS");
        Assert.Equal(WhpxVerdictKind.VirtualizationDisabledInFirmware, v.Kind);
        Assert.Contains("BIOS", v.Message);
    }

    [Fact]
    public void MissingFirmwareFilesMapToQemuNotUsable()
    {
        var v = WhpxProbe.Classify(1,
            "qemu-system-x86_64.exe: Could not load pflash image 'edk2-x86_64-code.fd': No such file or directory");
        Assert.Equal(WhpxVerdictKind.QemuNotUsable, v.Kind);
        Assert.Contains("reinstall", v.Message);
    }

    [Fact]
    public void AnythingElseIsHonestlyUnknownWithTheRawError()
    {
        var v = WhpxProbe.Classify(2, "totally novel failure text");
        Assert.Equal(WhpxVerdictKind.Unknown, v.Kind);
        Assert.Contains("totally novel failure text", v.Message);
    }
}
