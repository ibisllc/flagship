// P13 — RevokeServerViewModel happy-path + error-mapping. The view
// model signs canonical `flagship/revoke/v1` bytes and POSTs the
// envelope; assertions pin both the on-the-wire shape AND the
// error-mapping the danger-zone sheet relies on.

package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.api.AccountSelfDeleteBundleRequest
import com.flagshipserver.app.api.AppLinksResponse
import com.flagshipserver.app.api.AppRenameRequest
import com.flagshipserver.app.api.AppRenameResponse
import com.flagshipserver.app.api.AuditEventListResponse
import com.flagshipserver.app.api.AuthCodeIssueRequest
import com.flagshipserver.app.api.AuthCodeRevokeRequest
import com.flagshipserver.app.api.DeviceAdmitRequest
import com.flagshipserver.app.api.DeviceAdmitResponse
import com.flagshipserver.app.api.FlagshipServerClient
import com.flagshipserver.app.api.GatedRecoveryEnvelope
import com.flagshipserver.app.api.MockFlagshipServerClient
import com.flagshipserver.app.api.ProvisionStatusRecord
import com.flagshipserver.app.api.PushTokenRegisterRequest
import com.flagshipserver.app.api.PushTokenRegisterResponse
import com.flagshipserver.app.api.PushTokenRevokeRequest
import com.flagshipserver.app.api.AccountResolution
import com.flagshipserver.app.api.PendingRePairSnapshot
import com.flagshipserver.app.api.RckRegisterRequest
import com.flagshipserver.app.api.RePairCompleteResponse
import com.flagshipserver.app.api.RePairInitiateRequest
import com.flagshipserver.app.api.RePairInitiateResponse
import com.flagshipserver.app.api.RecoveryEnvelope
import com.flagshipserver.app.api.RecoveryEnvelopeRequest
import com.flagshipserver.app.api.RecoveryEnvelopeResponse
import com.flagshipserver.app.api.ReleaseServerNameRequest
import com.flagshipserver.app.api.ServerRevocationRequest
import com.flagshipserver.app.api.SetCustomDomainRequest
import com.flagshipserver.app.api.WatchDelegateMintRequest
import com.flagshipserver.app.api.WatchDelegateMintResponse
import com.flagshipserver.app.api.WatchDelegateRevokeRequest
import com.flagshipserver.app.api.WatchDelegatesListResponse
import com.flagshipserver.app.api.TotpDisableRequest
import com.flagshipserver.app.api.TotpDisableResponse
import com.flagshipserver.app.api.TotpEnrollBeginRequest
import com.flagshipserver.app.api.TotpEnrollBeginResponse
import com.flagshipserver.app.api.TotpEnrollConfirmRequest
import com.flagshipserver.app.api.TotpEnrollConfirmResponse
import com.flagshipserver.app.api.TrustedDevicesListResponse
import com.flagshipserver.app.api.UsernameAvailabilityResponse
import com.flagshipserver.app.api.UsernameClaimRequest
import com.flagshipserver.app.api.UsernameLookupResponse
import com.flagshipserver.app.api.WipeRestartRequest
import com.flagshipserver.app.api.WipeRestartResponse
import com.flagshipserver.app.core.HexUtil
import com.flagshipserver.app.core.HttpException
import com.flagshipserver.app.core.ServerRevocationClaim
import com.google.crypto.tink.subtle.Ed25519Sign
import com.google.crypto.tink.subtle.Ed25519Verify
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

class RevokeServerViewModelTest {

    @Test fun happyPath_signsAndPosts_recordingExactWireValues() = runTest {
        val mock = MockFlagshipServerClient(simulatedLatencyMs = 0)
        val keyPair = Ed25519Sign.KeyPair.newKeyPair()
        val signer = Ed25519Sign(keyPair.privateKey)

        val vm = RevokeServerViewModel(
            server = mock,
            serverDomain = "home.harry.flagship.services",
            username = { "harry" },
            signer = { signer },
            now = { 1_700_000_000_000L },
        )
        vm.run(RevokeServerReason.STOLEN)
        val phase = vm.phase.value
        assertTrue("expected Completed, got $phase", phase is RevokeServerPhase.Completed)

        assertEquals(1, mock.revokedServers.size)
        val recorded = mock.revokedServers.first()
        assertEquals("harry", recorded.request.userId)
        assertEquals("home.harry.flagship.services", recorded.request.revokedServerId)
        assertEquals("stolen", recorded.request.reason)
        assertEquals(1_700_000_000_000L, recorded.request.issuedAt)

        // The recorded signature must verify against the canonical
        // bytes the view-model computed. (Pins the wire-equivalence
        // between Mock and a notional Worker verifier.)
        val canonical = ServerRevocationClaim.canonicalBytes(
            userId = recorded.request.userId,
            revokedServerId = recorded.request.revokedServerId,
            reason = recorded.request.reason,
            issuedAt = recorded.request.issuedAt,
        )
        val sigBytes = HexUtil.decode(recorded.signature)
        assertNotNull(sigBytes)
        // Ed25519Verify.verify throws GeneralSecurityException on
        // mismatch; the test fails the same way either way. The
        // call's success is the assertion.
        Ed25519Verify(keyPair.publicKey).verify(sigBytes!!, canonical)
    }

    @Test fun eachReason_landsExactValueOnTheWire() = runTest {
        val keyPair = Ed25519Sign.KeyPair.newKeyPair()
        val signer = Ed25519Sign(keyPair.privateKey)
        for (r in RevokeServerReason.entries) {
            val mock = MockFlagshipServerClient(simulatedLatencyMs = 0)
            val vm = RevokeServerViewModel(
                server = mock,
                serverDomain = "home.alice.flagship.services",
                username = { "alice" },
                signer = { signer },
                now = { 7L },
            )
            vm.run(r)
            assertEquals(r.wire, mock.revokedServers.first().request.reason)
        }
    }

    @Test fun noUsername_failsImmediately_andDoesNotPost() = runTest {
        val mock = MockFlagshipServerClient(simulatedLatencyMs = 0)
        val signer = Ed25519Sign(Ed25519Sign.KeyPair.newKeyPair().privateKey)
        val vm = RevokeServerViewModel(
            server = mock,
            serverDomain = "home.harry.flagship.services",
            username = { null },
            signer = { signer },
        )
        vm.run(RevokeServerReason.LOST)
        assertTrue(vm.phase.value is RevokeServerPhase.Failed)
        assertTrue(mock.revokedServers.isEmpty())
    }

    @Test fun http403_mapsToFriendlyRejectedMessage() = runTest {
        val server = ThrowingServer(HttpException(403, "stale"))
        val signer = Ed25519Sign(Ed25519Sign.KeyPair.newKeyPair().privateKey)
        val vm = RevokeServerViewModel(
            server = server,
            serverDomain = "home.harry.flagship.services",
            username = { "harry" },
            signer = { signer },
        )
        vm.run(RevokeServerReason.STOLEN)
        val p = vm.phase.value as RevokeServerPhase.Failed
        assertTrue("got: ${p.message}", p.message.lowercase().contains("rejected"))
    }

    @Test fun http404_mapsToAlreadyGoneMessage() = runTest {
        val server = ThrowingServer(HttpException(404, "gone"))
        val signer = Ed25519Sign(Ed25519Sign.KeyPair.newKeyPair().privateKey)
        val vm = RevokeServerViewModel(
            server = server,
            serverDomain = "home.harry.flagship.services",
            username = { "harry" },
            signer = { signer },
        )
        vm.run(RevokeServerReason.DECOMMISSIONED)
        val p = vm.phase.value as RevokeServerPhase.Failed
        assertTrue("got: ${p.message}", p.message.lowercase().contains("already gone"))
    }

    @Test fun reasonFromWire_roundTripsForKnownValuesAndNullsOthers() {
        assertEquals(RevokeServerReason.LOST, RevokeServerReason.fromWire("lost"))
        assertEquals(RevokeServerReason.STOLEN, RevokeServerReason.fromWire("stolen"))
        assertEquals(RevokeServerReason.DECOMMISSIONED, RevokeServerReason.fromWire("decommissioned"))
        assertEquals(null, RevokeServerReason.fromWire("borrowed"))
    }

    // ---- helpers ----

    /// A tiny FlagshipServerClient that throws a fixed Throwable from
    /// EVERY method. Used to exercise the view-model's error mapping
    /// without an HTTP transport. Mirrors the iOS `ThrowingServer` shape.
    private class ThrowingServer(private val error: Throwable) : FlagshipServerClient {
        override suspend fun claimUsername(req: UsernameClaimRequest) { throw error }
        override suspend fun selfDeleteAccount(req: AccountSelfDeleteBundleRequest) { throw error }
        override suspend fun issueAuthCode(req: AuthCodeIssueRequest) { throw error }
        override suspend fun registerRck(req: RckRegisterRequest) { throw error }
        override suspend fun revokeAuthCode(req: AuthCodeRevokeRequest) { throw error }
        override suspend fun releaseServerName(req: ReleaseServerNameRequest) { throw error }
        override suspend fun revokeServer(req: ServerRevocationRequest) { throw error }
        override suspend fun usernameAvailable(username: String): UsernameAvailabilityResponse = throw error
        override suspend fun fetchProvisionStatus(serial: String): ProvisionStatusRecord? = throw error
        override suspend fun registerRecoveryEnvelope(req: RecoveryEnvelopeRequest): RecoveryEnvelopeResponse = throw error
        override suspend fun fetchRecoveryEnvelope(credentialId: String): RecoveryEnvelope = throw error
        override suspend fun fetchWrappedUmkWithToken(username: String, fetchTokenHex: String, issuedAt: Long): GatedRecoveryEnvelope = throw error
        override suspend fun registerPushToken(req: PushTokenRegisterRequest): PushTokenRegisterResponse = throw error
        override suspend fun revokePushToken(req: PushTokenRevokeRequest) { throw error }
        override suspend fun listDevices(username: String): TrustedDevicesListResponse = throw error
        override suspend fun listAuditEvents(username: String, sinceSeq: Int, limit: Int): AuditEventListResponse = throw error
        override suspend fun hasCloudRecovery(username: String): Boolean = throw error
        override suspend fun initiateRePair(username: String, body: RePairInitiateRequest, ifMatch: String?): RePairInitiateResponse = throw error
        override suspend fun completeRePair(username: String): RePairCompleteResponse = throw error
        override suspend fun fetchPendingRePair(username: String): PendingRePairSnapshot = throw error
        override suspend fun wipeRestart(username: String, body: WipeRestartRequest, ifMatch: String?): WipeRestartResponse = throw error
        override suspend fun renameApp(username: String, serviceId: String, body: AppRenameRequest): AppRenameResponse = throw error
        override suspend fun getAppLinks(username: String, serviceId: String): AppLinksResponse = throw error
        override suspend fun setCustomDomain(username: String, serviceId: String, body: SetCustomDomainRequest): AppLinksResponse = throw error
        override suspend fun getUsernameRecord(username: String): UsernameLookupResponse = throw error
        override suspend fun totpEnrollBegin(username: String, body: TotpEnrollBeginRequest): TotpEnrollBeginResponse = throw error
        override suspend fun totpEnrollConfirm(username: String, body: TotpEnrollConfirmRequest): TotpEnrollConfirmResponse = throw error
        override suspend fun totpDisable(username: String, body: TotpDisableRequest): TotpDisableResponse = throw error
        override suspend fun admitDevice(account: String, req: DeviceAdmitRequest): DeviceAdmitResponse = throw error
        override suspend fun mintWatchDelegate(username: String, body: WatchDelegateMintRequest): WatchDelegateMintResponse = throw error
        override suspend fun listWatchDelegates(username: String): WatchDelegatesListResponse = throw error
        override suspend fun revokeWatchDelegate(username: String, body: WatchDelegateRevokeRequest) { throw error }
        override suspend fun resolveAccount(username: String): AccountResolution = throw error
    }
}
