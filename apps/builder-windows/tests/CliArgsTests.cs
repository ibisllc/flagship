using Xunit;
using Flagship.Builder;

namespace Flagship.Builder.Tests;

/// <summary>
/// CliArgs builds the argv passed to `node`. Mirrors CLIArgsTests.swift +
/// builder-linux/test_cli_runner.py — the argv shape MUST match
/// packages/flagship-builder/src/cli.ts's accepted vocabulary 1:1.
/// </summary>
public class CliArgsTests
{
    [Fact]
    public void Verify_TwoArgsPlusEntry()
    {
        var argv = CliArgs.Verify(@"C:\entry\cli.ts", @"C:\tmp\recipe.json");
        Assert.Equal(new[] { @"C:\entry\cli.ts", "verify", @"C:\tmp\recipe.json" }, argv);
    }

    [Fact]
    public void Prepare_WithoutKeepRecipe()
    {
        var argv = CliArgs.Prepare(@"C:\entry\cli.ts",
            @"C:\tmp\recipe.json",
            @"C:\tmp\ubuntu.iso",
            @"C:\tmp\out.iso",
            keepRecipe: false);
        Assert.Equal(new[] {
            @"C:\entry\cli.ts", "prepare",
            @"C:\tmp\recipe.json", @"C:\tmp\ubuntu.iso", @"C:\tmp\out.iso"
        }, argv);
    }

    [Fact]
    public void Prepare_WithKeepRecipe()
    {
        var argv = CliArgs.Prepare(@"C:\entry\cli.ts",
            @"C:\tmp\recipe.json",
            @"C:\tmp\ubuntu.iso",
            @"C:\tmp\out.iso",
            keepRecipe: true);
        Assert.Contains("--keep-recipe", argv);
    }

    [Fact]
    public void ApplianceProvisionCarriesExactVerificationAndOverlayInputs()
    {
        var argv = CliArgs.ApplianceProvision("cli.js", "recipe.json", "base.raw",
            "base.raw.json", "disk.qcow2", "seed.img", "amd64", 68719476736,
            "qemu-img.exe");
        Assert.Equal(new[] { "cli.js", "appliance-provision", "recipe.json", "base.raw",
            "base.raw.json", "disk.qcow2", "seed.img", "--arch", "amd64",
            "--disk-size", "68719476736", "--qemu-img", "qemu-img.exe" }, argv);
    }

    [Fact]
    public void Write_WithDevice()
    {
        var argv = CliArgs.Write(@"C:\entry\cli.ts",
            @"C:\tmp\recipe.json",
            @"C:\tmp\ubuntu.iso",
            device: @"\\.\PhysicalDrive2",
            yes: true,
            keepRecipe: false);
        Assert.Equal(new[] {
            @"C:\entry\cli.ts", "write",
            @"C:\tmp\recipe.json", @"C:\tmp\ubuntu.iso",
            "--device", @"\\.\PhysicalDrive2",
            "--yes"
        }, argv);
    }

    [Fact]
    public void Write_NoDeviceArgWhenNull()
    {
        var argv = CliArgs.Write(@"C:\entry\cli.ts",
            @"C:\tmp\recipe.json",
            @"C:\tmp\ubuntu.iso",
            device: null,
            yes: false,
            keepRecipe: false);
        Assert.DoesNotContain("--device", argv);
        Assert.DoesNotContain("--yes", argv);
    }

    [Fact]
    public void Write_WithWifi_AppendsExplicitFlags()
    {
        var argv = CliArgs.Write("cli.js", "recipe.json", "base.iso", null,
            yes: true, keepRecipe: false, wifiSsid: " Studio WiFi ", wifiPassword: "secret pass");
        Assert.Equal(new[] { "--wifi-ssid", "Studio WiFi", "--wifi-password", "secret pass" }, argv[^4..]);
    }

    [Fact]
    public void Write_WithoutSsid_DoesNotLeakPassword()
    {
        var argv = CliArgs.Write("cli.js", "recipe.json", "base.iso", null,
            yes: false, keepRecipe: false, wifiSsid: " ", wifiPassword: "secret");
        Assert.DoesNotContain("--wifi-ssid", argv);
        Assert.DoesNotContain("secret", argv);
    }
    [Fact]
    public void UserData_StandardForm()
    {
        var argv = CliArgs.UserData(@"C:\entry\cli.ts",
            @"C:\tmp\recipe.json",
            @"C:\tmp\user-data.yaml",
            keepRecipe: false);
        Assert.Equal(new[] {
            @"C:\entry\cli.ts", "user-data",
            @"C:\tmp\recipe.json", @"C:\tmp\user-data.yaml"
        }, argv);
    }
}
