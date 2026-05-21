using Xunit;
using Flagship.Burner;

namespace Flagship.Burner.Tests;

/// <summary>
/// CliArgs builds the argv passed to `node`. Mirrors CLIArgsTests.swift +
/// burner-linux/test_cli_runner.py — the argv shape MUST match
/// packages/flagship-burner/src/cli.ts's accepted vocabulary 1:1.
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
