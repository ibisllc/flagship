using System;
using System.Numerics;
using System.Security.Cryptography;

namespace Flagship.Builder;

/// <summary>
/// Minimal, self-contained Ed25519 signature *verification* — pure C#,
/// no NuGet dependency. .NET 8's BCL ships Ed25519 only via the platform
/// crypto provider on some OSes (not portably), so we carry a tiny ref
/// implementation here so the local recipe check matches what the
/// macOS builder does locally (CryptoKit Curve25519.Signing).
///
/// This is verify-only — we never sign in the builder; the phone signs the
/// recipe and we only need to confirm the 64-byte signature over the
/// canonical InstallBlob bytes validates under the recipe's userPubKey.
/// The math mirrors RFC 8032 §5.1.7 (the standard edwards25519 group +
/// the SHA-512 challenge), kept deliberately small and unoptimized for
/// auditability. Throughput is irrelevant: one verify per flash.
/// </summary>
public static class Ed25519Verify
{
    // Field prime p = 2^255 - 19.
    private static readonly BigInteger P =
        BigInteger.Pow(2, 255) - 19;

    // Group order L = 2^252 + 27742317777372353535851937790883648493.
    private static readonly BigInteger L =
        BigInteger.Pow(2, 252) +
        BigInteger.Parse("27742317777372353535851937790883648493");

    // d = -121665/121666 mod p.
    private static readonly BigInteger D =
        Mod(-121665 * Inv(121666));

    // The base point B (y = 4/5, recovered x) — as an extended point.
    private static readonly Point B = MakeBasePoint();

    /// <summary>
    /// True iff <paramref name="signature"/> (64 bytes) is a valid Ed25519
    /// signature of <paramref name="message"/> under <paramref name="publicKey"/>
    /// (32 bytes). Any malformed input returns false (never throws).
    /// </summary>
    public static bool Verify(ReadOnlySpan<byte> signature, ReadOnlySpan<byte> message, ReadOnlySpan<byte> publicKey)
    {
        try
        {
            if (signature.Length != 64 || publicKey.Length != 32) return false;

            // Decode A (the public key point). Reject non-canonical encodings.
            if (!TryDecodePoint(publicKey, out var a)) return false;
            // We use -A in the cofactor-free check: [S]B == R + [k]A
            // ⇔ [S]B + [k](-A) == R. Negate A by negating its X (and T).
            var negA = Negate(a);

            // R = first 32 bytes; decode as a point (must be valid).
            var rEnc = signature.Slice(0, 32);
            if (!TryDecodePoint(rEnc, out _)) return false;

            // S = last 32 bytes, little-endian scalar; must be < L.
            var sBytes = signature.Slice(32, 32).ToArray();
            var s = LeToBigInteger(sBytes);
            if (s >= L) return false;

            // k = SHA-512(R || A || M) reduced mod L.
            byte[] toHash = new byte[32 + 32 + message.Length];
            rEnc.CopyTo(toHash);
            publicKey.CopyTo(toHash.AsSpan(32));
            message.CopyTo(toHash.AsSpan(64));
            byte[] hash = SHA512.HashData(toHash);
            var k = Mod(LeToBigInteger(hash), L);

            // Check [S]B == R + [k]A  via  [S]B + [k](-A) == R.
            var sB = ScalarMul(B, s);
            var kNegA = ScalarMul(negA, k);
            var lhs = Add(sB, kNegA);

            // Compare the *encoded* form against R's encoding (robust to
            // representation differences in projective coordinates).
            var lhsEnc = EncodePoint(lhs);
            return ConstantTimeEquals(lhsEnc, rEnc);
        }
        catch
        {
            return false;
        }
    }

    // ---- edwards25519 group arithmetic (extended/projective coords) ----
    // Point = (X, Y, Z, T) with x = X/Z, y = Y/Z, x*y = T/Z.

    private readonly struct Point
    {
        public readonly BigInteger X, Y, Z, T;
        public Point(BigInteger x, BigInteger y, BigInteger z, BigInteger t)
        { X = x; Y = y; Z = z; T = t; }
    }

    private static readonly Point Identity = new Point(0, 1, 1, 0);

    private static Point MakeBasePoint()
    {
        var y = Mod(4 * Inv(5));
        var x = RecoverX(y, 0);
        return new Point(x, y, 1, Mod(x * y));
    }

    private static Point Negate(Point a) =>
        new Point(Mod(-a.X), a.Y, a.Z, Mod(-a.T));

    private static Point Add(Point a, Point b)
    {
        // Unified addition for twisted Edwards a=-1 (RFC 8032 §5.1.4).
        var A = Mod((a.Y - a.X) * (b.Y - b.X));
        var Bb = Mod((a.Y + a.X) * (b.Y + b.X));
        var C = Mod(a.T * 2 * D * b.T);
        var Dd = Mod(a.Z * 2 * b.Z);
        var E = Bb - A;
        var F = Dd - C;
        var G = Dd + C;
        var H = Bb + A;
        return new Point(Mod(E * F), Mod(G * H), Mod(F * G), Mod(E * H));
    }

    private static Point ScalarMul(Point p, BigInteger e)
    {
        var q = Identity;
        var n = e;
        var addend = p;
        while (n > 0)
        {
            if ((n & 1) == 1) q = Add(q, addend);
            addend = Add(addend, addend);
            n >>= 1;
        }
        return q;
    }

    // ---- encode / decode (RFC 8032 §5.1.2 / §5.1.3) ----

    private static byte[] EncodePoint(Point p)
    {
        var zInv = Inv(p.Z);
        var x = Mod(p.X * zInv);
        var y = Mod(p.Y * zInv);
        var bytes = ToLe32(y);
        // Stash x's low bit into the top bit of the last byte.
        bytes[31] = (byte)(bytes[31] | (byte)((x & 1) << 7));
        return bytes;
    }

    private static bool TryDecodePoint(ReadOnlySpan<byte> enc, out Point point)
    {
        point = Identity;
        if (enc.Length != 32) return false;
        var data = enc.ToArray();
        int sign = (data[31] >> 7) & 1;
        data[31] = (byte)(data[31] & 0x7f);
        var y = LeToBigInteger(data);
        if (y >= P) return false;
        BigInteger x;
        try { x = RecoverX(y, sign); }
        catch { return false; }
        point = new Point(x, y, 1, Mod(x * y));
        return true;
    }

    private static BigInteger RecoverX(BigInteger y, int sign)
    {
        // x^2 = (y^2 - 1) / (d*y^2 + 1)  (mod p)
        var y2 = Mod(y * y);
        var num = Mod(y2 - 1);
        var den = Mod(D * y2 + 1);
        var x2 = Mod(num * Inv(den));
        if (x2 == 0)
        {
            if (sign == 1) throw new InvalidOperationException("no sqrt");
            return 0;
        }
        // Candidate root: x = x2^((p+3)/8).
        var x = BigInteger.ModPow(x2, (P + 3) / 8, P);
        if (Mod(x * x - x2) != 0)
        {
            // Multiply by sqrt(-1).
            var sqrtM1 = BigInteger.ModPow(2, (P - 1) / 4, P);
            x = Mod(x * sqrtM1);
        }
        if (Mod(x * x - x2) != 0) throw new InvalidOperationException("not a square");
        if ((int)(x & 1) != sign) x = Mod(-x);
        return x;
    }

    // ---- field helpers ----

    private static BigInteger Mod(BigInteger a) => Mod(a, P);

    private static BigInteger Mod(BigInteger a, BigInteger m)
    {
        var r = a % m;
        if (r < 0) r += m;
        return r;
    }

    private static BigInteger Inv(BigInteger a) => BigInteger.ModPow(Mod(a), P - 2, P);

    private static BigInteger LeToBigInteger(byte[] le)
    {
        // BigInteger(byte[]) is little-endian; force unsigned with a 0 high byte.
        var tmp = new byte[le.Length + 1];
        Array.Copy(le, tmp, le.Length);
        return new BigInteger(tmp);
    }

    private static byte[] ToLe32(BigInteger n)
    {
        var b = n.ToByteArray(); // little-endian, possibly with sign byte / short
        var outBuf = new byte[32];
        int copy = Math.Min(b.Length, 32);
        Array.Copy(b, outBuf, copy);
        return outBuf;
    }

    private static bool ConstantTimeEquals(byte[] a, ReadOnlySpan<byte> b)
    {
        if (a.Length != b.Length) return false;
        int diff = 0;
        for (int i = 0; i < a.Length; i++) diff |= a[i] ^ b[i];
        return diff == 0;
    }
}
