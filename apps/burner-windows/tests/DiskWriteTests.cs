using Xunit;
using Flagship.Burner;

namespace Flagship.Burner.Tests;

/// <summary>
/// Pure-helper tests for the Windows raw-writer. The native lock/dismount/write
/// dance can only be exercised on Windows against a real removable disk, so
/// here we pin only the device-path parsing + the system-disk guard — the bits
/// that gate whether we ever open a handle. (The lock/dismount sequence itself
/// is reviewed in DiskWrite.cs and matched against Rufus/Etcher behaviour.)
///
/// DiskWrite is [SupportedOSPlatform("windows")]; the parsers below touch no
/// native API, so suppress CA1416 — they run fine on the macOS/Linux CI host.
/// </summary>
#pragma warning disable CA1416
public class DiskWriteTests
{
    [Theory]
    [InlineData(@"\\.\PhysicalDrive0", true)]
    [InlineData(@"\\.\PhysicalDrive2", true)]
    [InlineData(@"\\.\PHYSICALDRIVE7", true)]
    [InlineData(@"\\.\C:", false)]
    [InlineData(@"/dev/disk2", false)]
    [InlineData("", false)]
    public void LooksLikePhysicalDrive_Classifies(string path, bool expected)
        => Assert.Equal(expected, DiskWrite.LooksLikePhysicalDrive(path));

    [Theory]
    [InlineData(@"\\.\PhysicalDrive0", 0)]
    [InlineData(@"\\.\PhysicalDrive2", 2)]
    [InlineData(@"\\.\PhysicalDrive13", 13)]
    [InlineData(@"\\.\PHYSICALDRIVE4", 4)]
    [InlineData(@"\\.\C:", -1)]
    [InlineData(@"\\.\PhysicalDrivX", -1)]
    public void ParseDriveNumber_Extracts(string path, int expected)
        => Assert.Equal(expected, DiskWrite.ParseDriveNumber(path));

    [Fact]
    public void Write_RefusesNonPhysicalDrive()
    {
        // A bogus device path must be rejected before any handle is opened.
        // Use a small temp file as the image so the size floor passes.
        var img = System.IO.Path.GetTempFileName();
        try
        {
            System.IO.File.WriteAllBytes(img, new byte[2048]);
            var ex = Assert.Throws<DiskWrite.DiskWriteException>(
                () => DiskWrite.Write(img, @"\\.\C:", _ => { }));
            Assert.Contains("non-PhysicalDrive", ex.Message);
        }
        finally { System.IO.File.Delete(img); }
    }

    [Fact]
    public void Write_RefusesSystemDriveZero()
    {
        var img = System.IO.Path.GetTempFileName();
        try
        {
            System.IO.File.WriteAllBytes(img, new byte[2048]);
            var ex = Assert.Throws<DiskWrite.DiskWriteException>(
                () => DiskWrite.Write(img, @"\\.\PhysicalDrive0", _ => { }));
            Assert.Contains("PhysicalDrive0", ex.Message);
        }
        finally { System.IO.File.Delete(img); }
    }

    [Fact]
    public void Write_RefusesTooSmallImage()
    {
        var img = System.IO.Path.GetTempFileName();
        try
        {
            System.IO.File.WriteAllBytes(img, new byte[16]);
            var ex = Assert.Throws<DiskWrite.DiskWriteException>(
                () => DiskWrite.Write(img, @"\\.\PhysicalDrive2", _ => { }));
            Assert.Contains("too small", ex.Message);
        }
        finally { System.IO.File.Delete(img); }
    }
}
#pragma warning restore CA1416
