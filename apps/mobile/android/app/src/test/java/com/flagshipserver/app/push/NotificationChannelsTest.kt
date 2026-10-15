package com.flagshipserver.app.push

import org.junit.Assert.assertEquals
import org.junit.Test

class NotificationChannelsTest {
    @Test fun eachPushCategoryHasItsChannel() {
        assertEquals(NotificationChannels.APPROVALS, NotificationChannels.forPush("secret-request", "secret-request"))
        assertEquals(NotificationChannels.APPROVALS, NotificationChannels.forPush("secret-request", ShareStartupPush.KIND))
        assertEquals(NotificationChannels.SETUP, NotificationChannels.forPush("provision-status", "provision-status"))
        for (c in listOf("server-registered", "cert-alert", "ct-unexpected-cert", "re-pair-initiated", "re-pair-urgent", "totp-failed-rate")) {
            assertEquals(c, NotificationChannels.SECURITY, NotificationChannels.forPush(c, null))
        }
        assertEquals(NotificationChannels.APPS, NotificationChannels.forPush("app-access", null))
        assertEquals(NotificationChannels.BUILDS, NotificationChannels.forPush("vibecode-needs-you", null))
        assertEquals(NotificationChannels.GENERAL, NotificationChannels.forPush("generic", null))
        assertEquals(NotificationChannels.GENERAL, NotificationChannels.forPush(null, null))
    }

    @Test fun theOriginalChannelKeepsItsId() {
        assertEquals("flagship.alerts", NotificationChannels.GENERAL.id)
        assertEquals(NotificationChannels.all.size, NotificationChannels.all.map { it.id }.toSet().size)
    }
}
