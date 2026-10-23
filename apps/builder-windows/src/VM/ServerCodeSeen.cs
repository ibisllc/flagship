using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace Flagship.Builder.VM;

/// <summary>
/// First contact, Studio's half (docs/first-contact.md). A server Studio hosts prints its six-digit code
/// and its key on a dedicated output-only virtio port; Studio, which got a per-server
/// `studioConfirmKey` from the phone beside the recipe (never inside it), reports what it saw to `.com`
/// as an HMAC the phone checks, so the phone can show "Confirmed by Studio" in place of asking the owner
/// to compare the code. Mirrors `serverSeenMacHex` in packages/protocol/src/enrollment.ts and the Mac
/// and Linux Studios.
/// </summary>
public static class ServerCodeSeen
{
    /// <summary>The guest sees it as /dev/virtio-ports/&lt;PortName&gt;. Output only: the host never writes to it.</summary>
    public const string PortName = "org.flagshipserver.server-code";
    public const string SeenTag = "flagship/server-code-seen/v1";

    public sealed record Sighting(string Code, string StkPubHex);

    private static bool IsHex64(string s) => s.Length == 64 && s.All(c => (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'));

    /// <summary>`flagship-server-code &lt;domain&gt; &lt;6 digits&gt; &lt;64 lowercase hex&gt;`, for this server only.</summary>
    public static Sighting? Parse(string line, string serverDomain)
    {
        var parts = line.Trim().Split(' ', StringSplitOptions.RemoveEmptyEntries);
        if (parts.Length != 4 || parts[0] != "flagship-server-code") return null;
        if (!string.Equals(parts[1], serverDomain, StringComparison.OrdinalIgnoreCase)) return null;
        if (parts[2].Length != 6 || !parts[2].All(c => c >= '0' && c <= '9')) return null;
        if (!IsHex64(parts[3])) return null;
        return new Sighting(parts[2], parts[3]);
    }

    public static string? MacHex(byte[] studioConfirmKey, string serverDomain, string stkPubHex)
    {
        if (studioConfirmKey.Length != 32 || !IsHex64(stkPubHex) || serverDomain.Contains('|')) return null;
        var mac = HMACSHA256.HashData(studioConfirmKey, Encoding.UTF8.GetBytes($"{SeenTag}|{serverDomain.ToLowerInvariant()}|{stkPubHex}"));
        return Convert.ToHexString(mac).ToLowerInvariant();
    }

    /// <summary>The JSON body of `POST /api/order/&lt;serial&gt;/server-seen`.</summary>
    public static string Body(string stkPubHex, string macHex) =>
        JsonSerializer.Serialize(new Dictionary<string, string> { ["macHex"] = macHex, ["stkPubHex"] = stkPubHex });

    /// <summary>"482 913", the way the box shows it.</summary>
    public static string Pretty(string code) => code.Length == 6 ? $"{code[..3]} {code[3..]}" : code;

    /// <summary>The file the VM's server-code port writes, beside its bundle.</summary>
    public static string PortLogPath(VMBundleLayout layout, string name) => Path.Combine(layout.BundleDir(name), "server-code.log");
}

/// <summary>Splits the port's bytes into lines; a line longer than any real one is dropped, not buffered forever.</summary>
public sealed class ConsoleLineSplitter
{
    private readonly List<byte> _buffer = new();
    private readonly int _maxLine;

    public ConsoleLineSplitter(int maxLine = 4096) { _maxLine = maxLine; }

    public IReadOnlyList<string> Feed(ReadOnlySpan<byte> data)
    {
        var lines = new List<string>();
        foreach (var b in data)
        {
            if (b == (byte)'\n')
            {
                lines.Add(Encoding.UTF8.GetString(_buffer.ToArray()));
                _buffer.Clear();
            }
            else
            {
                _buffer.Add(b);
            }
        }
        if (_buffer.Count > _maxLine) _buffer.Clear();
        return lines;
    }
}

/// <summary>The per-server key, beside the VM bundle, until Studio has reported what it saw.</summary>
public static class StudioConfirmKeyFile
{
    public static string PathFor(VMBundleLayout layout, string name) => Path.Combine(layout.BundleDir(name), "studio-confirm.key");

    public static void Write(byte[] key, VMBundleLayout layout, string name)
    {
        if (key.Length != 32) return;
        File.WriteAllBytes(PathFor(layout, name), key);
    }

    public static byte[]? Read(VMBundleLayout layout, string name)
    {
        try
        {
            var d = File.ReadAllBytes(PathFor(layout, name));
            return d.Length == 32 ? d : null;
        }
        catch
        {
            return null;
        }
    }

    public static void Delete(VMBundleLayout layout, string name)
    {
        try { File.Delete(PathFor(layout, name)); } catch { }
    }
}
