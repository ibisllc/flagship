package com.flagshipserver.app.core

import com.flagshipserver.app.core.pq.PqHybrid
import com.google.crypto.tink.subtle.Ed25519Verify
import java.security.GeneralSecurityException

/**
 * Ed25519 public keys from outside are checked here before any signature is verified under them
 * (test-vectors/ed25519-low-order; edSync.isAcceptableEd25519PublicKey on `.com`). Tink accepts
 * small-order keys, under which an identity R and a zero S verify for any message, so the verifier
 * alone is no guard. The check is Bouncy Castle's full validation (canonical, not small order, and
 * torsion-free, which every honestly made key is), the same as PqHybrid's strict profile.
 */
object Ed25519Keys {
    fun isAcceptable(pub: ByteArray?): Boolean = pub != null && PqHybrid.strictPoint(pub)

    fun isAcceptableHex(pubHex: String?): Boolean = pubHex != null && isAcceptable(HexUtil.decode(pubHex.lowercase()))
}

/**
 * Tink's Ed25519Verify behind [Ed25519Keys.isAcceptable]. Every app-side Ed25519 verify goes
 * through it. A refused key throws GeneralSecurityException, as a bad signature does.
 */
class CheckedEd25519Verify(private val publicKey: ByteArray) {
    @Throws(GeneralSecurityException::class)
    fun verify(signature: ByteArray, data: ByteArray) {
        if (!Ed25519Keys.isAcceptable(publicKey)) throw GeneralSecurityException("Ed25519 public key refused")
        Ed25519Verify(publicKey).verify(signature, data)
    }
}
