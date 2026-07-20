using System;
using Xunit;
using Flagship.Builder;

namespace Flagship.Builder.Tests;

/// <summary>
/// Sanity vectors for the pure-C# Ed25519 verifier. RFC 8032 §7.1 test
/// vectors pin the math; the recipe path then depends on this returning the
/// right verdict over the canonical InstallBlob bytes.
/// </summary>
public class Ed25519VerifyTests
{
    private static byte[] H(string hex) => Hex.Decode(hex)!;

    [Fact]
    public void Rfc8032_Test1_EmptyMessage_Valid()
    {
        var pub = H("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a");
        var sig = H("e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b");
        Assert.True(Ed25519Verify.Verify(sig, Array.Empty<byte>(), pub));
    }

    [Fact]
    public void Rfc8032_Test2_OneByteMessage_Valid()
    {
        var pub = H("3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c");
        var msg = H("72");
        var sig = H("92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00");
        Assert.True(Ed25519Verify.Verify(sig, msg, pub));
    }

    [Fact]
    public void Rfc8032_Test1_TamperedMessage_Rejected()
    {
        var pub = H("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a");
        var sig = H("e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b");
        Assert.False(Ed25519Verify.Verify(sig, new byte[] { 0x00 }, pub));
    }

    [Fact]
    public void Rfc8032_Test1_FlippedSignatureBit_Rejected()
    {
        var pub = H("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a");
        var sig = H("e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b");
        sig[0] ^= 0x01;
        Assert.False(Ed25519Verify.Verify(sig, Array.Empty<byte>(), pub));
    }

    [Fact]
    public void WrongLengths_Rejected()
    {
        Assert.False(Ed25519Verify.Verify(new byte[63], Array.Empty<byte>(), new byte[32]));
        Assert.False(Ed25519Verify.Verify(new byte[64], Array.Empty<byte>(), new byte[31]));
    }
}
