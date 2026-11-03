// A recipe made by a Flagship app older than 0.3 names installerGitRef "main"
// (or a tag) in its signed install blob, never an exact commit, and the
// bootstrap refuses to install anything but an exact commit. The phone's USB
// burn checks this when it loads the recipe and refuses with an "update the
// app" sentence, writing nothing (owner rule F9). The same rule as the three
// Studios (vm-core-vectors.json "olderAppRecipe").

package com.flagshipserver.app.builder.iso

import com.flagshipserver.app.R
import com.flagshipserver.app.core.FSStrings

object OlderAppRecipe {
    private val COMMIT = Regex("[0-9a-f]{40}")

    fun message(): String = FSStrings.get(R.string.recipe_made_by_older_app)

    /** true when the ref is not an exact 40-character lowercase commit (after trimming), absent included. */
    fun isFromOlderApp(installerGitRef: String?): Boolean =
        installerGitRef == null || !COMMIT.matches(installerGitRef.trim())

    /** The refusal for a parsed recipe; null when the burn may go ahead. */
    fun refusal(recipe: ParsedRecipe): String? = if (isFromOlderApp(recipe.installerGitRef)) message() else null
}
