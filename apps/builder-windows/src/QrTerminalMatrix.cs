using System;
using System.Linq;
using System.Text.RegularExpressions;

namespace Flagship.Builder;

/// <summary>Converts qrcode's ANSI "small terminal" output into QR modules.</summary>
public static partial class QrTerminalMatrix
{
    [GeneratedRegex(@"\x1B\[[0-9;]*m")]
    private static partial Regex AnsiEscape();

    public static bool[,] Parse(string? terminal)
    {
        var clean = AnsiEscape().Replace(terminal ?? string.Empty, string.Empty)
            .Replace("\r", string.Empty);
        var lines = clean.Split('\n');
        while (lines.Length > 0 && lines[^1].Length == 0) lines = lines[..^1];
        var width = lines.Length == 0 ? 0 : lines.Max(static line => line.Length);
        var modules = new bool[lines.Length * 2, width];

        for (var y = 0; y < lines.Length; y++)
        for (var x = 0; x < lines[y].Length; x++)
        {
            var glyph = lines[y][x];
            modules[y * 2, x] = glyph is '█' or '▀';
            modules[y * 2 + 1, x] = glyph is '█' or '▄';
        }
        return modules;
    }
}