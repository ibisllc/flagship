// Phone-sized screens run portrait-only; tablet-sized screens are left to the
// system. Mirror of the phone half of iOS OrientationPolicy.swift — the iOS
// tablet half (landscape-only) has no Android equivalent: targeting API 36,
// Android 16 ignores orientation requests on displays with a smallest width
// of 600dp or more. Decided per screen rather than per device so a foldable
// switches correctly when it opens or closes.

package com.flagshipserver.app.core

import android.content.pm.ActivityInfo

object OrientationPolicy {
    /** Smallest-width threshold, in dp, at which a screen counts as tablet-sized
     *  (Android's own large-screen boundary, and the iOS policy's 600pt). */
    const val TABLET_MIN_SMALLEST_WIDTH_DP = 600

    /** The `requestedOrientation` for a screen of the given smallest width.
     *  0 is Configuration.SMALLEST_SCREEN_WIDTH_DP_UNDEFINED: leave it to the
     *  system rather than guess. */
    fun requestedOrientation(smallestScreenWidthDp: Int): Int =
        if (smallestScreenWidthDp in 1 until TABLET_MIN_SMALLEST_WIDTH_DP) {
            ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
        } else {
            ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
        }
}
