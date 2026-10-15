package com.flagshipserver.app.push

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class AccountNoticePushTest {
    @Test fun categoryOnlyNoticesGetTheirText() {
        assertEquals("One of your servers needs your attention.", AccountNoticePush.body(mapOf("category" to "cert-alert", "sealed" to "00")))
        assertEquals("A new server was added to your account.", AccountNoticePush.body(mapOf("category" to "server-registered", "sealed" to "")))
    }

    @Test fun otherPushesAreLeftAlone() {
        assertNull(AccountNoticePush.body(mapOf("category" to "secret-request")))
        assertNull(AccountNoticePush.body(emptyMap()))
    }
}
