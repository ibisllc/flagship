// End-to-end tests for the passphrase-gated cloud-recovery ceremony
// against the Mock Worker: enroll → gated fetch → unwrap round-trips
// (incl. the #28 ACME-key escrow), the credentialId travels as HEX on the
// wire, and a tampered prfSaltHash is refused.
//
// Uses the REAL RecoveryDerivation (Argon2id ~1-2s per derive) so the
// gate hashes the Mock stores are the same the restore path re-derives.
// The passkey ceremony is faked with a deterministic PRF coupling keyed
// by (credentialId, prfSalt) — exactly the shape MockWebAuthnProvider
// uses — so the AES-GCM wrap round-trips.

package com.flagshipserver.app.keystore

import com.flagshipserver.app.api.MockFlagshipServerClient
import com.flagshipserver.app.api.RecoveryEnvelopeRequest
import com.flagshipserver.app.core.AcmeAccountKey
import com.flagshipserver.app.core.HexUtil
import com.google.crypto.tink.subtle.Ed25519Sign
import com.google.crypto.tink.subtle.Hkdf
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class CloudRecoveryEnrollmentTest {

    private val username = "demo1234"
    private val passphrase = "correct horse battery staple"

    /** A 16-byte (32-hex) raw credential id — the HEX form the Worker
     *  requires and the webapp sends. */
    private val credentialIdHex = "aabbccddeeff00112233445566778899"

    /** Deterministic PRF coupling: the secret depends on BOTH the
     *  credentialId and the prfSalt, mirroring MockWebAuthnProvider
     *  .prfAssertWithSalt + a real authenticator's hmac-secret. */
    private fun prfSecret(credentialId: String, prfSalt: ByteArray): ByteArray =
        Hkdf.computeHkdf(
            "HMACSHA256",
            credentialId.toByteArray(Charsets.UTF_8),
            "flagship/mock-prf/v1".toByteArray(Charsets.UTF_8),
            prfSalt,
            32,
        )

    /** Fake passkey ceremony — `create` mints our fixed hex credentialId
     *  and harvests the coupled secret; `assert` re-derives it. */
    private inner class FakeCeremony : CloudRecoveryEnrollment.PasskeyCeremony {
        override suspend fun create(username: String, prfEvalInput: ByteArray): Pair<String, ByteArray> =
            credentialIdHex to prfSecret(credentialIdHex, prfEvalInput)

        override suspend fun assert(credentialId: String, prfEvalInput: ByteArray): ByteArray =
            prfSecret(credentialId, prfEvalInput)
    }

    private fun irk(seedByte: Byte): Ed25519Sign {
        val seed = ByteArray(32) { seedByte }
        return Ed25519Sign(seed)
    }

    private val umkSeed = ByteArray(32) { (it + 1).toByte() }

    @Test
    fun enrollThenRestore_roundTripsUmk() = runTest {
        val server = MockFlagshipServerClient(simulatedLatencyMs = 0)
        CloudRecoveryEnrollment.enroll(
            server = server,
            passkeys = FakeCeremony(),
            irk = irk(0x03),
            username = username,
            umkSeed = umkSeed,
            passphrase = passphrase,
            passphraseConfirm = passphrase,
            acmeScalar = null,
            now = 1_700_000_000_000L,
        )
        val restored = CloudRecoveryEnrollment.restore(
            server = server,
            passkeys = FakeCeremony(),
            username = username,
            passphrase = passphrase,
            now = 1_700_000_000_001L,
        )
        assertEquals(HexUtil.encode(umkSeed), HexUtil.encode(restored.umkSeed))
        assertNull("no ACME key was escrowed", restored.acmeScalar)
    }

    @Test
    fun enrollThenRestore_restoresEscrowedAcmeKey() = runTest {
        val server = MockFlagshipServerClient(simulatedLatencyMs = 0)
        val acmeScalar = AcmeAccountKey.generateScalar()
        CloudRecoveryEnrollment.enroll(
            server = server,
            passkeys = FakeCeremony(),
            irk = irk(0x03),
            username = username,
            umkSeed = umkSeed,
            passphrase = passphrase,
            passphraseConfirm = passphrase,
            acmeScalar = acmeScalar,
            now = 1_700_000_000_000L,
        )
        val restored = CloudRecoveryEnrollment.restore(
            server = server,
            passkeys = FakeCeremony(),
            username = username,
            passphrase = passphrase,
            now = 1_700_000_000_001L,
        )
        assertEquals(HexUtil.encode(umkSeed), HexUtil.encode(restored.umkSeed))
        assertNotNull("ACME key should be restored", restored.acmeScalar)
        assertEquals(HexUtil.encode(acmeScalar), HexUtil.encode(restored.acmeScalar!!))
    }

    /** Wrap a Mock with interface delegation, capturing the upload body the
     *  helper builds (MockFlagshipServerClient is final, so we can't
     *  subclass it — delegate + intercept instead). */
    private class CapturingServer(
        private val delegate: MockFlagshipServerClient,
    ) : com.flagshipserver.app.api.FlagshipServerClient by delegate {
        var captured: RecoveryEnvelopeRequest? = null
        override suspend fun registerRecoveryEnvelope(req: RecoveryEnvelopeRequest) =
            delegate.registerRecoveryEnvelope(req).also { captured = req }
    }

    @Test
    fun enroll_sendsCredentialIdAsHex_andGateHashes() = runTest {
        // Assert the credentialId travels as hex (Worker regex
        // ^[0-9a-fA-F]{16,512}$) and the gate hashes are present + 64
        // lowercase hex chars.
        val capturing = CapturingServer(MockFlagshipServerClient(simulatedLatencyMs = 0))
        CloudRecoveryEnrollment.enroll(
            server = capturing,
            passkeys = FakeCeremony(),
            irk = irk(0x03),
            username = username,
            umkSeed = umkSeed,
            passphrase = passphrase,
            passphraseConfirm = passphrase,
            acmeScalar = null,
            now = 1_700_000_000_000L,
        )
        val inner = capturing.captured!!.request
        assertEquals(credentialIdHex, inner.credentialId)
        assertTrue(
            "credentialId must be 16-512 hex chars",
            Regex("^[0-9a-fA-F]{16,512}$").matches(inner.credentialId),
        )
        assertTrue(
            "fetchTokenHash must be 64 lowercase hex",
            Regex("^[0-9a-f]{64}$").matches(inner.fetchTokenHash ?: ""),
        )
        assertTrue(
            "prfSaltHash must be 64 lowercase hex",
            Regex("^[0-9a-f]{64}$").matches(inner.prfSaltHash ?: ""),
        )
        // The stored gate hashes equal sha256 of the locally-derived tokens.
        val secrets = RecoveryDerivation.derivePassphraseSecrets(passphrase, username)
        assertEquals(RecoveryDerivation.sha256Hex(secrets.fetchToken), inner.fetchTokenHash)
        assertEquals(RecoveryDerivation.sha256Hex(secrets.prfSalt), inner.prfSaltHash)
    }

    @Test
    fun enroll_serializedBody_keepsCredentialIdHexOnWire() = runTest {
        // Belt-and-braces: serialize exactly like the live transport and
        // assert the JSON carries the hex id (not base64url) + both hashes.
        val capturing = CapturingServer(MockFlagshipServerClient(simulatedLatencyMs = 0))
        CloudRecoveryEnrollment.enroll(
            server = capturing,
            passkeys = FakeCeremony(),
            irk = irk(0x03),
            username = username,
            umkSeed = umkSeed,
            passphrase = passphrase,
            passphraseConfirm = passphrase,
            acmeScalar = null,
            now = 1_700_000_000_000L,
        )
        val json = Json { encodeDefaults = true; explicitNulls = false }
            .encodeToString(RecoveryEnvelopeRequest.serializer(), capturing.captured!!)
        val inner = Json.parseToJsonElement(json).jsonObject["request"]!!.jsonObject
        assertEquals(credentialIdHex, inner["credentialId"]!!.jsonPrimitive.content)
        assertTrue(inner.containsKey("fetchTokenHash"))
        assertTrue(inner.containsKey("prfSaltHash"))
    }

    @Test
    fun restore_wrongPassphrase_isRefusedByGate() = runTest {
        val server = MockFlagshipServerClient(simulatedLatencyMs = 0)
        CloudRecoveryEnrollment.enroll(
            server = server,
            passkeys = FakeCeremony(),
            irk = irk(0x03),
            username = username,
            umkSeed = umkSeed,
            passphrase = passphrase,
            passphraseConfirm = passphrase,
            acmeScalar = null,
            now = 1_700_000_000_000L,
        )
        try {
            CloudRecoveryEnrollment.restore(
                server = server,
                passkeys = FakeCeremony(),
                username = username,
                passphrase = "the wrong passphrase entirely",
                now = 1_700_000_000_001L,
            )
            fail("a wrong passphrase must not unwrap the UMK")
        } catch (e: com.flagshipserver.app.core.HttpException) {
            // The Mock gate returns 403 (mirrors the Worker) when
            // sha256(fetchToken) doesn't match.
            assertEquals(403, e.status)
        }
    }

    @Test
    fun restore_stalePrfSaltHash_isRefused() = runTest {
        // Simulate a malicious / stale .com that passes the fetchToken gate
        // but returns a prfSaltHash that doesn't match the locally-derived
        // prfSalt. The helper must refuse BEFORE attempting the PRF assert
        // (recovery.js's defense-in-depth).
        val server = MockFlagshipServerClient(simulatedLatencyMs = 0)
        CloudRecoveryEnrollment.enroll(
            server = server,
            passkeys = FakeCeremony(),
            irk = irk(0x03),
            username = username,
            umkSeed = umkSeed,
            passphrase = passphrase,
            passphraseConfirm = passphrase,
            acmeScalar = null,
            now = 1_700_000_000_000L,
        )
        // Delegate everything to the enrolled Mock but tamper the returned
        // prfSaltHash (the gate still passes — only the salt commitment lies).
        val poisoned = object : com.flagshipserver.app.api.FlagshipServerClient by server {
            override suspend fun fetchWrappedUmkWithToken(
                username: String,
                fetchTokenHex: String,
                issuedAt: Long,
            ): com.flagshipserver.app.api.GatedRecoveryEnvelope {
                val real = server.fetchWrappedUmkWithToken(username, fetchTokenHex, issuedAt)
                return real.copy(prfSaltHash = "f".repeat(64)) // not our prfSalt
            }
        }
        try {
            CloudRecoveryEnrollment.restore(
                server = poisoned,
                passkeys = FakeCeremony(),
                username = username,
                passphrase = passphrase,
                now = 1_700_000_000_001L,
            )
            fail("a stale prfSaltHash must be refused")
        } catch (e: CloudRecoveryEnrollment.ValidationError) {
            assertTrue(e.message!!.contains("prfSaltHash"))
        }
    }

    @Test
    fun enroll_tooShortPassphrase_throwsValidation() = runTest {
        val server = MockFlagshipServerClient(simulatedLatencyMs = 0)
        try {
            CloudRecoveryEnrollment.enroll(
                server = server,
                passkeys = FakeCeremony(),
                irk = irk(0x03),
                username = username,
                umkSeed = umkSeed,
                passphrase = "short",
                passphraseConfirm = "short",
                acmeScalar = null,
                now = 1_700_000_000_000L,
            )
            fail("passphrase under 8 chars must be rejected")
        } catch (e: CloudRecoveryEnrollment.ValidationError) {
            assertTrue(e.message!!.contains("8"))
        }
    }

    @Test
    fun enroll_mismatchedPassphrase_throwsValidation() = runTest {
        val server = MockFlagshipServerClient(simulatedLatencyMs = 0)
        try {
            CloudRecoveryEnrollment.enroll(
                server = server,
                passkeys = FakeCeremony(),
                irk = irk(0x03),
                username = username,
                umkSeed = umkSeed,
                passphrase = "passphrase-one",
                passphraseConfirm = "passphrase-two",
                acmeScalar = null,
                now = 1_700_000_000_000L,
            )
            fail("mismatched passphrases must be rejected")
        } catch (e: CloudRecoveryEnrollment.ValidationError) {
            assertTrue(e.message!!.contains("match"))
        }
    }
}
