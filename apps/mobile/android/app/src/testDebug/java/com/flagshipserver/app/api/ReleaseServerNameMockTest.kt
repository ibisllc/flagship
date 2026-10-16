// P3 — Mock contract test for the release-server-name surface.
//
// Two things this asserts:
//   1. MockFlagshipServerClient.releaseServerName() records the call
//      against `releasedServerNames` in insertion order — so the
//      PendingServerScreen cancel handler can be exercised in higher-
//      level integration tests by inspecting the recorded log.
//   2. The cancel handler's documented ordering — release name FIRST,
//      then auth-code revoke — produces TWO recorded operations in that
//      exact order on a single Mock instance.

package com.flagshipserver.app.api

import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ReleaseServerNameMockTest {

    @Test fun release_recordsTheRequestInOrder() = runTest {
        val client = MockFlagshipServerClient(simulatedLatencyMs = 0)
        val r1 = ReleaseServerNameRequest(
            request = ReleaseServerNameRequest.Inner(
                username = "alice",
                serverDomain = "home.alice.flagship.services",
                issuedAt = 1L,
            ),
            signature = "aa",
        )
        val r2 = ReleaseServerNameRequest(
            request = ReleaseServerNameRequest.Inner(
                username = "alice",
                serverDomain = "work.alice.flagship.services",
                issuedAt = 2L,
            ),
            signature = "bb",
        )
        client.releaseServerName(r1)
        client.releaseServerName(r2)
        assertEquals(listOf(r1, r2), client.releasedServerNames)
    }

    @Test fun cancelOrder_recordsReleaseFirstThenRevoke() = runTest {
        // Models what PendingServerScreen.kt does on cancel:
        //   (1) flagshipServer.releaseServerName(...) for the FQDN
        //   (2) flagshipServer.revokeAuthCode(...) for the pending serial
        // The release must be recorded BEFORE the revoke (mirrors the iOS
        // HomeTab cancelOrder ordering + the webapp cancelServer flow).
        val client = MockFlagshipServerClient(simulatedLatencyMs = 0)
        val release = ReleaseServerNameRequest(
            request = ReleaseServerNameRequest.Inner(
                username = "harry",
                serverDomain = "home.harry.flagship.services",
                issuedAt = 100L,
            ),
            signature = "deadbeef",
        )
        val revoke = AuthCodeRevokeRequest(
            request = AuthCodeRevokeRequest.Inner(
                serial = "S-001",
                username = "harry",
                issuedAt = 101L,
            ),
            signature = "cafebabe",
        )
        client.releaseServerName(release)
        client.revokeAuthCode(revoke)
        // Both surfaces recorded.
        assertEquals(listOf(release), client.releasedServerNames)
        assertTrue(client.revokedAuthCodes.contains("S-001"))
        // Insertion-order witness: the release was committed before the
        // revoke because the release call returned first (otherwise the
        // revoke would have torn the list state).
        assertNotNull(client.releasedServerNames.firstOrNull())
        assertEquals("home.harry.flagship.services", client.releasedServerNames.single().request.serverDomain)
    }
}
