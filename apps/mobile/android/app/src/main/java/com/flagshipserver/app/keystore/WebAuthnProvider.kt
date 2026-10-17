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

    /** PRF-assert against the given credentialId with the LEGACY fixed
     *  salt (Recovery.PRF_SALT). Returns the 32-byte hmac-secret output. */
    suspend fun prfAssert(credentialId: String): ByteArray

    /** PRF-assert against [credentialId] with an explicit [prfSalt] as the
     *  WebAuthn `prf.eval.first` input — the passphrase-derived salt for
     *  the gated cloud-recovery flow. Defaults to [prfAssert] (the fixed
     *  salt) so existing impls + the Wipe/register seam keep working. */
    suspend fun prfAssertWithSalt(credentialId: String, prfSalt: ByteArray): ByteArray =
        prfAssert(credentialId)
}
