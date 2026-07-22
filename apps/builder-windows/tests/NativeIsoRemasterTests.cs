using Flagship.Builder;
using Xunit;
namespace Flagship.Builder.Tests;
public sealed class NativeIsoRemasterTests
{
 [Theory][InlineData(@"C:\Users\x\out.iso","/c/Users/x/out.iso")][InlineData("D:/tmp/seed","/d/tmp/seed")][InlineData(@"relative\dir\f.cfg","relative/dir/f.cfg")]
 public void ConvertsPaths(string input,string expected)=>Assert.Equal(expected,NativeIsoRemaster.ToXorrisoDiskPath(input));
 [Theory][InlineData("Debian 13.5.0 amd64 1",IsoFamily.Debian)][InlineData("/install.amd\n/boot",IsoFamily.Debian)][InlineData("Ubuntu based on Debian\n/casper",IsoFamily.Ubuntu)][InlineData("custom",IsoFamily.Ubuntu)]
 public void Classifies(string input,IsoFamily expected)=>Assert.Equal(expected,NativeIsoRemaster.ClassifyIsoText(input));
 [Fact]public void UbuntuTransform(){const string x="set timeout=30\nlinux /casper/vmlinuz quiet ---\nlinux16 /boot/memtest\n";var once=NativeIsoRemaster.EditGrubForAutoinstall(x);Assert.Contains("/casper/vmlinuz autoinstall ds=nocloud\\;s=/cdrom/nocloud/ quiet",once);Assert.Contains("set timeout=1",once);Assert.Equal(once,NativeIsoRemaster.EditGrubForAutoinstall(once));}
 [Fact]public void DebianTransforms(){const string g="set timeout=10\nset timeout_style=hidden\nlinux /install.amd/vmlinuz ---\nlinux /install.amd/gtk/vmlinuz ---\n";const string i="prompt 1\ntimeout 600\nappend initrd=/install.amd/initrd.gz ---\n";var go=NativeIsoRemaster.EditGrubForPreseed(g);var io=NativeIsoRemaster.EditIsolinuxForPreseed(i);Assert.Equal(2,go.Split(NativeIsoRemaster.DebianPreseedCommandLine).Length-1);Assert.Contains("set timeout_style=menu",go);Assert.Contains("timeout 1",io);Assert.Contains("prompt 0",io);Assert.Equal(go,NativeIsoRemaster.EditGrubForPreseed(go));Assert.Equal(io,NativeIsoRemaster.EditIsolinuxForPreseed(io));}
}