// The widget's snapshot carries only what iOS's widget shows (name, address,
// state, leader) and is emptied on sign-out.

package com.flagshipserver.app.companion

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import com.flagshipserver.app.core.PodInfo
import com.flagshipserver.companion.PodStatusSnapshot
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class PodStatusStoreTest {

    private val pods = listOf(
        PodInfo(podId = "home", name = "Home", description = "Living room", fqdn = "home.bright-maple.flagship.services", status = PodInfo.Status.ONLINE),
        PodInfo(podId = "office", name = "Office", fqdn = "office.bright-maple.flagship.services", status = PodInfo.Status.OFFLINE),
    )

    @Test fun snapshotCarriesNameAddressStateAndLeader() {
        val s = PodStatusStore.snapshot(true, "bright-maple", pods, "office", "flagshipserver.com", now = 7)
        assertEquals(
            listOf(
                PodStatusSnapshot.Pod("home", "Home", "home.bright-maple.flagship.services", "online", false),
                PodStatusSnapshot.Pod("office", "Office", "office.bright-maple.flagship.services", "offline", true),
            ),
            s.pods,
        )
        assertEquals("bright-maple", s.username)
        assertEquals(7L, s.updatedAt)
        assertTrue("no description reaches the widget", "Living room" !in s.encode())
    }

    @Test fun signedOutIsEmpty() {
        val s = PodStatusStore.snapshot(false, "bright-maple", pods, "home", "flagshipserver.com")
        assertTrue(s.pods.isEmpty())
        assertEquals(null, s.username)
    }

    @Test fun storeRoundTripsAndSkipsUnchangedPublishes() = runTest {
        val ctx = ApplicationProvider.getApplicationContext<Context>()
        val store = PodStatusStore.from(ctx)
        assertEquals(PodStatusSnapshot.EMPTY, store.read())
        val first = PodStatusStore.snapshot(true, "u", pods, "home", "flagshipserver.com", now = 1)
        CompanionPublisher.publishStatus(ctx, first)
        assertEquals(first, store.read())
        CompanionPublisher.publishStatus(ctx, first.copy(updatedAt = 99))
        assertEquals("a timestamp-only change isn't rewritten", 1L, store.read().updatedAt)
    }
}
