using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;

namespace Flagship.Builder;

/// <summary>
/// Remembers the owner's Wi-Fi across launches so it isn't retyped for every
/// burn. The network name is stored as is; the password only encrypted with
/// DPAPI for the current Windows user (the Mac keeps it in the Keychain).
/// This is the owner's own Wi-Fi on their own PC, so a per-user secret is the
/// right scope.
/// </summary>
public sealed class WifiCredentialStore
{
    private sealed record Stored(string? Ssid, string? Password);

    private readonly string _path;
    private readonly Func<byte[], byte[]> _protect;
    private readonly Func<byte[], byte[]> _unprotect;

    public WifiCredentialStore(string? path = null, Func<byte[], byte[]>? protect = null, Func<byte[], byte[]>? unprotect = null)
    {
        _path = path ?? Path.Combine(DefaultDir(), "wifi.json");
        _protect = protect ?? Dpapi.Protect;
        _unprotect = unprotect ?? Dpapi.Unprotect;
    }

    private static string DefaultDir()
    {
        var local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        if (string.IsNullOrEmpty(local)) local = Path.Combine(Path.GetTempPath(), "LocalAppData");
        return Path.Combine(local, "FlagshipBuilder");
    }

    public (string Ssid, string Password) Load()
    {
        Stored? s;
        try { s = JsonSerializer.Deserialize<Stored>(File.ReadAllBytes(_path)); }
        catch { return ("", ""); }
        var password = "";
        try
        {
            if (!string.IsNullOrEmpty(s?.Password))
                password = Encoding.UTF8.GetString(_unprotect(Convert.FromBase64String(s.Password)));
        }
        catch { }
        return (s?.Ssid ?? "", password);
    }

    /// <summary>Blank values clear what was stored.</summary>
    public void Save(string ssid, string password)
    {
        var trimmed = ssid.Trim();
        if (trimmed.Length == 0 && password.Length == 0)
        {
            try { File.Delete(_path); } catch { }
            return;
        }
        var stored = new Stored(
            trimmed.Length == 0 ? null : trimmed,
            password.Length == 0 ? null : Convert.ToBase64String(_protect(Encoding.UTF8.GetBytes(password))));
        Directory.CreateDirectory(Path.GetDirectoryName(_path)!);
        var tmp = _path + ".tmp";
        File.WriteAllBytes(tmp, JsonSerializer.SerializeToUtf8Bytes(stored));
        File.Move(tmp, _path, overwrite: true);
    }

    /// <summary>CryptProtectData / CryptUnprotectData for the current user.</summary>
    private static class Dpapi
    {
        [StructLayout(LayoutKind.Sequential)]
        private struct Blob
        {
            public int Size;
            public IntPtr Data;
        }

        private const int UiForbidden = 0x1;

        [DllImport("crypt32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        private static extern bool CryptProtectData(ref Blob dataIn, string? description, IntPtr entropy,
                                                    IntPtr reserved, IntPtr prompt, int flags, out Blob dataOut);

        [DllImport("crypt32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        private static extern bool CryptUnprotectData(ref Blob dataIn, IntPtr description, IntPtr entropy,
                                                      IntPtr reserved, IntPtr prompt, int flags, out Blob dataOut);

        [DllImport("kernel32.dll")]
        private static extern IntPtr LocalFree(IntPtr mem);

        public static byte[] Protect(byte[] data) => Run(data, true);
        public static byte[] Unprotect(byte[] data) => Run(data, false);

        private static byte[] Run(byte[] data, bool protect)
        {
            if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException("DPAPI is Windows-only.");
            var handle = GCHandle.Alloc(data, GCHandleType.Pinned);
            try
            {
                var input = new Blob { Size = data.Length, Data = handle.AddrOfPinnedObject() };
                var ok = protect
                    ? CryptProtectData(ref input, "Flagship Studio Wi-Fi", IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, UiForbidden, out var output)
                    : CryptUnprotectData(ref input, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, UiForbidden, out output);
                if (!ok) throw new InvalidOperationException($"DPAPI failed ({Marshal.GetLastWin32Error()}).");
                try
                {
                    var result = new byte[output.Size];
                    Marshal.Copy(output.Data, result, 0, output.Size);
                    return result;
                }
                finally
                {
                    LocalFree(output.Data);
                }
            }
            finally
            {
                handle.Free();
            }
        }
    }
}
