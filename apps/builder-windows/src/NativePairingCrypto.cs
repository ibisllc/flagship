using System;
using System.Security.Cryptography;
using System.Text;
using NSec.Cryptography;

namespace Flagship.Builder;

public sealed record NativePairingKeyPair(Key PrivateKey, byte[] PublicKey) : IDisposable
{
    public void Dispose() => PrivateKey.Dispose();
}

public sealed record NativeSessionMaterial(string SasCode, byte[] AeadKey);

/// <summary>
/// Native implementation of the builder pairing primitives. Protocol constants
/// and vectors are shared with TypeScript, Swift, and Kotlin implementations.
/// Secret keys are held by NSec/libsodium and disposed after each session.
/// </summary>
public static class NativePairingCrypto
{
    private static readonly byte[] RelaySalt = Encoding.UTF8.GetBytes("flagship/qr/v1");
    private static readonly byte[] EncInfo = Encoding.UTF8.GetBytes("flagship/qr/enc/v1");
    private static readonly byte[] SasInfo = Encoding.UTF8.GetBytes("flagship/qr/sas/v1");
    private static readonly byte[] SidTag = Encoding.UTF8.GetBytes("flagship/builder-sid/v1");
    private const string Base32Alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

    public static NativePairingKeyPair CreateKeyPair()
    {
        var key = Key.Create(KeyAgreementAlgorithm.X25519,
            new KeyCreationParameters { ExportPolicy = KeyExportPolicies.None });
        return new(key, key.PublicKey.Export(KeyBlobFormat.RawPublicKey));
    }

    internal static NativePairingKeyPair ImportTestKey(ReadOnlySpan<byte> privateKey)
    {
        var key = Key.Import(KeyAgreementAlgorithm.X25519, privateKey,
            KeyBlobFormat.RawPrivateKey,
            new KeyCreationParameters { ExportPolicy = KeyExportPolicies.None });
        return new(key, key.PublicKey.Export(KeyBlobFormat.RawPublicKey));
    }

    public static byte[] NewCodeBytes() => RandomNumberGenerator.GetBytes(5);

    public static string SessionId(ReadOnlySpan<byte> code)
    {
        var input = new byte[SidTag.Length + code.Length];
        SidTag.CopyTo(input, 0);
        code.CopyTo(input.AsSpan(SidTag.Length));
        return Base64UrlEncode(SHA256.HashData(input))[..32];
    }

    public static string HumanCode(ReadOnlySpan<byte> code) => Base32Encode(code);
    public static string FormatHumanCode(string code) =>
        code.Length == 8 ? $"{code[..4]}-{code[4..]}" : code;
    public static string FormatSas(string code) =>
        code.Length == 6 ? $"{code[..3]} {code[3..]}" : code;
    public static string QrPayload(string human, ReadOnlySpan<byte> publicKey) =>
        $"flagship://builder?c={human}&k={Base64UrlEncode(publicKey)}";

    public static NativeSessionMaterial DeriveSessionMaterial(
        Key privateKey, ReadOnlySpan<byte> peerPublicKey)
    {
        if (peerPublicKey.Length != 32) throw new CryptographicException("Phone public key must be 32 bytes.");
        var peer = PublicKey.Import(KeyAgreementAlgorithm.X25519, peerPublicKey, KeyBlobFormat.RawPublicKey);
        using var shared = KeyAgreementAlgorithm.X25519.Agree(privateKey, peer)
            ?? throw new CryptographicException("X25519 key agreement failed.");
        var enc = new byte[32];
        var sas = new byte[4];
        KeyDerivationAlgorithm.HkdfSha256.DeriveBytes(shared, RelaySalt, EncInfo, enc);
        KeyDerivationAlgorithm.HkdfSha256.DeriveBytes(shared, RelaySalt, SasInfo, sas);
        var value = ((uint)sas[0] << 24) | ((uint)sas[1] << 16) | ((uint)sas[2] << 8) | sas[3];
        CryptographicOperations.ZeroMemory(sas);
        return new((value % 1_000_000).ToString("D6"), enc);
    }

    public static byte[] OpenDelivered(string ciphertextB64u, string nonceB64u, ReadOnlySpan<byte> key)
    {
        var combined = Base64UrlDecode(ciphertextB64u);
        var nonce = Base64UrlDecode(nonceB64u);
        if (nonce.Length != 12 || combined.Length < 16 || key.Length != 32)
            throw new CryptographicException("Malformed pairing delivery.");
        var bodyLength = combined.Length - 16;
        var plaintext = new byte[bodyLength];
        using var aes = new AesGcm(key, 16);
        aes.Decrypt(nonce, combined.AsSpan(0, bodyLength), combined.AsSpan(bodyLength), plaintext);
        return plaintext;
    }

    public static string Base64UrlEncode(ReadOnlySpan<byte> bytes) =>
        Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    public static byte[] Base64UrlDecode(string value)
    {
        var padded = value.Replace('-', '+').Replace('_', '/');
        padded += new string('=', (4 - padded.Length % 4) % 4);
        return Convert.FromBase64String(padded);
    }

    public static string Base32Encode(ReadOnlySpan<byte> bytes)
    {
        var output = new StringBuilder();
        var buffer = 0;
        var bits = 0;
        foreach (var b in bytes)
        {
            buffer = (buffer << 8) | b;
            bits += 8;
            while (bits >= 5)
            {
                bits -= 5;
                output.Append(Base32Alphabet[(buffer >> bits) & 31]);
            }
        }
        if (bits > 0) output.Append(Base32Alphabet[(buffer << (5 - bits)) & 31]);
        return output.ToString();
    }
}