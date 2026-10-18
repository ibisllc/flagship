// Device report 2026-10-18 (A-3): "Cancel order" said "Couldn't cancel - the
// name is still reserved. Check your connection and try again." on a healthy
// connection. The reason is now shown in plain words, a ghost row with no
// account part is removed without a call, and the same cancel can run again.

package com.flagshipserver.app.core

import com.flagshipserver.app.api.AuthCodeRevokeRequest
import com.flagshipserver.app.api.FlagshipServerClient
import com.flagshipserver.app.api.MockFlagshipServerClient
import com.flagshipserver.app.api.ReleaseServerNameRequest
import com.google.crypto.tink.subtle.Ed25519Sign
import com.google.crypto.tink.subtle.Ed25519Verify
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException

class CancelPendingOrderTest {
    private val fqdn = "home2.harry.flagship.services"
    private val now = 1_700_000_000_000L
    private val adminPair = Ed25519Sign.KeyPair.newKeyPair()
    private val irkPair = Ed25519Sign.KeyPair.newKeyPair()

    private fun pod(f: String = fqdn, serial: String? = "SER-1") = PodInfo(
        podId = PodInfo.podId(f), name = "Home2", fqdn = f,
        status = PodInfo.Status.PENDING, pendingAuthCodeSerial = serial,
    )

    private suspend fun run(pod: PodInfo, server: FlagshipServerClient) = CancelPendingOrder.run(
        pod = pod, username = "harry", server = server,
        releaseKey = { Ed25519Sign(adminPair.privateKey) },
        revokeKey = { Ed25519Sign(irkPair.privateKey) },
        now = { now },
    )

    @Test fun releasesTheNameWithTheAdminKeyThenRevokesTheCodeWithTheIrk() = runTest {
        val mock = MockFlagshipServerClient(simulatedLatencyMs = 0)
        assertEquals(CancelPendingOrder.Outcome.Cancelled(releasedName = true), run(pod(), mock))
        val release = mock.releasedServerNames.single()
        assertEquals(ReleaseServerNameRequest.Inner("harry", fqdn, now), release.request)
        Ed25519Verify(adminPair.publicKey).verify(
            HexUtil.decode(release.signature)!!,
            ReleaseServerName.canonicalBytes("harry", fqdn, now),
        )
        assertEquals(listOf("SER-1"), mock.revokedAuthCodes.toList())
    }

    @Test fun aGhostRowWithNoAccountPartIsRemovedWithoutACall() = runTest {
        val calls = mutableListOf<String>()
        val mock = MockFlagshipServerClient(simulatedLatencyMs = 0)
        val server = object : FlagshipServerClient by mock {
            override suspend fun releaseServerName(req: ReleaseServerNameRequest) { calls += "release"; mock.releaseServerName(req) }
        }
        assertEquals(
            CancelPendingOrder.Outcome.Cancelled(releasedName = false),
            run(pod("server.flagship.services"), server),
        )
        assertTrue(calls.isEmpty())
    }

    @Test fun aFailureIsSaidInPlainWordsAndTheSameCancelCanRunAgain() = runTest {
        var failure: Throwable? = HttpException(503, "error code: 1102")
        val mock = MockFlagshipServerClient(simulatedLatencyMs = 0)
        val server = object : FlagshipServerClient by mock {
            override suspend fun releaseServerName(req: ReleaseServerNameRequest) {
                failure?.let { throw it }
                mock.releaseServerName(req)
            }
        }
        val first = run(pod(), server) as CancelPendingOrder.Outcome.Failed
        assertTrue(first.message, first.message.contains("temporary problem"))
        assertTrue(first.message.contains("The name stays reserved"))
        assertFalse(first.message.contains("1102"))

        failure = IOException("connection closed")
        val second = run(pod(), server) as CancelPendingOrder.Outcome.Failed
        assertTrue(second.message, second.message.contains("The connection dropped"))

        failure = null
        assertEquals(CancelPendingOrder.Outcome.Cancelled(releasedName = true), run(pod(), server))
        assertEquals(1, mock.releasedServerNames.size)
    }

    @Test fun aRefusalFromComIsShownAsItsSentence() = runTest {
        val mock = MockFlagshipServerClient(simulatedLatencyMs = 0)
        val server = object : FlagshipServerClient by mock {
            override suspend fun releaseServerName(req: ReleaseServerNameRequest) {
                throw HttpException(403, "{\"error\":\"Only an admin device of this account can release a name.\"}")
            }
        }
        val out = run(pod(), server) as CancelPendingOrder.Outcome.Failed
        assertTrue(out.message, out.message.contains("Only an admin device of this account can release a name."))
    }
}
