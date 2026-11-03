using System.Text.RegularExpressions;

namespace Flagship.Builder;

/// <summary>
/// A recipe made by a Flagship app older than 0.3 names <c>installerGitRef: "main"</c> (or a tag) in its signed
/// install blob, never an exact commit, and the bootstrap refuses to install anything but an exact commit.
/// Studio checks this when the recipe is loaded and refuses with an "update the app" sentence, creating nothing
/// (owner rule F9). Contract: the <c>olderAppRecipe</c> section of apps/desktop-shared/golden/vm-core-vectors.json,
/// shared with the Mac and Linux Studios and Android.
/// </summary>
public static class OlderAppRecipe
{
    private static readonly Regex Commit = new("^[0-9a-f]{40}$", RegexOptions.CultureInvariant);

    public static string Message => Strings.T("recipeMadeByOlderApp");

    /// <summary>true when the ref is not an exact 40-character lowercase commit (after trimming), absent included.</summary>
    public static bool IsFromOlderApp(string? installerGitRef) =>
        installerGitRef is null || !Commit.IsMatch(installerGitRef.Trim());

    /// <summary>The refusal for a loaded recipe; null when it may go ahead.</summary>
    public static string? Refusal(Recipe recipe) => IsFromOlderApp(recipe.InstallerGitRef) ? Message : null;
}
