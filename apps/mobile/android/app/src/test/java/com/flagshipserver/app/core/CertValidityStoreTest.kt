// Robolectric tests for CertValidityStore — the account-wide cert-validity
// window. Mirror of the iOS CertValidityStoreTests + the webapp certValidity.js.

package com.flagshipserver.app.core

import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class CertValidityStoreTest {

    private fun freshStore(): CertValidityStore {
        val ctx = ApplicationProvider.getApplicationContext<android.content.Context>()
        val prefs = ctx.getSharedPreferences("test.${System.nanoTime()}", android.content.Context.MODE_PRIVATE)
        prefs.edit().clear().apply()
        return CertValidityStore(prefs)
    }

    @Test fun defaultIsThirtyDays() {
        assertEquals(30, freshStore().days)
    }

    @Test fun presetsAreSevenThirtyNinety() {
        assertEquals(listOf(7, 30, 90), CertValidityStore.PRESETS)
    }

    @Test fun presetWritesRoundTrip() {
        val store = freshStore()
        store.days = 7
        assertEquals(7, store.days)
        store.days = 90
        assertEquals(90, store.days)
    }

    @Test fun nonPresetWriteClampsToDefault() {
        val store = freshStore()
        store.days = 7
        store.days = 45 // not a preset
        assertEquals(30, store.days)
    }
}
