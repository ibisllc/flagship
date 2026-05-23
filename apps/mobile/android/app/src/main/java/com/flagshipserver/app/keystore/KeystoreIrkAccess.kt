// Production IrkAccess backed by the Keystore. Resolves the active-version
// IRK signer (biometric-gated via deriveIRK) plus its raw 32-byte seed
// (requireIrkSeedForVersion) — the seed is what the boot-secret RELAY
// coordinator uses to unseal the phone-sealed LUKS key, since Android has
// NO per-server BAK (the IRK is the only Ed25519 key material on device).

package com.flagshipserver.app.keystore

import com.flagshipserver.app.core.HexUtil
import com.flagshipserver.app.core.IrkAccess
import com.flagshipserver.app.core.IrkMaterial
import com.google.crypto.tink.subtle.Ed25519Sign

class KeystoreIrkAccess : IrkAccess {
    override suspend fun resolve(reason: String): IrkMaterial {
        // deriveIRK runs the biometric gate AND caches the per-version seed,
        // so requireIrkSeedForVersion below is guaranteed to find it.
        val signer = Keystore.deriveIRK(reason)
        val version = Keystore.currentIrkVersion()
        val seed = Keystore.requireIrkSeedForVersion(version)
        val pub = Ed25519Sign.KeyPair.newKeyPairFromSeed(seed).publicKey
        return IrkMaterial(signer = signer, seed = seed, pubHex = HexUtil.encode(pub))
    }
}
