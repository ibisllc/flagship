// BootApprovalWatcher is DIRECTORY-DRIVEN (no biometric): a `pollAwaiting` closure
// reads the unauthenticated `/pods` `pendingRequests` digest and the watcher
// publishes the resulting UNIFIED Box Request Inbox (AppState.boxRequestInbox,
// keyed by fqdn → typed List<BoxRequest>) — `unlock-key` and `entitlement` are two
// `type` values in one inbox, not two parallel sets. (The old version derived the
// IRK every 5s, firing Face ID on a timer.) Kotlin mirror of the iOS tests.

package com.flagshipserver.app.core

import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class BootApprovalWatcherTest {
    private val domain = "home.demo1234.flagship.services"

    private fun req(type: SecretPurpose, nonce: String = "n1") =
        BoxRequest(nonceHex = nonce, serverDomain = domain, type = type, issuedAt = 1, expiresAt = 9_999_999_999_999)

    @Test fun publishesUnifiedInboxFromDirectory() = runTest {
        val app = AppState()
        val inbox = mapOf(domain to listOf(req(SecretPurpose.UNLOCK_KEY, "u"), req(SecretPurpose.ENTITLEMENT, "e")))
        val w = BootApprovalWatcher(app = app, pollAwaiting = { inbox })
        val published = w.pollOnce()
        assertEquals(inbox, published)
        assertEquals(inbox, app.boxRequestInbox.value)
        // The two lanes derive off the ONE inbox by `type`.
        assertTrue(app.hasLiveUnlockRequest(domain))
        assertTrue(app.hasLiveEntitlementRequest(domain))
        assertEquals(setOf(domain), app.serversAwaiting(SecretPurpose.UNLOCK_KEY))
        assertEquals(setOf(domain), app.serversAwaiting(SecretPurpose.ENTITLEMENT))
        // The flat inbox view sees both requests.
        assertEquals(2, app.boxRequests.size)
    }

    @Test fun emptyDirectoryClearsInbox() = runTest {
        val app = AppState()
        app.setBoxRequestInbox(mapOf(domain to listOf(req(SecretPurpose.UNLOCK_KEY), req(SecretPurpose.ENTITLEMENT, "e"))))
        val w = BootApprovalWatcher(app = app, pollAwaiting = { emptyMap() })
        val published = w.pollOnce()
        assertTrue(published.isEmpty())
        assertTrue(app.boxRequestInbox.value.isEmpty())
        assertFalse(app.hasLiveUnlockRequest(domain))
        assertFalse(app.hasLiveEntitlementRequest(domain))
    }

    @Test fun blipReturningPriorInboxLeavesItUntouched() = runTest {
        // The closure is best-effort: on a fetch blip it returns the prior inbox,
        // so the published inbox is unchanged — no thrash.
        val app = AppState()
        app.setBoxRequestInbox(mapOf(domain to listOf(req(SecretPurpose.UNLOCK_KEY))))
        val prior = app.boxRequestInbox.value
        val w = BootApprovalWatcher(app = app, pollAwaiting = { prior })
        assertEquals(prior, w.pollOnce())
        assertTrue(app.hasLiveUnlockRequest(domain))
    }

    @Test fun oneInboxHoldsBothTypesForOnePod() = runTest {
        // One pod can carry BOTH a unlock and an entitlement request at once —
        // they coexist in the SAME inbox entry rather than racing across two sets.
        val app = AppState()
        app.setBoxRequestInbox(mapOf(domain to listOf(req(SecretPurpose.UNLOCK_KEY, "u"), req(SecretPurpose.ENTITLEMENT, "e"))))
        assertEquals(1, app.boxRequests(domain, SecretPurpose.UNLOCK_KEY).size)
        assertEquals(1, app.boxRequests(domain, SecretPurpose.ENTITLEMENT).size)
        assertTrue(app.hasLiveUnlockRequest(domain))
        assertTrue(app.hasLiveEntitlementRequest(domain))
    }
}
