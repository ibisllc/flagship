// P14 — CompanionDockViewModel state machine + wire-shape parity.
//
// Mirrors FlagshipMobileTests/CompanionDockViewModelTests.swift:
//   - default mock fixture is honest-empty (matches the daemon's
//     "no companions yet" default).
//   - scan/paste approval is biometric-gated and uses the phone endpoint.
//   - revoke() records the tokenPrefix, removes the row optimistically,
//     and clears the per-row revokePending flag when done.
//   - error mapping covers ScreensError.Http + generic Throwable.

package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.api.CompanionListResponse
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
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class CompanionDockViewModelTest {

    @Test fun stageAndApprove_isBiometricGatedAndCallsServer() = runTest {
        val client = MockScreensClient(simulatedLatencyMs = 0)
        var gates = 0
        val vm = CompanionDockViewModel(client, scope = backgroundScope, authenticate = { gates += 1 })
        val request = "ab".repeat(16)
        val code = "cd".repeat(32)
        assertTrue(vm.stageApproval("flagship://dock?server=demo.alice.flagship.services&request=$request&code=$code"))
        vm.approve().join()
        assertEquals(1, gates)
        assertEquals(request, client.companionApproveCalls.single().requestId)
        assertTrue(vm.approvalComplete.first())
        assertNull(vm.stagedApproval.first())
    }

    @Test fun stageApproval_requiresSelectedServer() = runTest {
        val vm = CompanionDockViewModel(
            MockScreensClient(simulatedLatencyMs = 0),
            scope = backgroundScope,
            expectedServerDomain = "other.alice.flagship.services",
            authenticate = {},
        )
        val request = "ab".repeat(16)
        val code = "cd".repeat(32)
        assertFalse(vm.stageApproval("flagship://dock?server=demo.alice.flagship.services&request=$request&code=$code"))
        assertNull(vm.stagedApproval.first())
        assertTrue(vm.approvalError.first()!!.contains("Switch to"))
    }

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
        assertEquals(1_700_000_500_000L, c.lastSeenMs)
        assertEquals("Mozilla/5.0", c.userAgent)
    }

    @Test fun revoke_recordsCallAndDropsRow() = runTest {
        val client = MockScreensClient(simulatedLatencyMs = 0).apply {
            companionListFixture = CompanionListResponse(
                companions = listOf(
                    CompanionSummary(
                        tokenPrefix = "deadbeef",
                        redeemedAt = 0L, lastSeenMs = 0L, expiresAt = 1L, userAgent = null,
                    ),
                    CompanionSummary(
                        tokenPrefix = "feedface",
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
                        tokenPrefix = "deadbeef",
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

    @Test fun mockRevoke_recordsRequest() = runTest {
        val client = MockScreensClient(simulatedLatencyMs = 0)
        val r = client.companionRevoke(CompanionRevokeRequest(tokenPrefix = "xyz"))
        assertTrue(r.ok)
        assertEquals(listOf("xyz"), client.companionRevokeCalls)
    }
}
