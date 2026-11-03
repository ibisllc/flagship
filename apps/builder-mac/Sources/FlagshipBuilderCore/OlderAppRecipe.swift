import Foundation

/// A recipe made by a Flagship app older than 0.3 names `installerGitRef: "main"` (or a tag) in its signed
/// install blob, never an exact commit, and the bootstrap refuses to install anything but an exact commit.
/// Studio checks this when the recipe is loaded and refuses with an "update the app" sentence, creating
/// nothing (owner rule F9). Contract: the `olderAppRecipe` section of
/// apps/desktop-shared/golden/vm-core-vectors.json, shared with the Windows and Linux Studios and Android.
public enum OlderAppRecipe {
    public static var message: String {
        String(localized: "This recipe was made by an older version of the Flagship app. Update the Flagship app on your phone, then create the server again.")
    }

    /// true when the ref is not an exact 40-character lowercase commit (after trimming), absent included.
    public static func isFromOlderApp(installerGitRef: String?) -> Bool {
        guard let ref = installerGitRef?.trimmingCharacters(in: .whitespacesAndNewlines) else { return true }
        return !(ref.count == 40 && ref.allSatisfy { ("0"..."9").contains($0) || ("a"..."f").contains($0) })
    }

    /// The refusal for a loaded recipe; nil when it may go ahead.
    public static func refusal(for recipe: Recipe) -> String? {
        isFromOlderApp(installerGitRef: recipe.installerGitRef) ? message : nil
    }
}
