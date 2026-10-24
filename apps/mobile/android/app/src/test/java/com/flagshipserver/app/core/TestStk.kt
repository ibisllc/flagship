package com.flagshipserver.app.core

import com.google.crypto.tink.subtle.Ed25519Sign

/** Test fixtures only: the retired UMK-derived server key, which the shared daemon-status, LAN
 *  hint and box-trust vectors were made with. No real box has such a key (each makes a random
 *  one at install), so app code never derives one (docs/first-contact.md). */
object TestStk {
    fun seed(umkSeed: ByteArray, serverId: String): ByteArray =
        ServerKeys.hkdf32(ServerKeys.deriveSwk(umkSeed, serverId), "flagship.stk.v1")

    fun pub(umkSeed: ByteArray, serverId: String): ByteArray =
        Ed25519Sign.KeyPair.newKeyPairFromSeed(seed(umkSeed, serverId)).publicKey
}

/** A FirstContact whose pins already hold [pinned] (server → key hex): a server blessed before. */
fun firstContactPinned(vararg pinned: Pair<String, String>): FirstContact {
    val pins = ServerKeyPins(InMemoryServerKeyPinStore())
    for ((d, k) in pinned) pins.recordFirstSeen(d, k)
    return FirstContact(pins, InMemoryEnrollmentSecretStore(), studioSeen = { emptyList() })
}
