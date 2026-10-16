package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.api.FlagshipServerClient
import com.flagshipserver.app.api.MockFlagshipServerClient
import com.flagshipserver.app.api.ReleaseServerNameRequest
import com.flagshipserver.app.api.ServerRevocationRequest
import com.flagshipserver.app.api.UnrevokeServerRequest
import com.flagshipserver.app.api.UnrevokeServerResponse
import com.flagshipserver.app.core.HexUtil
import com.flagshipserver.app.core.HttpException
import com.flagshipserver.app.core.ServerUnrevocation
import com.google.crypto.tink.subtle.Ed25519Sign
import com.google.crypto.tink.subtle.Ed25519Verify
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class UnrevokeServerViewModelTest {

    private val domain = "home.harry.flagship.services"
    private val keyPair = Ed25519Sign.KeyPair.newKeyPair()

    private fun vm(server: FlagshipServerClient, signer: suspend (String) -> Ed25519Sign = { Ed25519Sign(keyPair.privateKey) }) =
        UnrevokeServerViewModel(
            server = server,
            serverDomain = domain,
            username = { "harry" },
            signer = signer,
            now = { 1_700_000_000_000L },
        )

    private suspend fun MockFlagshipServerClient.revoke(reason: String = "lost") = revokeServer(
        ServerRevocationRequest(
            ServerRevocationRequest.Inner(userId = "harry", revokedServerId = domain, reason = reason, issuedAt = 1L),
            signature = "00",
        ),
    )

    @Test fun happyPath_signsCanonicalBytesAndPosts() = runTest {
        val mock = MockFlagshipServerClient(simulatedLatencyMs = 0)
        mock.revoke()
        val vm = vm(mock)
        vm.run()

        assertEquals(UnrevokeServerPhase.Completed, vm.phase.value)
        val posted = mock.unrevokedServers.single()
        assertEquals(UnrevokeServerRequest.Inner("harry", domain, 1_700_000_000_000L), posted.request)
        assertEquals(128, posted.signature.length)
        Ed25519Verify(keyPair.publicKey).verify(
            HexUtil.decode(posted.signature)!!,
            ServerUnrevocation.canonicalBytes("harry", domain, 1_700_000_000_000L),
        )
    }

    @Test fun liveServer_isANoopSuccess() = runTest {
        val mock = MockFlagshipServerClient(simulatedLatencyMs = 0)
        val response = mock.unrevokeServer(
            UnrevokeServerRequest(UnrevokeServerRequest.Inner("harry", domain, 1L), "00"),
        )
        assertTrue(response.alreadyActive)
        val vm = vm(mock)
        vm.run()
        assertEquals(UnrevokeServerPhase.Completed, vm.phase.value)
    }

    @Test fun deletedServer_mapsTo409Copy() = runTest {
        val mock = MockFlagshipServerClient(simulatedLatencyMs = 0)
        mock.revoke()
        mock.releaseServerName(
            ReleaseServerNameRequest(ReleaseServerNameRequest.Inner("harry", domain, 2L), "00"),
        )
        val vm = vm(mock)
        vm.run()
        assertEquals(
            UnrevokeServerPhase.Failed("This server was deleted or transferred, so it can't be restored."),
            vm.phase.value,
        )
    }

    @Test fun forbidden_andNotFound_mapToFriendlyCopy() = runTest {
        for ((status, expected) in listOf(
            403 to "The server rejected the request. Sign in again and retry.",
            404 to "That server is no longer on your account.",
        )) {
            val server = object : FlagshipServerClient by MockFlagshipServerClient(simulatedLatencyMs = 0) {
                override suspend fun unrevokeServer(req: UnrevokeServerRequest): UnrevokeServerResponse =
                    throw HttpException(status, "{}")
            }
            val vm = vm(server)
            vm.run()
            assertEquals(UnrevokeServerPhase.Failed(expected), vm.phase.value)
        }
    }

    @Test fun signerFailure_neverPosts() = runTest {
        val mock = MockFlagshipServerClient(simulatedLatencyMs = 0)
        mock.revoke()
        val vm = vm(mock, signer = { throw IllegalStateException("cancelled") })
        vm.run()
        assertTrue(vm.phase.value is UnrevokeServerPhase.Failed)
        assertTrue(mock.unrevokedServers.isEmpty())
    }

    @Test fun noUser_failsWithoutSigning() = runTest {
        val mock = MockFlagshipServerClient(simulatedLatencyMs = 0)
        var signed = false
        val vm = UnrevokeServerViewModel(
            server = mock, serverDomain = domain, username = { null },
            signer = { signed = true; Ed25519Sign(keyPair.privateKey) },
        )
        vm.run()
        assertEquals(UnrevokeServerPhase.Failed("No active account on this device."), vm.phase.value)
        assertTrue(!signed)
    }
}
