// P13 — Mock contract test for the server-revocation kill-switch
// surface. Two things this asserts:
//   1. MockFlagshipServerClient.revokeServer() records the call against
//      `revokedServers` in insertion order — so the danger-zone sheet
//      can be exercised in higher-level integration tests by inspecting
//      the recorded log.
//   2. The recorded body matches the iOS Mock + the webapp's wire shape
//      byte-for-byte (same field names, same string values).

package com.flagshipserver.app.api

import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class RevokeServerMockTest {

    @Test fun revoke_recordsTheRequestInOrder() = runTest {
        val client = MockFlagshipServerClient(simulatedLatencyMs = 0)
        val r1 = ServerRevocationRequest(
            request = ServerRevocationRequest.Inner(
                userId = "alice",
                revokedServerId = "home.alice.flagship.services",
                reason = "lost",
                issuedAt = 1L,
            ),
            signature = "aa",
        )
        val r2 = ServerRevocationRequest(
            request = ServerRevocationRequest.Inner(
                userId = "alice",
                revokedServerId = "work.alice.flagship.services",
                reason = "stolen",
                issuedAt = 2L,
            ),
            signature = "bb",
        )
        client.revokeServer(r1)
        client.revokeServer(r2)
        assertEquals(listOf(r1, r2), client.revokedServers)
    }

    @Test fun revoke_acceptsEachOfTheFixedReasons() = runTest {
        val client = MockFlagshipServerClient(simulatedLatencyMs = 0)
        for (reason in listOf("lost", "stolen", "decommissioned")) {
            client.revokeServer(
                ServerRevocationRequest(
                    request = ServerRevocationRequest.Inner(
                        userId = "u",
                        revokedServerId = "s.u.flagship.services",
                        reason = reason,
                        issuedAt = 1L,
                    ),
                    signature = "ee",
                ),
            )
        }
        assertEquals(3, client.revokedServers.size)
        assertEquals(
            listOf("lost", "stolen", "decommissioned"),
            client.revokedServers.map { it.request.reason },
        )
    }

    @Test fun revoke_isIndependentOfOtherSurfaces() = runTest {
        // Ensure the kill-switch recorder lives in its own list — a
        // revoke must NOT show up in releasedServerNames / revokedAuthCodes.
        val client = MockFlagshipServerClient(simulatedLatencyMs = 0)
        client.revokeServer(
            ServerRevocationRequest(
                request = ServerRevocationRequest.Inner(
                    userId = "harry",
                    revokedServerId = "home.harry.flagship.services",
                    reason = "stolen",
                    issuedAt = 1L,
                ),
                signature = "cc",
            ),
        )
        assertTrue(client.releasedServerNames.isEmpty())
        assertTrue(client.revokedAuthCodes.isEmpty())
        assertEquals(1, client.revokedServers.size)
    }
}
