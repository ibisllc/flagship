package com.flagshipserver.app.keystore

import com.google.crypto.tink.subtle.Hkdf
import java.security.SecureRandom
import java.util.UUID

class MockWebAuthnProvider : WebAuthnProvider {
    private val rng = SecureRandom()
    override suspend fun register(): String {
        // Deterministic-shape mock: 32-byte random hex string with a
        // "mock-cred-" prefix removed (the Worker validates 8–256
        // hex bytes, so we mint a plain hex blob).
        val bytes = ByteArray(32).also(rng::nextBytes)
        return bytes.joinToString("") { "%02x".format(it) }
    }
    override suspend fun prfAssert(credentialId: String): ByteArray {
        // Stable secret keyed off the credentialId so the same
        // credential produces the same PRF output across calls.
        // Matches the iOS MockWebAuthnProvider's hashing.
        return Hkdf.computeHkdf(
            /* macAlgorithm = */ "HMACSHA256",
            /* ikm = */ credentialId.toByteArray(Charsets.UTF_8),
            /* salt = */ "flagship/mock-prf/v1".toByteArray(Charsets.UTF_8),
            /* info = */ ByteArray(0),
            /* size = */ 32,
        )
    }
    override suspend fun prfAssertWithSalt(credentialId: String, prfSalt: ByteArray): ByteArray {
        // Fold the prfSalt into the deterministic secret so a Mock
        // enrollment + restore that share the same (credentialId, prfSalt)
        // round-trip the AES-GCM wrap, while a different salt yields a
        // different secret (mirrors a real authenticator's PRF coupling).
        return Hkdf.computeHkdf(
            /* macAlgorithm = */ "HMACSHA256",
            /* ikm = */ credentialId.toByteArray(Charsets.UTF_8),
            /* salt = */ "flagship/mock-prf/v1".toByteArray(Charsets.UTF_8),
            /* info = */ prfSalt,
            /* size = */ 32,
        )
    }
}
