package com.flagshipserver.app.core

import android.content.pm.ActivityInfo
import org.junit.Assert.assertEquals
import org.junit.Test

class OrientationPolicyTest {
    @Test fun phoneSizedScreensArePortraitOnly() {
        assertEquals(ActivityInfo.SCREEN_ORIENTATION_PORTRAIT, OrientationPolicy.requestedOrientation(360))
        assertEquals(ActivityInfo.SCREEN_ORIENTATION_PORTRAIT, OrientationPolicy.requestedOrientation(599))
    }

    @Test fun tabletSizedScreensAreLeftToTheSystem() {
        assertEquals(ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED, OrientationPolicy.requestedOrientation(600))
        assertEquals(ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED, OrientationPolicy.requestedOrientation(840))
    }

    @Test fun anUndefinedWidthIsLeftToTheSystem() {
        assertEquals(ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED, OrientationPolicy.requestedOrientation(0))
    }
}
