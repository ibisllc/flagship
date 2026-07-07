// Where the burn's seed ISO comes from. The default (and only production) path
// is [Managed] — the manifest-driven, sha-pinned download via IsoBaseCache. The
// dev/hardware-bring-up path is [LocalFile]: a seed a tester `adb push`ed and
// picked from the file picker, so a real OTG burn can be validated with NO
// hosting (docs task #22). The local path is DEV-ONLY — [resolve] drops it
// unless the build is developer-unlocked, so a shipped build can never be
// steered to an unpinned seed by, e.g., a crafted intent.
//
// The selection is kept as a pure String-based type (no android.net.Uri) so the
// choice logic is JVM-unit-testable without Robolectric.

package com.flagshipserver.app.burner.iso

sealed interface SeedSource {
    /** Manifest-driven, sha-pinned download (production default). */
    object Managed : SeedSource

    /** A locally-supplied seed (content:// URI or a file path). Dev-only. */
    data class LocalFile(val uri: String) : SeedSource

    companion object {
        /**
         * Choose the seed source. A non-blank [localSeedUri] wins ONLY when
         * [devUnlocked] (a debuggable / developer-unlocked build); otherwise the
         * managed download is always used.
         */
        fun resolve(localSeedUri: String?, devUnlocked: Boolean): SeedSource =
            if (devUnlocked && !localSeedUri.isNullOrBlank()) LocalFile(localSeedUri) else Managed
    }
}
