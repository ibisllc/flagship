using System;
using System.IO;
using Xunit;
using Flagship.Burner.VM;

namespace Flagship.Burner.Tests;

public sealed class QemuLocatorTests : IDisposable
{
    private readonly string _root;

    public QemuLocatorTests()
    {
        _root = Path.Combine(Path.GetTempPath(), $"qemu-locator-tests-{Guid.NewGuid()}");
        Directory.CreateDirectory(Path.Combine(_root, "share"));
    }

    public void Dispose()
    {
        try { Directory.Delete(_root, recursive: true); } catch { }
    }

    private void Touch(params string[] rel)
        => File.WriteAllBytes(Path.Combine(_root, Path.Combine(rel)), new byte[] { 0 });

    private void MakeComplete()
    {
        Touch("qemu-system-x86_64.exe");
        Touch("qemu-img.exe");
        Touch("share", QemuToolchain.CodeFileName);
        Touch("share", QemuToolchain.VarsTemplateFileName);
    }

    [Fact]
    public void EnvOverrideWins()
    {
        MakeComplete();
        var tc = QemuLocator.Locate(_root, Array.Empty<string>());
        Assert.Equal(Path.Combine(_root, "qemu-system-x86_64.exe"), tc.SystemBinary);
        Assert.Equal(Path.Combine(_root, "share", QemuToolchain.CodeFileName), tc.UefiCodePath);
        Assert.Equal(Path.Combine(_root, "share", QemuToolchain.VarsTemplateFileName), tc.UefiVarsTemplate);
    }

    [Fact]
    public void FallsThroughToCandidateRoots()
    {
        MakeComplete();
        var tc = QemuLocator.Locate(null, new[] { Path.Combine(_root, "nope"), _root });
        Assert.Equal(Path.Combine(_root, "qemu-img.exe"), tc.ImgBinary);
    }

    [Fact]
    public void MissingEntirelyIsAnActionableError()
    {
        var ex = Assert.Throws<QemuLocatorException>(
            () => QemuLocator.Locate(null, new[] { Path.Combine(_root, "nope") }));
        Assert.Contains("winget install", ex.Message);
    }

    [Fact]
    public void PresentButMissingFirmwareSaysReinstall()
    {
        Touch("qemu-system-x86_64.exe");
        Touch("qemu-img.exe");
        var ex = Assert.Throws<QemuLocatorException>(
            () => QemuLocator.Locate(_root, Array.Empty<string>()));
        Assert.Contains("UEFI firmware", ex.Message);
    }

    [Fact]
    public void PresentButMissingQemuImgSaysReinstall()
    {
        Touch("qemu-system-x86_64.exe");
        Touch("share", QemuToolchain.CodeFileName);
        Touch("share", QemuToolchain.VarsTemplateFileName);
        var ex = Assert.Throws<QemuLocatorException>(
            () => QemuLocator.Locate(_root, Array.Empty<string>()));
        Assert.Contains("qemu-img.exe", ex.Message);
    }
}
