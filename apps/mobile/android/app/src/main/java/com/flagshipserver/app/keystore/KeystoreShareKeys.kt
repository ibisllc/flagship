package com.flagshipserver.app.keystore

import com.flagshipserver.app.core.ShareKeys
import com.google.crypto.tink.subtle.Ed25519Sign

/** The share flows' keys from this device's keystore, each behind the biometric gate. */
class KeystoreShareKeys : ShareKeys {
    override suspend fun umk(reason: String): ByteArray {
        BiometricAuthority.current()?.ensureFresh(title = "Authorize Flagship", subtitle = reason)
        return Keystore.loadOrCreateUmkSeed()
    }

    override suspend fun sensitive(reason: String): Ed25519Sign = Keystore.adminSigningKey(reason)

    override suspend fun accountKey(reason: String): Ed25519Sign = Keystore.deriveIRK(reason)

    override suspend fun irkSeed(reason: String): ByteArray = KeystoreIrkAccess().resolve(reason).seed

    override fun unlocked(): Boolean = BiometricAuthority.current()?.isFresh() ?: true

    override fun adminRootPubHex(): String? = Keystore.adminRootPubHex()

    override suspend fun adminRoot(reason: String): Ed25519Sign = Keystore.adminRootKey(reason)
}
