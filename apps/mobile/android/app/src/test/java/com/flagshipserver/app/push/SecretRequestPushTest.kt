package com.flagshipserver.app.push

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

class SecretRequestPushTest {
    @Test fun theWorkersContentFreeWakeIsRecognised() {
        val event = SecretRequestPush.parse(
            mapOf(
                "category" to "secret-request",
                "sealed" to "",
                "kind" to "secret-request",
                "deepLink" to "https://flagshipserver.com/app/secret-requests",
            ),
        )
        assertEquals("https://flagshipserver.com/app/secret-requests", event?.deepLink)
    }

    @Test fun aCategoryAloneIsEnough() {
        assertNotNull(SecretRequestPush.parse(mapOf("category" to "secret-request", "sealed" to "")))
    }

    @Test fun otherPushesAreNot() {
        assertNull(SecretRequestPush.parse(mapOf("category" to "cert-alert")))
        assertNull(SecretRequestPush.parse(mapOf("category" to "secret-request", "kind" to "share-start-up")))
        assertNull(SecretRequestPush.parse(emptyMap()))
    }

    @Test fun theAlertNamesNoServer() {
        assertEquals("A server is waiting for your approval.", SecretRequestPush.BODY)
    }
}
