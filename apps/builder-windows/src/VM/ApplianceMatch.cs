using System.Linq;

namespace Flagship.Builder.VM;

/// <summary>
/// Whether a prebuilt appliance can host a recipe. The appliance's bootstrap refuses a release that is not
/// the exact commit signed into the recipe, so a recipe naming an exact commit (every 0.3 recipe) matches
/// only the manifest's <c>commit</c>: the release installed on the image. <c>installerGitRef</c> is only the
/// label the image is published under ("main", kept for 0.2 Studios). A recipe naming a branch or tag (made
/// by an app older than 0.3, refused at load anyway) keeps the old label match. Mirrors the Mac
/// ApplianceMatch.swift; pinned by vm-core-vectors.json "applianceMatch".
/// </summary>
public static class ApplianceMatch
{
    public static bool IsExactCommit(string? r) =>
        r is { Length: 40 } && r.All(c => c is >= '0' and <= '9' or >= 'a' and <= 'f');

    public static bool Matches(string installerGitRef, string? commit, string recipeRef)
    {
        var r = recipeRef.Trim();
        return IsExactCommit(r) ? commit == r : installerGitRef == r;
    }

    /// <summary>What the image holds, as the mismatch sentence names it.</summary>
    public static string Published(string installerGitRef, string? commit, string recipeRef) =>
        IsExactCommit(recipeRef.Trim()) ? commit ?? installerGitRef : installerGitRef;
}
