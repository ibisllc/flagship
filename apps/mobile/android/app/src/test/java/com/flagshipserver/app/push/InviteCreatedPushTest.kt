package com.flagshipserver.app.push

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class InviteCreatedPushTest {
    @Test fun matchesTheContentFreeFcmPayload() {
        assertTrue(InviteCreatedPush.matches(mapOf(
            "category" to "invite-created",
            "kind" to "invite-created",
            "deepLink" to "https://flagshipserver.com/app/account/activity",
        )))
        assertTrue(InviteCreatedPush.matches(mapOf("kind" to "invite-created")))
        assertFalse(InviteCreatedPush.matches(mapOf("category" to "server-registered")))
        assertFalse(InviteCreatedPush.matches(emptyMap()))
    }

    @Test fun showsTheFixedTextAndOpensTheAccountActivity() {
        assertEquals("Flagship", InviteCreatedPush.TITLE)
        assertEquals("A device on your account invited someone to one of your apps.", InviteCreatedPush.BODY)
        assertTrue(InviteCreatedPush.deepLink().endsWith("/app/account/activity"))
    }

    @Test fun postsOnTheAccountAlertsChannel() {
        assertEquals(NotificationChannels.SECURITY, NotificationChannels.forPush("invite-created", "invite-created"))
    }
}
