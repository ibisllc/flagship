// P14 Phase 2 — CompanionRequestsViewModel state machine + dispatch.
//
// Mirrors the iOS CompanionRequestsViewModelTests 1:1:
//   - load happy/failed
//   - approve release-server signs + dispatches + resolves
//   - approve revoke-server signs + dispatches + resolves
//   - approve destination-POST failure does NOT resolve
//   - deny posts resolve directly without signing
//   - unsupported-kind sets row error without auto-action

package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.api.CompanionPendingWrite
import com.flagshipserver.app.api.CompanionPendingWritesResponse
import com.flagshipserver.app.api.MockFlagshipServerClient
import com.flagshipserver.app.api.MockScreensClient
import com.google.crypto.tink.subtle.Ed25519Sign
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class CompanionRequestsViewModelTest {

    private fun makeSigner(): suspend (String) -> Ed25519Sign {
        val kp = Ed25519Sign.KeyPair.newKeyPair()
        val signer = Ed25519Sign(kp.privateKey)
        return { signer }
    }

    private fun releaseRow(
        requestId: String = "req-rel-1",
        serverDomain: String = "home.alice.flagship.services",
        queuedAt: Long = 1_700_000_000_000L,
        label: String? = "Library iMac",
    ): CompanionPendingWrite = CompanionPendingWrite(
        requestId = requestId,
        companionTokenPrefix = "deadbeef0000",
        companionLabel = label,
        kind = "release-server",
        intent = JsonObject(
            mapOf(
                "username" to JsonPrimitive("alice"),
                "serverDomain" to JsonPrimitive(serverDomain),
                "issuedAt" to JsonPrimitive(1_700_000_000_000L),
            ),
        ),
        queuedAt = queuedAt,
        expiresAt = queuedAt + 600_000,
    )

    private fun revokeRow(
        requestId: String = "req-rev-1",
        serverId: String = "home.alice.flagship.services",
        reason: String = "lost",
        queuedAt: Long = 1_700_000_001_000L,
    ): CompanionPendingWrite = CompanionPendingWrite(
        requestId = requestId,
        companionTokenPrefix = "f00dcafe1111",
        companionLabel = null,
        kind = "revoke-server",
        intent = JsonObject(
            mapOf(
                "userId" to JsonPrimitive("alice"),
                "revokedServerId" to JsonPrimitive(serverId),
                "reason" to JsonPrimitive(reason),
                "issuedAt" to JsonPrimitive(1_700_000_001_000L),
            ),
        ),
        queuedAt = queuedAt,
        expiresAt = queuedAt + 600_000,
    )

    @Test fun load_happyPath_sortsOldestFirst() = runTest {
        val screens = MockScreensClient(simulatedLatencyMs = 0)
        screens.companionPendingWritesFixture = CompanionPendingWritesResponse(
            pending = listOf(
                releaseRow(requestId = "later", queuedAt = 2_000),
                releaseRow(requestId = "earlier", queuedAt = 1_000),
            ),
        )
        val server = MockFlagshipServerClient(simulatedLatencyMs = 0)
        val vm = CompanionRequestsViewModel(
            client = screens,
            server = server,
            username = { "alice" },
            signer = makeSigner(),
        )
        vm.load().join()
        val s = vm.state.value as LoadingState.Loaded
        assertEquals(listOf("earlier", "later"), s.value.map { it.requestId })
    }

    @Test fun load_failure_surfacesFailed() = runTest {
        val screens = MockScreensClient(simulatedLatencyMs = 0, shouldFail = true)
        val server = MockFlagshipServerClient(simulatedLatencyMs = 0)
        val vm = CompanionRequestsViewModel(
            client = screens,
            server = server,
            username = { "alice" },
            signer = makeSigner(),
        )
        vm.load().join()
        assertTrue(vm.state.value is LoadingState.Failed)
    }

    @Test fun approve_releaseServer_signsAndResolves() = runTest {
        val screens = MockScreensClient(simulatedLatencyMs = 0)
        val server = MockFlagshipServerClient(simulatedLatencyMs = 0)
        val row = releaseRow()
        screens.companionPendingWritesFixture = CompanionPendingWritesResponse(pending = listOf(row))
        val vm = CompanionRequestsViewModel(
            client = screens,
            server = server,
            username = { "alice" },
            signer = makeSigner(),
        )
        vm.load().join()
        vm.approve(row).join()
        assertEquals(1, server.releasedServerNames.size)
        assertEquals("alice", server.releasedServerNames.first().request.username)
        assertEquals(
            "home.alice.flagship.services",
            server.releasedServerNames.first().request.serverDomain,
        )
        assertEquals(1, screens.companionResolveCalls.size)
        assertEquals("approved", screens.companionResolveCalls.first().outcome)
        assertNull(vm.rowError.value[row.requestId])
        val s = vm.state.value as LoadingState.Loaded
        assertTrue(s.value.isEmpty())
    }

    @Test fun approve_revokeServer_signsAndResolves() = runTest {
        val screens = MockScreensClient(simulatedLatencyMs = 0)
        val server = MockFlagshipServerClient(simulatedLatencyMs = 0)
        val row = revokeRow()
        screens.companionPendingWritesFixture = CompanionPendingWritesResponse(pending = listOf(row))
        val vm = CompanionRequestsViewModel(
            client = screens,
            server = server,
            username = { "alice" },
            signer = makeSigner(),
        )
        vm.load().join()
        vm.approve(row).join()
        assertEquals(1, server.revokedServers.size)
        assertEquals("alice", server.revokedServers.first().request.userId)
        assertEquals("lost", server.revokedServers.first().request.reason)
        assertEquals(1, screens.companionResolveCalls.size)
        assertEquals("approved", screens.companionResolveCalls.first().outcome)
    }

    @Test fun approve_destinationFailure_doesNotResolve() = runTest {
        val screens = MockScreensClient(simulatedLatencyMs = 0)
        // shouldFail makes every server method throw HttpException(503) via tick().
        val server = MockFlagshipServerClient(simulatedLatencyMs = 0, shouldFail = true)
        val row = releaseRow()
        screens.companionPendingWritesFixture = CompanionPendingWritesResponse(pending = listOf(row))
        val vm = CompanionRequestsViewModel(
            client = screens,
            server = server,
            username = { "alice" },
            signer = makeSigner(),
        )
        vm.load().join()
        vm.approve(row).join()
        assertEquals(0, screens.companionResolveCalls.size)
        assertNotNull(vm.rowError.value[row.requestId])
        val s = vm.state.value as LoadingState.Loaded
        assertEquals(1, s.value.size)
        assertEquals(row.requestId, s.value.first().requestId)
    }

    @Test fun deny_postsResolveDirectly_withoutSigning() = runTest {
        val screens = MockScreensClient(simulatedLatencyMs = 0)
        val server = MockFlagshipServerClient(simulatedLatencyMs = 0)
        val row = releaseRow()
        screens.companionPendingWritesFixture = CompanionPendingWritesResponse(pending = listOf(row))
        val vm = CompanionRequestsViewModel(
            client = screens,
            server = server,
            username = { "alice" },
            signer = makeSigner(),
        )
        vm.load().join()
        vm.deny(row).join()
        assertEquals(0, server.releasedServerNames.size)
        assertEquals(0, server.revokedServers.size)
        assertEquals(1, screens.companionResolveCalls.size)
        assertEquals("denied", screens.companionResolveCalls.first().outcome)
    }

    @Test fun approve_unsupportedKind_doesNotSignOrResolve() = runTest {
        val screens = MockScreensClient(simulatedLatencyMs = 0)
        val server = MockFlagshipServerClient(simulatedLatencyMs = 0)
        val row = CompanionPendingWrite(
            requestId = "req-unsupported",
            companionTokenPrefix = "0000feed",
            companionLabel = "Library iMac",
            kind = "mystery-kind",
            intent = JsonObject(mapOf("whatever" to JsonPrimitive("blob"))),
            queuedAt = 1_700_000_000_000L,
            expiresAt = 1_700_000_600_000L,
        )
        screens.companionPendingWritesFixture = CompanionPendingWritesResponse(pending = listOf(row))
        val vm = CompanionRequestsViewModel(
            client = screens,
            server = server,
            username = { "alice" },
            signer = makeSigner(),
        )
        vm.load().join()
        vm.approve(row).join()
        assertEquals(0, server.releasedServerNames.size)
        assertEquals(0, server.revokedServers.size)
        assertEquals(0, screens.companionResolveCalls.size)
        assertNotNull(vm.rowError.value[row.requestId])
    }
}
