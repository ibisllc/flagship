// Settings → Push notifications (docs/ai-privacy-and-staging.md §3a,
// "Turning alerts off"): default on, a toggle writes every box and
// (un)registers this device's push token, start/foreground resyncs the boxes,
// no access sheets while off, and a `generic` push wakes the access center.

package com.flagshipserver.app.core

import android.app.NotificationManager
import android.content.Context
import androidx.test.core.app.ApplicationProvider
import com.flagshipserver.app.api.AccessAlertsSetting
import com.flagshipserver.app.api.MockScreensClient
import com.flagshipserver.app.api.ScreensClient
import com.flagshipserver.app.api.ScreensError
import com.flagshipserver.app.push.FlagshipFcmService
import com.google.firebase.messaging.RemoteMessage
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class PushNotificationsSwitchTest {
    private lateinit var ctx: Context

    @Before fun setUp() {
        ctx = ApplicationProvider.getApplicationContext()
        ctx.getSharedPreferences("flagship.privacy", Context.MODE_PRIVATE).edit().clear().commit()
        AccessRequestBridge.onAccessRequest = null
    }

    private class Fixture(boxes: List<AccessBox>, on: Boolean = true) {
        val enabled = MutableStateFlow(on)
        val calls = mutableListOf<String>()
        var registered = true
        var registerWorks = true
        var revokeWorks = true
        var dropWorks = true
        val switch = PushNotificationsSwitch(
            enabled = enabled,
            persist = { enabled.value = it },
            boxes = { boxes },
            register = {
                calls += "register"
                if (registerWorks) registered = true
                registerWorks
            },
            revoke = {
                calls += "revoke"
                if (revokeWorks) registered = false
                revokeWorks
            },
            isRegistered = { registered },
            dropProviderToken = {
                calls += "drop"
                if (!dropWorks) error("offline")
            },
        )
    }

    private fun box(name: String, client: ScreensClient) = AccessBox("pod-$name", "$name.bright-maple.flagship.services", client)

    /** A box from before the setting: the path 404s. */
    private val olderBox = object : ScreensClient by MockScreensClient(simulatedLatencyMs = 0) {
        override suspend fun accessAlerts(): AccessAlertsSetting = throw ScreensError.Http(404, "not found")
        override suspend fun accessAlertsSet(enabled: Boolean): AccessAlertsSetting = throw ScreensError.Http(404, "not found")
    }

    @Test fun defaultIsOn_andTheChoicePersists() {
        val privacy = PrivacySettings.fromContext(ctx)
        assertTrue(privacy.pushNotificationsEnabled.value)
        privacy.setPushNotificationsEnabled(false)
        assertFalse(PrivacySettings.fromContext(ctx).pushNotificationsEnabled.value)
    }

    @Test fun turningOff_writesEveryBox_skipsAnOlderOne_andRevokesThePushToken() = runTest {
        val home = MockScreensClient(simulatedLatencyMs = 0)
        val cabin = MockScreensClient(simulatedLatencyMs = 0)
        val f = Fixture(listOf(box("home", home), box("old", olderBox), box("cabin", cabin)))
        f.switch.set(false)
        assertFalse(f.enabled.value)
        assertEquals(listOf(false), home.accessAlertsWrites)
        assertEquals(listOf(false), cabin.accessAlertsWrites)
        assertEquals(listOf("drop", "revoke"), f.calls)
        assertFalse(f.registered)

        f.switch.set(true)
        assertTrue(f.enabled.value)
        assertEquals(listOf(false, true), home.accessAlertsWrites)
        assertEquals(listOf(false, true), cabin.accessAlertsWrites)
        assertEquals(listOf("drop", "revoke", "register"), f.calls)
        assertTrue(f.registered)
    }

    @Test fun resync_writesOnlyTheBoxesThatDisagree() = runTest {
        val agrees = MockScreensClient(simulatedLatencyMs = 0).apply { accessAlertsEnabled = false }
        val differs = MockScreensClient(simulatedLatencyMs = 0).apply { accessAlertsEnabled = true }
        val f = Fixture(listOf(box("a", agrees), box("old", olderBox), box("b", differs)), on = false)
        f.registered = false
        f.switch.resync()
        assertTrue(agrees.accessAlertsWrites.isEmpty())
        assertEquals(listOf(false), differs.accessAlertsWrites)
        assertFalse(differs.accessAlertsEnabled)
        assertTrue(f.calls.isEmpty())

        // On by default: a fresh box that already pushes needs no write.
        val fresh = MockScreensClient(simulatedLatencyMs = 0)
        Fixture(listOf(box("c", fresh))).switch.resync()
        assertTrue(fresh.accessAlertsWrites.isEmpty())
    }

    @Test fun aFailedRevokeOrRegisterIsRetriedOnTheNextResync() = runTest {
        val f = Fixture(emptyList())
        f.revokeWorks = false
        f.switch.set(false)
        assertTrue(f.registered)
        f.revokeWorks = true
        f.switch.resync()
        assertFalse(f.registered)
        assertEquals(listOf("drop", "revoke", "revoke"), f.calls)
        f.switch.resync()
        assertEquals(3, f.calls.size)

        f.registerWorks = false
        f.switch.set(true)
        assertFalse(f.registered)
        f.registerWorks = true
        f.switch.resync()
        assertTrue(f.registered)
        f.switch.resync()
        assertEquals(listOf("drop", "revoke", "revoke", "register", "register"), f.calls)
    }

    @Test fun turningOff_deletesTheFcmToken_afterTheBoxWrites_evenWhenTheRevokeFails() = runTest {
        val order = mutableListOf<String>()
        val mock = MockScreensClient(simulatedLatencyMs = 0)
        val home = object : ScreensClient by mock {
            override suspend fun accessAlertsSet(enabled: Boolean): AccessAlertsSetting {
                order += "box:$enabled"
                return mock.accessAlertsSet(enabled)
            }
        }
        val enabled = MutableStateFlow(true)
        var dropFails = true
        val switch = PushNotificationsSwitch(
            enabled = enabled,
            persist = { enabled.value = it },
            boxes = { listOf(box("home", home)) },
            register = { order += "register"; true },
            revoke = { order += "revoke"; throw kotlinx.coroutines.CancellationException("prompt dismissed") },
            isRegistered = { true },
            dropProviderToken = { order += "drop"; if (dropFails) error("offline") },
        )
        // The revoke's prompt is dismissed (cancelled): the FCM token is gone already.
        runCatching { switch.set(false) }
        assertEquals(listOf("box:false", "drop", "revoke"), order)

        // A failed delete is retried on the next resync, ahead of the revoke.
        dropFails = false
        order.clear()
        runCatching { switch.resync() }
        assertEquals(listOf("drop", "revoke"), order)

        // Back on: a fresh token is fetched and registered.
        order.clear()
        switch.set(true)
        assertEquals(listOf("box:true", "register"), order)
    }

    @Test fun offShowsNoAccessSheets_butTheRequestsStayOnTheBox() = runTest {
        val mock = MockScreensClient(simulatedLatencyMs = 0)
        var on = true
        val c = AccessRequestCenter(
            boxes = { listOf(box("home", mock)) },
            alertsEnabled = { on },
            signer = { error("no signing") },
        )
        assertEquals(1, c.refresh())
        assertEquals("api.open-meteo.com", c.shown.value!!.alert.request.host)

        on = false
        assertEquals(0, c.refresh())
        assertNull(c.shown.value)
        assertEquals(0, c.refresh())
        assertNull(c.shown.value)
        assertEquals(1, mock.accessRequests().requests.size)

        on = true
        assertEquals(1, c.refresh())
        assertEquals("api.open-meteo.com", c.shown.value!!.alert.request.host)
    }

    private fun push(category: String) {
        val service = Robolectric.buildService(FlagshipFcmService::class.java).create().get()
        service.onMessageReceived(
            RemoteMessage.Builder("flagship@fcm.googleapis.com").setData(mapOf("category" to category)).build(),
        )
    }

    private fun posted() =
        shadowOf(ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).allNotifications

    @Test fun aGenericPush_wakesTheAccessCenter_withTheGenericText() {
        var wakes = 0
        AccessRequestBridge.onAccessRequest = { wakes += 1 }
        push("generic")
        assertEquals(1, wakes)
        val n = posted().single()
        assertEquals("Open Flagship to see what's new.", n.extras.getCharSequence("android.text").toString())

        push("app-access")
        assertEquals(2, wakes)
        push("cert-alert")
        assertEquals(2, wakes)
    }

    @Test fun withPushOff_aStrayPushStillWakesAnOpenApp_butShowsNothing() {
        PrivacySettings.fromContext(ctx).setPushNotificationsEnabled(false)
        var wakes = 0
        AccessRequestBridge.onAccessRequest = { wakes += 1 }
        push("generic")
        assertEquals(1, wakes)
        assertTrue(posted().isEmpty())
    }

    @Test fun copy() {
        assertEquals("Push notifications", PushNotificationsSwitch.TITLE)
        assertEquals(
            "When this is off, nothing from Flagship is pushed to this device, so Apple and Google never " +
                "see when your servers need you. You'll have to open Flagship to approve unlocks and see requests.",
            PushNotificationsSwitch.SUBTEXT,
        )
        assertEquals("generic", FlagshipFcmService.GENERIC_CATEGORY)
    }
}
