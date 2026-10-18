// Device report 2026-10-18 (#6): Home's header said "elated-iris" after a
// relaunch and "Elated Iris > Pixel" before it. The names are kept on the phone.

package com.flagshipserver.app.core

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class PresentationNameStoreTest {
    private lateinit var ctx: Context

    @Before fun setUp() {
        ctx = ApplicationProvider.getApplicationContext()
        PresentationNameStore.from(ctx).clear()
    }

    private fun relaunch(): AppState =
        AppState().also { it.presentationNames = PresentationNameStore.from(ctx) }

    @Test fun theHeaderKeepsItsNamesAcrossARelaunch() {
        val first = relaunch()
        first.completeOnboarding("elated-iris", emptyList())
        assertNull(first.activeProfile?.accountDisplayName)
        first.cachePresentationNames("Elated Iris", "Pixel")
        assertEquals("Elated Iris > Pixel", homeLine(first))

        val second = relaunch()
        second.restorePersistedSession("elated-iris")
        assertEquals("Elated Iris > Pixel", homeLine(second))
    }

    @Test fun anotherAccountDoesNotInheritTheNames() {
        val first = relaunch()
        first.completeOnboarding("elated-iris", emptyList())
        first.cachePresentationNames("Elated Iris", "Pixel")
        val other = relaunch()
        other.restorePersistedSession("bright-maple")
        assertEquals("bright-maple", homeLine(other))
    }

    @Test fun aLaterNullNameKeepsWhatWasSaved() {
        val store = PresentationNameStore.from(ctx)
        store.put("elated-iris", "Elated Iris", "Pixel")
        store.put("elated-iris", null, "Pixel 9")
        assertEquals(PresentationNameStore.Names("Elated Iris", "Pixel 9"), store.get("elated-iris"))
    }

    private fun homeLine(app: AppState): String {
        val p = app.activeProfile
        return com.flagshipserver.app.ui.screens.homeIdentityLine(p?.accountDisplayName, app.currentUser.value.orEmpty(), p?.deviceDisplayName)
    }
}
