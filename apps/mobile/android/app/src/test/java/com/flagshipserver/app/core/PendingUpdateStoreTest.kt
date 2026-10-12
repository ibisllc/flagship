// The pending update order persists per server FQDN in the app's prefs and a
// bad stored value reads as "nothing pending".

package com.flagshipserver.app.core

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import com.flagshipserver.app.api.LastUpdate
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class PendingUpdateStoreTest {
    private val a = "home.alice.flagship.services"
    private val b = "work.alice.flagship.services"
    private val p = PendingUpdate("b".repeat(40), "v1.2.0", "a".repeat(40), 1_760_000_000_000L)

    private fun prefs() = ApplicationProvider.getApplicationContext<Context>()
        .getSharedPreferences("test.${System.nanoTime()}", Context.MODE_PRIVATE)

    @Test fun roundTripsPerServer() {
        val prefs = prefs()
        val store = SharedPrefsPendingUpdateStore(prefs)
        assertNull(store.get(a))
        store.set(a, p)
        assertEquals(p, store.get(a))
        assertEquals(p, SharedPrefsPendingUpdateStore(prefs).get(a.uppercase()))
        assertNull(store.get(b))
        store.set(b, p.copy(targetTag = null))
        store.clear(a)
        assertNull(store.get(a))
        assertEquals(p.copy(targetTag = null), store.get(b))
    }

    @Test fun aRefusalAfterTheOrderClearsItThoughItNamesNoTarget() {
        assertTrue(p.isSettled("a".repeat(40), LastUpdate(outcome = "refused", at = p.orderedAt + 1, reason = "not-endorsed")))
        assertFalse(p.isSettled("a".repeat(40), LastUpdate(outcome = "refused", at = p.orderedAt - 1, reason = "not-endorsed")))
    }

    @Test fun corruptValueReadsAsNothingPending() {
        val prefs = prefs()
        prefs.edit().putString("pending.$a", "{not json").commit()
        assertNull(SharedPrefsPendingUpdateStore(prefs).get(a))
    }
}
