package com.flagshipserver.app.push

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AccessListsPushTest {
    @Test fun matchesTheContentFreeFcmPayload() {
        assertTrue(AccessListsPush.matches(mapOf("category" to "access-lists")))
        assertTrue(AccessListsPush.matches(mapOf("kind" to "access-lists")))
        assertFalse(AccessListsPush.matches(mapOf("category" to "invite-created")))
        assertFalse(AccessListsPush.matches(emptyMap()))
    }

    @Test fun showsTheFixedTextAndOpensTheAccountActivity() {
        assertEquals("Flagship", AccessListsPush.TITLE)
        assertEquals("Pro ended, so your apps use one access list on all your servers again.", AccessListsPush.BODY)
        assertTrue(AccessListsPush.deepLink().endsWith("/app/account/activity"))
    }

    @Test fun postsOnTheAccountAlertsChannel() {
        assertEquals(NotificationChannels.SECURITY, NotificationChannels.forPush("access-lists", null))
    }
}
