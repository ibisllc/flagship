package com.flagshipserver.app.push

import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ShareStartupPushTest {
    private val shared = mapOf("category" to "secret-request", "sealed" to "", "kind" to "share-start-up")

    @Test fun aSharedStartUpIsNotTheOwnersApprovalList() {
        assertTrue(ShareStartupPush.matches(shared))
        assertNull(SecretRequestPush.parse(shared))
        assertFalse(ShareStartupPush.matches(mapOf("kind" to "secret-request", "serverFqdn" to "h", "purpose" to "unlock-key")))
    }
}
