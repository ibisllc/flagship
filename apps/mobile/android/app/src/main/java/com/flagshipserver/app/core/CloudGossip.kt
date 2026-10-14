// The Cloud Gossip Key, mirroring `deriveCGK` in
// `packages/protocol/src/cloudGossip.ts`. The phone only derives and deposits
// it; the gossip frames, the server order they carry and the leadership
// election all run on the boxes (docs/server-order.md).
//
//   CGK = HKDF-SHA256(ikm = umkSeed, salt = empty,
//                     info = "flagship.cloud-gossip.v1", 32)
//
// One key PER CLOUD (no serverId), derived the same way as
// ServerKeys.deriveSwk; only the info differs. `CloudGossipVectorTest.kt` pins it.

package com.flagshipserver.app.core

import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

object CloudGossip {
    private const val INFO_CGK = "flagship.cloud-gossip.v1"

    fun deriveCGK(umkSeed: ByteArray): ByteArray {
        require(umkSeed.size == 32) { "UMK seed must be 32 bytes" }
        return hkdfSha256(umkSeed, INFO_CGK.toByteArray(Charsets.UTF_8))
    }

    private fun hkdfSha256(ikm: ByteArray, info: ByteArray, length: Int = 32): ByteArray {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(ByteArray(32), "HmacSHA256"))
        val prk = mac.doFinal(ikm)
        mac.init(SecretKeySpec(prk, "HmacSHA256"))
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
