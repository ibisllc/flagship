// SEC-REPAIR-001 on Android: enrolment sends the passkey's attestation beside the signed record;
// recovery derives the passphrase first, then asks `.com` for a challenge, runs ONE passkey sheet
// that both evaluates the PRF and signs it, then fetches with that assertion. A record from before
// the check still recovers and is reported as such; the refusals read as sentences.

package com.flagshipserver.app.keystore

import android.content.Context
import com.flagshipserver.app.api.FlagshipServerClient
import com.flagshipserver.app.api.GatedRecoveryEnvelope
import com.flagshipserver.app.api.MockFlagshipServerClient
import com.flagshipserver.app.api.RecoveryChallenge
import com.flagshipserver.app.api.RecoveryEnvelopeRequest
import com.flagshipserver.app.core.HexUtil
import com.flagshipserver.app.core.HttpException
import com.flagshipserver.app.core.PasskeyCheckError
import com.flagshipserver.app.core.RecoveryPasskeyText
import com.flagshipserver.app.core.RecoveryUpdatePromptStore
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RuntimeEnvironment
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class RecoveryPasskeyFlowTest {
    private val username = "demo1234"
    private val passphrase = "a whole sentence I will remember"
    private val umkSeed = ByteArray(32) { (it + 3).toByte() }

    /** Every call the recovery makes, in order. */
    private class Recording(private val d: MockFlagshipServerClient) : FlagshipServerClient by d {
        val calls = mutableListOf<String>()
        var uploaded: RecoveryEnvelopeRequest? = null
        override suspend fun registerRecoveryEnvelope(req: RecoveryEnvelopeRequest) = d.registerRecoveryEnvelope(req).also { uploaded = req }
        override suspend fun recoveryRecordState(username: String) = d.recoveryRecordState(username).also { calls += "meta" }
        override suspend fun recoveryChallenge(username: String): RecoveryChallenge = d.recoveryChallenge(username).also { calls += "challenge" }
        override suspend fun fetchWrappedUmkWithToken(username: String, fetchTokenHex: String, issuedAt: Long): GatedRecoveryEnvelope {
            calls += "fetch"
            return d.fetchWrappedUmkWithToken(username, fetchTokenHex, issuedAt)
        }
        override suspend fun fetchWrappedUmkWithPasskey(username: String, fetchTokenHex: String, issuedAt: Long, passkey: JsonObject): GatedRecoveryEnvelope {
            calls += "fetch+passkey"
            return d.fetchWrappedUmkWithPasskey(username, fetchTokenHex, issuedAt, passkey)
        }
    }

    /** The real manager over the gym's fake passkey app, noting each sheet. */
    private class Sheets(private val inner: PasskeyCeremonyAdapter, private val calls: MutableList<String>) : CloudRecoveryEnrollment.PasskeyCeremony by inner {
        override suspend fun assert(credentialId: String, prfEvalInput: ByteArray): ByteArray = inner.assert(credentialId, prfEvalInput).also { calls += "sheet" }
        override suspend fun assertForRecovery(credentialId: String, prfEvalInput: ByteArray, challenge: String): Pair<ByteArray, String?> =
            inner.assertForRecovery(credentialId, prfEvalInput, challenge).also { calls += "sheet:$challenge" }
    }

    private fun adapter() = PasskeyCeremonyAdapter(
        PasskeyRecoveryManager(FakePasskeyApp(), retryDelayMs = 0),
        Robolectric.buildActivity(android.app.Activity::class.java).get(),
    )

    private suspend fun enroll(server: FlagshipServerClient, ceremony: CloudRecoveryEnrollment.PasskeyCeremony = adapter()) =
        CloudRecoveryEnrollment.enroll(
            server = server, passkeys = ceremony, irk = irkForUmk(umkSeed), irkPubHex = irkPubHexForUmk(umkSeed),
            username = username, umkSeed = umkSeed, passphrase = passphrase, passphraseConfirm = passphrase,
            acmeScalar = null, now = System.currentTimeMillis(),
        )

    /** A ceremony that makes passkeys without an attestation (an older passkey app path). */
    private class NoAttestation(private val inner: PasskeyCeremonyAdapter) : CloudRecoveryEnrollment.PasskeyCeremony {
        override suspend fun create(username: String, prfEvalInput: ByteArray) = inner.create(username, prfEvalInput)
        override suspend fun assert(credentialId: String, prfEvalInput: ByteArray) = inner.assert(credentialId, prfEvalInput)
    }

    @Test fun enrolmentSendsThePasskeysAttestationBesideTheSignedRecord() = runTest {
        val mock = MockFlagshipServerClient(simulatedLatencyMs = 0)
        val server = Recording(mock)
        val r = enroll(server)
        assertTrue(r.passkeyChecked)
        val att = server.uploaded!!.passkeyAttestationObject
        assertNotNull(att)
        assertFalse("base64url, no padding", att!!.contains('=') || att.contains('+') || att.contains('/'))
        assertTrue(mock.recoveryRecordState(username)!!.passkeyRequired)
    }

    @Test fun recoveryAsksForTheChallengeThenOneSheetThenFetchesWithTheAssertion() = runTest {
        val mock = MockFlagshipServerClient(simulatedLatencyMs = 0)
        enroll(mock)
        val server = Recording(mock)
        val result = CloudRecoveryEnrollment.restore(server, Sheets(adapter(), server.calls), username, passphrase, System.currentTimeMillis())
        assertEquals(HexUtil.encode(umkSeed), HexUtil.encode(result.umkSeed))
        assertFalse(result.passkeyLegacy)
        assertEquals(4, server.calls.size)
        assertEquals(listOf("meta", "challenge"), server.calls.take(2))
        assertTrue("the sheet signs .com's challenge", server.calls[2].startsWith("sheet:"))
        assertEquals("fetch+passkey", server.calls[3])
        val sent = mock.passkeyFetches.single()
        assertEquals(server.calls[2].removePrefix("sheet:"), sent["challenge"]!!.jsonPrimitive.content)
        val assertion = sent["assertion"]!!.jsonObject
        assertEquals(setOf("credentialId", "authenticatorData", "clientDataJSON", "signature"), assertion.keys)
    }

    @Test fun aKeyedRecordWithoutAnAssertionIsRefusedInASentence() = runTest {
        val mock = MockFlagshipServerClient(simulatedLatencyMs = 0)
        enroll(mock)
        // A ceremony that can't sign a challenge: the fetch goes without the passkey.
        try {
            CloudRecoveryEnrollment.restore(mock, NoAttestation(adapter()), username, passphrase, System.currentTimeMillis())
            fail("a keyed record releases nothing without the passkey")
        } catch (e: PasskeyCheckError) {
            assertEquals(RecoveryPasskeyText.REQUIRED, e.code)
            assertEquals("This recovery needs your passkey. Try again and choose your Flagship passkey.", e.message)
        }
    }

    @Test fun aRecordFromBeforeTheCheckStillRecoversAndSaysSo() = runTest {
        val mock = MockFlagshipServerClient(simulatedLatencyMs = 0)
        enroll(mock, NoAttestation(adapter()))
        assertFalse(mock.recoveryRecordState(username)!!.passkeyRequired)
        val result = CloudRecoveryEnrollment.restore(mock, adapter(), username, passphrase, System.currentTimeMillis())
        assertEquals(HexUtil.encode(umkSeed), HexUtil.encode(result.umkSeed))
        assertTrue(result.passkeyLegacy)
    }

    @Test fun withoutAChallengeALegacyRecordRecoversButAKeyedOneDoesNot() = runTest {
        val legacy = MockFlagshipServerClient(simulatedLatencyMs = 0)
        enroll(legacy, NoAttestation(adapter()))
        legacy.recoveryChallengeUnavailable = true
        val server = Recording(legacy)
        val ok = CloudRecoveryEnrollment.restore(server, adapter(), username, passphrase, System.currentTimeMillis())
        assertTrue(ok.passkeyLegacy)
        assertEquals(listOf("meta", "fetch"), server.calls)

        val keyed = MockFlagshipServerClient(simulatedLatencyMs = 0)
        enroll(keyed)
        keyed.recoveryChallengeUnavailable = true
        try {
            CloudRecoveryEnrollment.restore(keyed, adapter(), username, passphrase, System.currentTimeMillis())
            fail("a keyed record needs the challenge")
        } catch (e: PasskeyCheckError) {
            assertEquals("Passkey recovery isn't available right now. Try again later.", e.message)
        }
    }

    @Test fun reEscrowAfterARotationAlsoProvesThePasskey() = runTest {
        val mock = MockFlagshipServerClient(simulatedLatencyMs = 0)
        enroll(mock)
        CloudRecoveryEnrollment.reEscrowAdminRoot(
            mock, adapter(), irkForUmk(umkSeed), irkPubHexForUmk(umkSeed), username, passphrase, ByteArray(32) { 0x42 }, System.currentTimeMillis(),
        )
        assertEquals(1, mock.passkeyFetches.size)
        assertTrue("the same credential keeps .com's passkey check", mock.recoveryRecordState(username)!!.passkeyRequired)
    }

    /** Wipe & restart sends the NEW credential's attestation: the one register() just made. */
    @Test fun wipeRestartHasTheNewPasskeysAttestation() = runTest {
        val activity = Robolectric.buildActivity(android.app.Activity::class.java).get()
        val provider = PlatformWebAuthnProvider({ activity }, { username }, PasskeyRecoveryManager(FakePasskeyApp(), retryDelayMs = 0))
        val id = provider.register()
        val att = provider.attestationFor(id)
        assertNotNull(att)
        assertNull(provider.attestationFor("00".repeat(16)))
        val body = com.flagshipserver.app.api.WipeRestartRequest(
            request = com.flagshipserver.app.api.WipeRestartRequest.Inner(username, "a".repeat(64), "b".repeat(64), id, "AAAA", 1L),
            signature = "c".repeat(128),
            idempotencyKey = "d".repeat(32),
            newPasskeyAttestationObject = att,
        )
        val wire = com.flagshipserver.app.core.OkHttpJsonTransport.defaultJson.encodeToString(com.flagshipserver.app.api.WipeRestartRequest.serializer(), body)
        assertTrue(wire.contains("\"newPasskeyAttestationObject\":\"$att\""))
        val without = com.flagshipserver.app.core.OkHttpJsonTransport.defaultJson.encodeToString(com.flagshipserver.app.api.WipeRestartRequest.serializer(), body.copy(newPasskeyAttestationObject = null))
        assertFalse(without.contains("newPasskeyAttestationObject"))
    }

    @Test fun refusalCodesBecomeSentences() {
        fun body(code: String) = HttpException(403, """{"error":"x","code":"$code"}""")
        assertEquals("The passkey check expired. Try again.", (RecoveryPasskeyText.translate(body("passkey-challenge")) as PasskeyCheckError).message)
        assertEquals("That passkey isn't the one your account recovery uses.", (RecoveryPasskeyText.translate(body("passkey-invalid")) as PasskeyCheckError).message)
        assertEquals("Passkey recovery isn't available right now. Try again later.", RecoveryPasskeyText.forCode("passkey-unavailable"))
        assertEquals("This recovery needs your passkey. Try again and choose your Flagship passkey.", RecoveryPasskeyText.forCode("passkey-required"))
        val other = HttpException(403, "invalid fetch token")
        assertTrue(RecoveryPasskeyText.translate(other) === other)
        assertNull(RecoveryPasskeyText.codeOf(HttpException(409, """{"code":"stale"}""")))
    }

    @Test fun theUpdateIsOfferedOncePerAccount() {
        val ctx = RuntimeEnvironment.getApplication().applicationContext as Context
        val store = RecoveryUpdatePromptStore.fromContext(ctx)
        assertTrue(RecoveryUpdatePromptStore.shouldAsk(recordExists = true, passkeyRequired = false, asked = store.asked("Alice")))
        store.markAsked("alice")
        assertFalse(RecoveryUpdatePromptStore.shouldAsk(true, false, store.asked("ALICE")))
        assertTrue("another account on this device is asked on its own", RecoveryUpdatePromptStore.shouldAsk(true, false, store.asked("bob")))
        assertFalse(RecoveryUpdatePromptStore.shouldAsk(recordExists = true, passkeyRequired = true, asked = false))
        assertFalse(RecoveryUpdatePromptStore.shouldAsk(recordExists = false, passkeyRequired = false, asked = false))
    }
}
