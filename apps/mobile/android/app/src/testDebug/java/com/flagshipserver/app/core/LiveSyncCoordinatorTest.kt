// LiveSync — the Android app-scope single live-update canal. ONE /stream
// long-poll feeds the SAME shared state the views read (AppState.pods via the
// reconciler + AppState.boxRequestInbox), so a waiting box / an advancing
// install phase / a new pod surfaces with no manual refresh. Driven by the
// MockSecretMailboxClient — no real network, no hang. Kotlin parity for the iOS
// LiveSyncCoordinatorTests.

package com.flagshipserver.app.core

import com.flagshipserver.app.api.LiveSyncResponse
import com.flagshipserver.app.api.MockSecretMailboxClient
import com.flagshipserver.app.api.PendingPodEntry
import com.flagshipserver.app.api.PodDirectoryEntry
import com.flagshipserver.app.api.PendingRequestSummaryWire
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class LiveSyncCoordinatorTest {

    private fun signedInApp(user: String = "harry"): AppState =
        AppState().also { it.completeOnboarding(user, emptyList()) }

    private fun coordinator(
        app: AppState,
        mailbox: MockSecretMailboxClient,
        active: () -> Boolean = { true },
    ) = LiveSyncCoordinator(
        app = app,
        mailbox = mailbox,
        isActiveGate = active,
        makeReconciler = { PendingServerReconciler(app, mailbox) },
        jitterMs = { 0 },
    )

    private fun pod(fqdn: String, requests: List<PendingRequestSummaryWire> = emptyList()) =
        PodDirectoryEntry(serverDomain = fqdn, identityPubKey = "00".repeat(32), pendingRequests = requests)
    private fun unlockReq(nonce: String) =
        PendingRequestSummaryWire(id = nonce, type = SecretPurpose.UNLOCK_KEY.wire, issuedAt = 1, expiresAt = 9_999_999_999_999)
    private fun order(name: String, phase: String) =
        PendingPodEntry(orderRef = OrderRef.compute("S-$name"), serverName = name, fqdn = "$name.harry.flagship.services", phase = phase, createdAt = 1L)

    // The last cursor we saw is echoed back on the next request.
    @Test fun echoesCursor() = runTest {
        val app = signedInApp()
        val mailbox = MockSecretMailboxClient().apply {
            liveSyncScript = mutableListOf(
                LiveSyncResponse(cursor = "c1", username = "harry"),
                LiveSyncResponse(cursor = "c2", username = "harry"),
            )
        }
        val coord = coordinator(app, mailbox)
        coord.tickOnce() // first connect: cursor null → c1
        coord.tickOnce() // echoes c1 → c2
        assertEquals(listOf<String?>(null, "c1"), mailbox.liveSyncCursors)
    }

    // A new pendingRequest in the stream surfaces in the Box Request Inbox
    // ("authorize boot" becomes actionable).
    @Test fun newPendingRequestSurfacesInInbox() = runTest {
        val app = signedInApp()
        val domain = "home.harry.flagship.services"
        val mailbox = MockSecretMailboxClient().apply {
            liveSyncScript = mutableListOf(
                LiveSyncResponse(cursor = "c1", username = "harry", pods = listOf(pod(domain))),
                LiveSyncResponse(cursor = "c2", username = "harry", pods = listOf(pod(domain, listOf(unlockReq("u1"))))),
            )
        }
        val coord = coordinator(app, mailbox)
        coord.tickOnce()
        assertTrue(app.boxRequestInbox.value.isEmpty())
        coord.tickOnce()
        assertEquals(setOf(domain), app.serversAwaiting(SecretPurpose.UNLOCK_KEY))
    }

    // A pending order surfaces as a pending pod (checklist advances).
    @Test fun pendingOrderSurfacesFromStream() = runTest {
        val app = signedInApp()
        val mailbox = MockSecretMailboxClient().apply {
            liveSyncScript = mutableListOf(
                LiveSyncResponse(cursor = "p1", username = "harry", pending = listOf(order("blog", "partitioning"))),
            )
        }
        coordinator(app, mailbox).tickOnce()
        assertEquals(1, app.pods.value.size)
        assertEquals(PodInfo.Status.PENDING, app.pods.value.single().status)
        assertEquals("blog", app.pods.value.single().name)
    }

    // A new registered pod appears (flips to ONLINE).
    @Test fun newRegisteredPodAppears() = runTest {
        val app = signedInApp()
        val mailbox = MockSecretMailboxClient().apply {
            liveSyncScript = mutableListOf(
                LiveSyncResponse(cursor = "r1", username = "harry", pods = listOf(pod("home.harry.flagship.services"))),
            )
        }
        coordinator(app, mailbox).tickOnce()
        assertEquals(1, app.pods.value.size)
        assertEquals(PodInfo.Status.ONLINE, app.pods.value.single().status)
    }

    // An unchanged cursor (a held timeout) does NOT churn the shared state.
    @Test fun unchangedCursorDoesNotRefeed() = runTest {
        val app = signedInApp()
        val domain = "home.harry.flagship.services"
        val mailbox = MockSecretMailboxClient().apply {
            liveSyncScript = mutableListOf(
                LiveSyncResponse(cursor = "c1", username = "harry", pods = listOf(pod(domain, listOf(unlockReq("u1"))))),
                LiveSyncResponse(cursor = "c1", username = "harry", pods = emptyList()), // same cursor = timeout hold: must be ignored
            )
        }
        val coord = coordinator(app, mailbox)
        coord.tickOnce()
        assertEquals(setOf(domain), app.serversAwaiting(SecretPurpose.UNLOCK_KEY))
        coord.tickOnce()
        assertEquals(setOf(domain), app.serversAwaiting(SecretPurpose.UNLOCK_KEY)) // unchanged: a held timeout must not blank it
    }

    // When inactive (backgrounded / locked / signed out) it does NOT poll.
    @Test fun doesNotPollWhenInactive() = runTest {
        val app = signedInApp()
        val mailbox = MockSecretMailboxClient().apply {
            liveSyncScript = mutableListOf(
                LiveSyncResponse(cursor = "c1", username = "harry", pods = listOf(pod("home.harry.flagship.services", listOf(unlockReq("u1"))))),
            )
        }
        val coord = coordinator(app, mailbox, active = { false })
        coord.start(this)
        kotlinx.coroutines.delay(50)
        coord.stop()
        assertTrue("no /stream request while inactive", mailbox.liveSyncCursors.isEmpty())
        assertTrue(app.boxRequestInbox.value.isEmpty())
    }

    // On a /stream error it falls back to /pods (behavior never degrades).
    @Test fun fallsBackToPodsOnStreamError() = runTest {
        val app = signedInApp()
        val domain = "home.harry.flagship.services"
        val mailbox = MockSecretMailboxClient().apply {
            // /stream throws; the /pods fallback (built from `directory`) carries
            // the request, so the shared state is still fed.
            liveSyncError = RuntimeException("stream down")
            directory = listOf(pod(domain, listOf(unlockReq("u1"))))
        }
        val coord = coordinator(app, mailbox)
        val delay = coord.tickOnce()
        assertTrue("marked degraded after a stream error", coord.degraded)
        assertEquals(setOf(domain), app.serversAwaiting(SecretPurpose.UNLOCK_KEY))
        // Fallback waits the longer cadence (not an immediate reconnect).
        assertTrue(delay >= LiveSyncCoordinator.FALLBACK_MS)
    }
}
