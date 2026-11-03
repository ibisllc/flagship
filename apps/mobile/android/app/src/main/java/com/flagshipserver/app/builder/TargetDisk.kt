// The burn option `targetDisk`: the one disk the installer may erase on a computer with more than one
// (`by-id:<name>`, `serial:<serial>`, `size:<bytes>`). A burn-time choice, never a recipe field: the phone
// that signs the recipe can't see the target's disks. Same pattern as the generator's TARGET_DISK_PATTERN
// (packages/flagship-builder/src/preseed.ts); shared cases in test-vectors/install-disk-stop.json.

package com.flagshipserver.app.builder

object TargetDisk {
    val PATTERN = Regex("""^(by-id:[A-Za-z0-9._:+@-]{1,200}|serial:[A-Za-z0-9._-]{1,100}|size:[1-9][0-9]{0,19})$""")

    /** The value to pass to the generator: null when the field is empty. */
    fun normalized(raw: String): String? = raw.trim().ifEmpty { null }

    /** An empty field is valid (no option); anything else must match [PATTERN]. */
    fun isValid(raw: String): Boolean = normalized(raw)?.let { PATTERN.matches(it) } ?: true
}
