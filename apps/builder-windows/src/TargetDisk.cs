using System.Text.RegularExpressions;
namespace Flagship.Builder;

/// <summary>
/// The optional "Disk to install on" burn option (B2 #9): the one disk the USB installer erases on a machine with
/// more than one. Same pattern as the generator (packages/flagship-builder/src/preseed.ts TARGET_DISK_PATTERN,
/// pinned by test-vectors/install-disk-stop.json). Never part of the signed recipe, never used for hosted VMs.
/// </summary>
public static class TargetDisk
{
    public static readonly Regex Pattern = new(
        "^(by-id:[A-Za-z0-9._:+@-]{1,200}|serial:[A-Za-z0-9._-]{1,100}|size:[1-9][0-9]{0,19})$",
        RegexOptions.CultureInvariant);

    /// <summary>The trimmed value, or null when the field is blank (no option).</summary>
    public static string? Normalize(string? input)
    {
        var t = input?.Trim() ?? "";
        return t.Length == 0 ? null : t;
    }

    /// <summary>True when the field is blank or names a disk in one of the three forms.</summary>
    public static bool IsValid(string? input)
    {
        var t = Normalize(input);
        return t is null || Pattern.IsMatch(t);
    }
}
