// Which IRK does an account hold now, given its UMK? (key-file import, the recovery path)
//
// The clients derive the IRK from the UMK three ways, and an account holds whichever one its
// creating client (or its last re-pair) used:
//   web      HKDF(umk, salt "",                  info "flagship.irk.v<n>")   webapp, @flagship/protocol
//   ios      HKDF(umk, salt "",                  info "flagship/irk/v<n>")
//   android  HKDF(umk, salt "flagship/irk/v<n>", info "ed25519-seed")        this app (Keystore.irkSeed)
// An import finds the one whose public key `.com` serves for the account, signs the re-pair's
// credential with it, and rotates to the android scheme at that version + 1. Only keys derived
// from the file's own seed are tried, so `.com`'s answer can only choose among them.
// Vectors: packages/protocol/test-vectors/irk-lineage (tools/irk-lineage-vectors.mjs).

package com.flagshipserver.app.keystore

import com.flagshipserver.app.core.HexUtil
import com.google.crypto.tink.subtle.Ed25519Sign
import com.google.crypto.tink.subtle.Hkdf

object IrkLineage {
    enum class Scheme { WEB, IOS, ANDROID }

    const val MAX_VERSION = 16
    val OWN = Scheme.ANDROID

    class Key(val scheme: Scheme, val version: Int, val seed: ByteArray) {
        val pubHex: String get() = HexUtil.encode(Ed25519Sign.KeyPair.newKeyPairFromSeed(seed).publicKey)
        fun signer(): Ed25519Sign = Ed25519Sign(seed)
    }

    fun seed(umk: ByteArray, scheme: Scheme, version: Int): ByteArray {
        require(umk.size == 32) { "UMK seed must be 32 bytes" }
        require(version >= 1) { "IRK version must be >= 1" }
        val (salt, info) = when (scheme) {
            Scheme.WEB -> "" to "flagship.irk.v$version"
            Scheme.IOS -> "" to "flagship/irk/v$version"
            Scheme.ANDROID -> "flagship/irk/v$version" to "ed25519-seed"
        }
        return Hkdf.computeHkdf("HMACSHA256", umk, salt.toByteArray(), info.toByteArray(), 32)
    }

    fun key(umk: ByteArray, scheme: Scheme, version: Int) = Key(scheme, version, seed(umk, scheme, version))

    /** The key under [umk] whose public half is [registeredPubHex], or null when none of
     *  v1..[MAX_VERSION] in any scheme is (another account, or a file from before the account's key
     *  was replaced). Own scheme first: the common case. */
    fun findRegistered(umk: ByteArray, registeredPubHex: String, maxVersion: Int = MAX_VERSION): Key? {
        val want = registeredPubHex.lowercase()
        if (!Regex("^[0-9a-f]{64}$").matches(want)) return null
        val order = listOf(OWN) + Scheme.entries.filter { it != OWN }
        for (v in 1..maxVersion) for (s in order) {
            val k = key(umk, s, v)
            if (k.pubHex == want) return k
        }
        return null
    }

    /** Versions only climb, so a key a re-pair displaced is never installed again. */
    fun nextVersion(registered: Key): Int = registered.version + 1
}
