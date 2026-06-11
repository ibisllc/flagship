// P14 — CompanionDockViewModel state machine + wire-shape parity.
//
// Mirrors FlagshipMobileTests/CompanionDockViewModelTests.swift:
//   - default mock fixture is honest-empty (matches the daemon's
//     "no companions yet" default).
//   - mint() records the call, surfaces the ticket on success, surfaces
//     an error on failure.
//   - revoke() records the tokenPrefix, removes the row optimistically,
//     and clears the per-row revokePending flag when done.
//   - error mapping covers ScreensError.Http + generic Throwable.

package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.api.CompanionListResponse
import com.flagshipserver.app.api.CompanionMintTicketRequest
import com.flagshipserver.app.api.CompanionMintTicketResponse
import com.flagshipserver.app.api.CompanionRevokeRequest
import com.flagshipserver.app.api.CompanionSummary
import com.flagshipserver.app.api.MockScreensClient
import com.flagshipserver.app.api.ScreensClient
import com.flagshipserver.app.api.ScreensError
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class CompanionDockViewModelTest {

    @Test fun mockDefault_isHonestEmpty() = runTest {
        val client = MockScreensClient(simulatedLatencyMs = 0)
        val r = client.companionList()
        assertTrue(r.companions.isEmpty())
    }

    @Test fun load_defaultFixture_landsLoadedEmpty() = runTest {
        val client = MockScreensClient(simulatedLatencyMs = 0)
        val vm = CompanionDockViewModel(client, scope = backgroundScope)
        vm.load().join()
        val s = vm.state.first() as LoadingState.Loaded
        assertTrue(s.value.companions.isEmpty())
    }

    @Test fun load_pinnedFixture_isReturnedVerbatim() = runTest {
        val client = MockScreensClient(simulatedLatencyMs = 0).apply {
            companionListFixture = CompanionListResponse(
                companions = listOf(
                    CompanionSummary(
                        tokenPrefix = "a1b2c3d4",
                        label = "Living-room laptop",
                        redeemedAt = 1_700_000_000_000L,
                        lastSeenMs = 1_700_000_500_000L,
                        expiresAt = 1_700_014_400_000L,
                        userAgent = "Mozilla/5.0",
                    ),
                ),
            )
        }
        val vm = CompanionDockViewModel(client, scope = backgroundScope)
        vm.load().join()
        val s = vm.state.first() as LoadingState.Loaded
        assertEquals(1, s.value.companions.size)
        val c = s.value.companions.first()
        assertEquals("a1b2c3d4", c.tokenPrefix)
        assertEquals("Living-room laptop", c.label)
        assertEquals(1_700_000_500_000L, c.lastSeenMs)
        assertEquals("Mozilla/5.0", c.userAgent)
    }

    @Test fun mint_recordsRequestAndSurfacesTicket() = runTest {
        val client = MockScreensClient(simulatedLatencyMs = 0)
        val vm = CompanionDockViewModel(client, scope = backgroundScope)
        vm.mint("Kitchen tablet").join()
        assertEquals(1, client.companionMintCalls.size)
        assertEquals("Kitchen tablet", client.companionMintCalls.first().label)
        val ticket = vm.mintedTicket.first()
        assertNotNull(ticket)
        assertTrue(ticket!!.ticketId.isNotEmpty())
        assertTrue(ticket.ticketSecret.isNotEmpty())
        assertTrue(ticket.expiresAt > System.currentTimeMillis())
    }

    @Test fun mint_emptyLabel_isSentAsNull() = runTest {
        val client = MockScreensClient(simulatedLatencyMs = 0)
        val vm = CompanionDockViewModel(client, scope = backgroundScope)
        vm.mint("   ").join()
        assertEquals(1, client.companionMintCalls.size)
        assertNull(client.companionMintCalls.first().label)
    }

    @Test fun mint_nullLabel_isSentAsNull() = runTest {
        val client = MockScreensClient(simulatedLatencyMs = 0)
        val vm = CompanionDockViewModel(client, scope = backgroundScope)
        vm.mint(null).join()
        assertEquals(1, client.companionMintCalls.size)
        assertNull(client.companionMintCalls.first().label)
    }

    @Test fun mint_transportError_surfacesAsMintError() = runTest {
        val throwing = object : ScreensClient by MockScreensClient(simulatedLatencyMs = 0) {
            override suspend fun companionMintTicket(req: CompanionMintTicketRequest): CompanionMintTicketResponse =
                throw ScreensError.Http(503, "no can do")
        }
        val vm = CompanionDockViewModel(throwing, scope = backgroundScope)
        vm.mint("anything").join()
        val err = vm.mintError.first()
        assertNotNull(err)
        // UX-B: the raw status / body is humanized away.
        assertFalse(err!!, err.contains("503") || err.contains("no can do"))
        assertTrue(err, err.contains("try again", ignoreCase = true))
        assertNull(vm.mintedTicket.first())
    }

    @Test fun revoke_recordsCallAndDropsRow() = runTest {
        val client = MockScreensClient(simulatedLatencyMs = 0).apply {
            companionListFixture = CompanionListResponse(
                companions = listOf(
                    CompanionSummary(
                        tokenPrefix = "deadbeef",
                        label = "Laptop",
                        redeemedAt = 0L, lastSeenMs = 0L, expiresAt = 1L, userAgent = null,
                    ),
                    CompanionSummary(
                        tokenPrefix = "feedface",
                        label = null,
                        redeemedAt = 0L, lastSeenMs = 0L, expiresAt = 1L, userAgent = null,
                    ),
                ),
            )
        }
        val vm = CompanionDockViewModel(client, scope = backgroundScope)
        vm.load().join()
        vm.revoke("deadbeef").join()
        assertEquals(listOf("deadbeef"), client.companionRevokeCalls)
        val s = vm.state.first() as LoadingState.Loaded
        assertEquals(1, s.value.companions.size)
        assertEquals("feedface", s.value.companions.first().tokenPrefix)
        assertTrue(vm.revokePending.first().isEmpty())
    }

    @Test fun load_transportError_landsInFailed() = runTest {
        val throwing = object : ScreensClient by MockScreensClient(simulatedLatencyMs = 0) {
            override suspend fun companionList(): CompanionListResponse =
                throw ScreensError.Http(503, "list down")
        }
        val vm = CompanionDockViewModel(throwing, scope = backgroundScope)
        vm.load().join()
        val s = vm.state.first()
        assertTrue("expected Failed, was $s", s is LoadingState.Failed)
        val msg = (s as LoadingState.Failed).message
        assertFalse(msg, msg.contains("503") || msg.contains("list down"))
        assertTrue(msg, msg.contains("try again", ignoreCase = true))
    }

    @Test fun revoke_transportError_landsInFailed() = runTest {
        val client = MockScreensClient(simulatedLatencyMs = 0).apply {
            companionListFixture = CompanionListResponse(
                companions = listOf(
                    CompanionSummary(
                        tokenPrefix = "deadbeef", label = null,
                        redeemedAt = 0L, lastSeenMs = 0L, expiresAt = 1L, userAgent = null,
                    ),
                ),
            )
        }
        val vm = CompanionDockViewModel(client, scope = backgroundScope)
        vm.load().join()
        client.shouldFail = true
        vm.revoke("deadbeef").join()
        val s = vm.state.first()
        assertTrue("expected Failed, was $s", s is LoadingState.Failed)
        assertFalse(vm.revokePending.first().contains("deadbeef"))
    }

    @Test fun dismissTicket_clearsBothTicketAndError() = runTest {
        val client = MockScreensClient(simulatedLatencyMs = 0)
        val vm = CompanionDockViewModel(client, scope = backgroundScope)
        vm.mint("foo").join()
        assertNotNull(vm.mintedTicket.first())
        vm.dismissTicket()
        assertNull(vm.mintedTicket.first())
        assertNull(vm.mintError.first())
    }

    @Test fun mockRevoke_recordsRequest() = runTest {
        val client = MockScreensClient(simulatedLatencyMs = 0)
        val r = client.companionRevoke(CompanionRevokeRequest(tokenPrefix = "xyz"))
        assertTrue(r.ok)
        assertEquals(listOf("xyz"), client.companionRevokeCalls)
    }
}
