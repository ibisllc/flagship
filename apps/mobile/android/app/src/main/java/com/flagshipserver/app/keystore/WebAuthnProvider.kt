// E4 — Kotlin mirror of FlagshipUI's WebAuthnProvider abstraction.
//
// Live production impl wraps androidx.credentials.CredentialManager.
// Tests + previews use the Mock which derives a deterministic PRF
// secret per credentialId so the wrap+unwrap round-trip is stable.

package com.flagshipserver.app.keystore

import com.google.crypto.tink.subtle.Hkdf
import java.security.SecureRandom
import java.util.UUID

interface WebAuthnProvider {
    /** Register a new platform passkey. Returns the new credentialId
     *  (hex-encoded). */
    suspend fun register(): String

    /** PRF-assert against the given credentialId. Returns the
     *  32-byte hmac-secret output. */
    suspend fun prfAssert(credentialId: String): ByteArray
}

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
}
