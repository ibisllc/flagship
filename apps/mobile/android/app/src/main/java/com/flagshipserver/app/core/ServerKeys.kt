// Kotlin mirror of the phone-side server-key derivation in
// packages/protocol/src/keys.ts (deriveSWK / deriveSTK). The phone holds the
// UMK, so it can derive any of its boxes' STK pubkeys LOCALLY — this is what
// makes the STK-signed daemon-status report verifiable end-to-end without
// trusting `.com`'s identityPubKey echo (cert-model A′, phase 4 pinning).
//
// MUST stay byte-identical to the TS implementation:
//   SWK      = HKDF-SHA256(ikm = UMK seed, salt = empty,
//                          info = "flagship.swk.v1|<serverId>", 32)
//   STK seed = HKDF-SHA256(ikm = SWK, salt = empty,
//                          info = "flagship.stk.v1", 32)
//   STK      = Ed25519 keypair from that seed
// The pinned cross-platform vector in DaemonStatusReportTest (UMK 07×32 →
// STK pub 0a1eaaad…0d47) locks this in.

package com.flagshipserver.app.core

import com.google.crypto.tink.subtle.Ed25519Sign

object ServerKeys {
    private const val INFO_SWK = "flagship.swk.v1"
    private const val INFO_STK = "flagship.stk.v1"
    private const val INFO_IRK = "flagship.irk.v1"

    /** The owner IRK seed (32 bytes) derived from the UMK seed the PROTOCOL way
     *  — Ed25519 over HKDF-SHA256(umkSeed, salt=empty, info="flagship.irk.v1").
     *  This is DISTINCT from the Android Keystore's slash-form `deriveIRK`
     *  (salt="flagship/irk/vN", info="ed25519-seed"); a box provisioned by
     *  @flagship/protocol (the webapp / live gym) is owned by THIS derivation.
     *  Mirrors ServerKeys.swift `deriveProtocolIrk` + protocol keys.ts. */
    fun deriveProtocolIrkSeed(umkSeed: ByteArray): ByteArray {
        require(umkSeed.size == 32) { "UMK seed must be 32 bytes" }
        return hkdfSha256(umkSeed, INFO_IRK.toByteArray(Charsets.UTF_8))
    }

    /** A Tink Ed25519 signer over the protocol IRK seed (signs box orders /
     *  journal / power / front-page for a protocol-provisioned box). */
    fun deriveProtocolIrk(umkSeed: ByteArray): Ed25519Sign =
        Ed25519Sign(deriveProtocolIrkSeed(umkSeed))

    /** The protocol IRK Ed25519 PUBLIC key (32 bytes) for the UMK seed. */
    fun deriveProtocolIrkPub(umkSeed: ByteArray): ByteArray =
        Ed25519Sign.KeyPair.newKeyPairFromSeed(deriveProtocolIrkSeed(umkSeed)).publicKey

    fun deriveSwk(umkSeed: ByteArray, serverId: String): ByteArray {
        require(umkSeed.size == 32) { "UMK seed must be 32 bytes" }
        return hkdfSha256(umkSeed, "$INFO_SWK|$serverId".toByteArray(Charsets.UTF_8))
    }

    fun deriveStkSeed(umkSeed: ByteArray, serverId: String): ByteArray =
        hkdfSha256(deriveSwk(umkSeed, serverId), INFO_STK.toByteArray(Charsets.UTF_8))

    /** The box's STK Ed25519 PUBLIC key (32 bytes), derived from the phone's
     *  own UMK — the trust anchor for verifying STK-signed reports. */
    fun deriveStkPub(umkSeed: ByteArray, serverId: String): ByteArray =
        Ed25519Sign.KeyPair.newKeyPairFromSeed(deriveStkSeed(umkSeed, serverId)).publicKey

    /**
     * RFC 5869 HKDF-SHA256 with an EMPTY salt — the TS protocol passes
     * `new Uint8Array(0)`. HMAC zero-pads short keys to the block size, so a
     * 32-zero-byte key is byte-identical to the empty key Java's
     * SecretKeySpec refuses to hold.
     */
    private fun hkdfSha256(ikm: ByteArray, info: ByteArray, length: Int = 32): ByteArray {
        val mac = javax.crypto.Mac.getInstance("HmacSHA256")
        mac.init(javax.crypto.spec.SecretKeySpec(ByteArray(32), "HmacSHA256"))
        val prk = mac.doFinal(ikm)
        mac.init(javax.crypto.spec.SecretKeySpec(prk, "HmacSHA256"))
        val out = ByteArray(length)
        var t = ByteArray(0)
        var counter = 1
        var written = 0
        while (written < length) {
            mac.reset()
            mac.update(t)
            mac.update(info)
            mac.update(counter.toByte())
            t = mac.doFinal()
            val n = minOf(t.size, length - written)
            System.arraycopy(t, 0, out, written, n)
            written += n
            counter++
        }
        return out
    }
}
