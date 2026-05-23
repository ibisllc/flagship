// Robolectric tests for ServerSettingsStore — the per-server boot-unlock
// mode + lease-id persistence keyed by FQDN. Mirror of the iOS
// BootUnlockStoreTests.

package com.flagshipserver.app.core

import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class ServerSettingsStoreTest {

    private fun freshStore(): ServerSettingsStore {
        val ctx = ApplicationProvider.getApplicationContext<android.content.Context>()
        val prefs = ctx.getSharedPreferences("test.${System.nanoTime()}", android.content.Context.MODE_PRIVATE)
        prefs.edit().clear().apply()
        return ServerSettingsStore(prefs)
    }

    @Test fun modeRoundTrips() {
        val store = freshStore()
        val d = "home.alice.flagship.services"
        assertNull(store.mode(d))
        store.setMode(d, ServerSettingsStore.Mode.APPROVE)
        assertEquals(ServerSettingsStore.Mode.APPROVE, store.mode(d))
        store.setMode(d, ServerSettingsStore.Mode.AUTO)
        assertEquals(ServerSettingsStore.Mode.AUTO, store.mode(d))
    }

    // Absent ⇒ the product default ("auto"), matching the box's "absence ⇒
    // auto" rule (so cross-device approvals still deposit a self-unlock lease).
    @Test fun effectiveModeDefaultsToAutoWhenUnset() {
        assertEquals(ServerSettingsStore.Mode.AUTO, freshStore().effectiveMode("unknown.alice.flagship.services"))
    }

    @Test fun modeKeyIsCaseInsensitiveOnDomain() {
        val store = freshStore()
        store.setMode("Home.Alice.Flagship.Services", ServerSettingsStore.Mode.APPROVE)
        assertEquals(ServerSettingsStore.Mode.APPROVE, store.mode("home.alice.flagship.services"))
    }

    @Test fun leaseIdRoundTripsAndClears() {
        val store = freshStore()
        val d = "home.alice.flagship.services"
        assertNull(store.leaseId(d))
        store.setLeaseId(d, "deadbeefdeadbeef")
        assertEquals("deadbeefdeadbeef", store.leaseId(d))
        // The kill switch clears with null.
        store.setLeaseId(d, null)
        assertNull(store.leaseId(d))
    }
}
