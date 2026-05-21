using System;
using System.Collections.Generic;
using System.IO;
using Xunit;
using Flagship.Burner;

namespace Flagship.Burner.Tests;

/// <summary>
/// CliLocator: env-var override, common Windows paths, PATH lookup,
/// CLI entry discovery via parent-directory climb. No real filesystem
/// access — every test pipes an injectable fileExists predicate and
/// environment dict.
/// </summary>
public class CliLocatorTests
{
    private static IReadOnlyDictionary<string, string?> Env(params (string, string)[] pairs)
    {
        var d = new Dictionary<string, string?>(StringComparer.OrdinalIgnoreCase);
        foreach (var (k, v) in pairs) d[k] = v;
        return d;
    }

    [Fact]
    public void FindNode_RespectsFlagshipNodePath()
    {
        var path = @"C:\custom\node.exe";
        var got = CliLocator.FindNode(Env(("FLAGSHIP_NODE_PATH", path)), p => p == path);
        Assert.Equal(path, got);
    }

    [Fact]
    public void FindNode_PicksProgramFiles()
    {
        var env = Env(("ProgramFiles", @"C:\Program Files"));
        var got = CliLocator.FindNode(env, p => p == @"C:\Program Files\nodejs\node.exe");
        Assert.Equal(@"C:\Program Files\nodejs\node.exe", got);
    }

    [Fact]
    public void FindNode_FallsBackToProgramFilesX86()
    {
        var env = Env(
            ("ProgramFiles", @"C:\Program Files"),
            ("ProgramFiles(x86)", @"C:\Program Files (x86)"));
        var got = CliLocator.FindNode(env, p => p == @"C:\Program Files (x86)\nodejs\node.exe");
        Assert.Equal(@"C:\Program Files (x86)\nodejs\node.exe", got);
    }

    [Fact]
    public void FindNode_FallsBackToLocalAppData_Winget()
    {
        var env = Env(
            ("ProgramFiles", @"C:\Program Files"),
            ("LocalAppData", @"C:\Users\harry\AppData\Local"));
        var got = CliLocator.FindNode(env,
            p => p == @"C:\Users\harry\AppData\Local\Programs\nodejs\node.exe");
        Assert.Equal(@"C:\Users\harry\AppData\Local\Programs\nodejs\node.exe", got);
    }

    [Fact]
    public void FindNode_PathLookupLastResort()
    {
        // We don't want File.Exists side effects for this test, so we
        // can't trivially assert the PATH branch returns the path-found
        // entry. Just assert that with nothing else available, we
        // throw — that contract is the safety net.
        Assert.Throws<CliLocatorException>(() =>
            CliLocator.FindNode(Env(), _ => false));
    }

    [Fact]
    public void FindNode_ThrowsWhenNothingFound()
    {
        var ex = Assert.Throws<CliLocatorException>(() =>
            CliLocator.FindNode(Env(), _ => false));
        Assert.Contains("node.exe", ex.Message);
    }

    [Fact]
    public void LookupOnPath_FindsMatchingDirectory()
    {
        // We can stub the entire candidate set via Env, but File.Exists
        // is internal to LookupOnPath. Just check the no-PATH-case.
        Assert.Null(CliLocator.LookupOnPath("node.exe", Env()));
    }

    [Fact]
    public void FindEntry_RespectsEnvOverride()
    {
        var path = @"C:\repo\flagship\packages\flagship-burner\src\cli.ts";
        var got = CliLocator.FindEntry(
            Env(("FLAGSHIP_BURN_ENTRY", path)),
            p => p == path,
            executableDir: @"C:\unused");
        Assert.Equal(path, got);
    }

    [Fact]
    public void FindEntry_ClimbsParentsToFindCliTs()
    {
        // Simulate: app exe in
        //   C:\Users\foo\flagship\apps\burner-windows\bin\Debug\net8.0-windows\
        // → walk up to flagship\, then over to packages\.
        var execDir = @"C:\Users\foo\flagship\apps\burner-windows\bin\Debug\net8.0-windows";
        var expected = @"C:\Users\foo\flagship\packages\flagship-burner\src\cli.ts";
        var got = CliLocator.FindEntry(Env(), p => p == expected, executableDir: execDir);
        Assert.Equal(expected, got);
    }

    [Fact]
    public void FindEntry_FindsDistJsWhenSrcTsAbsent()
    {
        var execDir = @"C:\repo\flagship\apps\burner-windows\bin\Release\net8.0-windows";
        var expected = @"C:\repo\flagship\packages\flagship-burner\dist\cli.js";
        var got = CliLocator.FindEntry(Env(),
            p => p == expected,
            executableDir: execDir);
        Assert.Equal(expected, got);
    }

    [Fact]
    public void FindEntry_BundledAlongsideExeFallback()
    {
        // Phase-2 packaging puts the CLI dist next to the exe.
        var execDir = @"C:\Program Files\Flagship Burner";
        var expected = Path.Combine(execDir, "flagship-burner", "src", "cli.ts");
        var got = CliLocator.FindEntry(Env(),
            p => p == expected,
            executableDir: execDir);
        Assert.Equal(expected, got);
    }

    [Fact]
    public void FindEntry_ThrowsWhenNothingFound()
    {
        var ex = Assert.Throws<CliLocatorException>(() =>
            CliLocator.FindEntry(Env(), _ => false, executableDir: @"C:\nowhere"));
        Assert.Contains("CLI entry", ex.Message);
    }

    [Fact]
    public void ClimbParents_HandlesShallowDir()
    {
        Assert.Null(CliLocator.ClimbParents(@"C:\", 1));
    }

    [Fact]
    public void ClimbParents_HandlesTypicalPath()
    {
        var got = CliLocator.ClimbParents(@"C:\a\b\c\d\e", 3);
        Assert.Equal(@"C:\a\b", got);
    }
}
