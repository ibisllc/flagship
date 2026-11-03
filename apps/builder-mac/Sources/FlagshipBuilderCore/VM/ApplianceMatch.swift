import Foundation

/// Whether a prebuilt appliance can host a recipe. The appliance's bootstrap refuses a release that is not
/// the exact commit the phone signed into the recipe, so a recipe naming an exact commit (every 0.3 recipe)
/// matches only the manifest's `commit`: the release installed on the image. `installerGitRef` is only the
/// label the image is published under ("main", kept for 0.2 Studios), never proof of what it holds. A recipe
/// naming a branch or tag (made by an app older than 0.3, refused before hosting anyway) keeps the old label
/// match. Contract: the `applianceMatch` section of apps/desktop-shared/golden/vm-core-vectors.json, shared
/// with the Windows Studio and the Node CLI the Linux Studio provisions through.
public enum ApplianceMatch {
    public static func isExactCommit(_ ref: String) -> Bool {
        ref.count == 40 && ref.allSatisfy { ("0"..."9").contains($0) || ("a"..."f").contains($0) }
    }

    public static func matches(installerGitRef: String, commit: String?, recipeRef: String) -> Bool {
        let ref = recipeRef.trimmingCharacters(in: .whitespacesAndNewlines)
        if isExactCommit(ref) { return commit == ref }
        return installerGitRef == ref
    }

    /// What the image holds, as the mismatch sentence names it: its commit for an exact-commit recipe.
    public static func published(installerGitRef: String, commit: String?, recipeRef: String) -> String {
        let ref = recipeRef.trimmingCharacters(in: .whitespacesAndNewlines)
        if isExactCommit(ref) { return commit ?? installerGitRef }
        return installerGitRef
    }
}
