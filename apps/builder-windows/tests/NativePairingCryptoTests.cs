using System;
using System.Text;
using Xunit;

namespace Flagship.Builder.Tests;

public sealed class NativePairingCryptoTests
{
    private static byte[] Hex(string value) => Convert.FromHexString(value);

    [Fact]
    public void MatchesCrossPlatformIdentityVectors()
    {
        var code = Hex("0102030405");
        Assert.Equal("AEBAGBAF", NativePairingCrypto.HumanCode(code));
        Assert.Equal("F2x43pqWEQ9rjC9jLfItSh4RE0K3Izzb", NativePairingCrypto.SessionId(code));
        using var builder = NativePairingCrypto.ImportTestKey(Hex(new string('0', 0) + string.Concat(Enumerable.Repeat("01", 32))));
        Assert.Equal("pOCSkrZRwni5dyxWn1-puxPZBrRqtoyd-dwrRAn4ogk",
            NativePairingCrypto.Base64UrlEncode(builder.PublicKey));
        Assert.Equal("flagship://builder?c=AEBAGBAF&k=pOCSkrZRwni5dyxWn1-puxPZBrRqtoyd-dwrRAn4ogk",
            NativePairingCrypto.QrPayload("AEBAGBAF", builder.PublicKey));
    }

    [Fact]
    public void MatchesCrossPlatformKeyAndSasVectors()
    {
        using var builder = NativePairingCrypto.ImportTestKey(Hex(string.Concat(Enumerable.Repeat("01", 32))));
        var phonePublic = NativePairingCrypto.Base64UrlDecode("zo060cy2M-x7cMF4FKXHbs0CloUFDTRHRboFhw5YfVk");
        var material = NativePairingCrypto.DeriveSessionMaterial(builder.PrivateKey, phonePublic);
        Assert.Equal("658275", material.SasCode);
        Assert.Equal("638fab7912f28c5b71444e4899ccb48c553eaa1c952da13fd0985d90faec5136",
            Convert.ToHexString(material.AeadKey).ToLowerInvariant());
    }

    [Fact]
    public void OpensPinnedAesGcmShape()
    {
        var key = Hex("638fab7912f28c5b71444e4899ccb48c553eaa1c952da13fd0985d90faec5136");
        var nonce = Hex("000102030405060708090a0b");
        var plaintext = Encoding.UTF8.GetBytes("{\"hello\":\"recipe\"}");
        var body = new byte[plaintext.Length];
        var tag = new byte[16];
        using (var aes = new System.Security.Cryptography.AesGcm(key, 16))
            aes.Encrypt(nonce, plaintext, body, tag);
        var combined = body.Concat(tag).ToArray();

        var opened = NativePairingCrypto.OpenDelivered(
            NativePairingCrypto.Base64UrlEncode(combined),
            NativePairingCrypto.Base64UrlEncode(nonce), key);
        Assert.Equal(plaintext, opened);
    }

    [Fact]
    public void SessionPublishesQrBeforeNetworkStarts()
    {
        using var session = new PairSession(debug: false);
        Assert.Matches("^[A-Z2-7]{4}-[A-Z2-7]{4}$", session.HumanCodeDisplay);
        Assert.StartsWith("flagship://builder?c=", session.QrPayload);
        Assert.Contains("&k=", session.QrPayload);
        Assert.Equal(32, session.SessionId.Length);
    }}