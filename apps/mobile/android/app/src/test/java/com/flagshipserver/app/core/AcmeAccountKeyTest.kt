// #28 — AcmeAccountKey crypto: the cross-platform known-answer lock plus
// the escrow wrap/unwrap round-trip + wrong-PRF isolation. Pure-JVM (like
// RecoveryWrapTest) — BouncyCastle is on the test classpath via the main
// `implementation` dep, so no Robolectric needed.

package com.flagshipserver.app.core

import java.math.BigInteger
import java.security.SecureRandom
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.fail
import org.junit.Test

class AcmeAccountKeyTest {
    private fun rand(n: Int): ByteArray = ByteArray(n).also { SecureRandom().nextBytes(it) }

    /** Left-pad a BigInteger to 32 big-endian bytes (test-local copy of the
     *  object's private helper, used only to build the scalar=2 vector). */
    private fun scalar32(v: BigInteger): ByteArray {
        val raw = v.toByteArray()
        val out = ByteArray(32)
        when {
            raw.size == 32 -> System.arraycopy(raw, 0, out, 0, 32)
            raw.size < 32 -> System.arraycopy(raw, 0, out, 32 - raw.size, raw.size)
            else -> System.arraycopy(raw, raw.size - 32, out, 0, 32)
        }
        return out
    }

    /**
     * CROSS-PLATFORM LOCK — scalar = 2 on secp256r1 (P-256) must produce the
     * exact uncompressed SEC1 pubkey + accountKeyId shared with iOS + the
     * .com cloud. If either literal drifts, every platform's account-key
     * identity diverges and recovery silently restores the wrong key.
     */
    @Test fun accountKeyId_knownAnswerVector() {
        val scalar = scalar32(BigInteger.valueOf(2))

        val expectedPubHex =
            "047cf27b188d034f7e8a52380304b51ac3c08969e277f21b35a60b48fc476699" +
                "7807775510db8ed040293d9ac69f7430dbba7dade63ce982299e04b79d227873d1"
        val expectedAccountKeyId =
            "a9f300eb5960e89133af7362011a1e26f0e2ea2e36dc402a04af6c192b891a8c"

        val pubHex = HexUtil.encode(AcmeAccountKey.publicUncompressed(scalar))
        assertEquals(expectedPubHex, pubHex)
        // 65-byte uncompressed point: 0x04 ‖ X(32) ‖ Y(32).
        assertEquals(130, pubHex.length)
        assertEquals("04", pubHex.substring(0, 2))

        assertEquals(expectedAccountKeyId, AcmeAccountKey.accountKeyId(scalar))
    }

    /** A freshly minted scalar is 32 bytes and its accountKeyId is a stable
     *  64-hex-char digest. */
    @Test fun generateScalar_is32Bytes_andAccountKeyIdIsStable() {
        val scalar = AcmeAccountKey.generateScalar()
        assertEquals(32, scalar.size)
        val id = AcmeAccountKey.accountKeyId(scalar)
        assertEquals(64, id.length)
        assertEquals(id, AcmeAccountKey.accountKeyId(scalar))
    }

    @Test fun escrow_wrapThenUnwrap_roundTrips() {
        val scalar = rand(32)
        val prf = rand(32)
        val blob = AcmeAccountKey.wrapForEscrow(scalar, prf)
        val recovered = AcmeAccountKey.unwrapFromEscrow(blob, prf)
        assertArrayEquals(scalar, recovered)
    }

    /** The escrow blob is self-contained: base64(nonce(12) ‖ ct(32) ‖
     *  tag(16)) = 60 bytes ⇒ 80 base64 chars. Guards the on-wire framing the
     *  cloud + iOS agree on. */
    @Test fun escrow_blobIsSelfContainedFramedBlob() {
        val blob = AcmeAccountKey.wrapForEscrow(rand(32), rand(32))
        val raw = java.util.Base64.getDecoder().decode(blob)
        assertEquals(12 + 32 + 16, raw.size)
    }

    @Test fun escrow_nonceIsFreshOnEveryWrap() {
        val scalar = rand(32)
        val prf = rand(32)
        assertNotEquals(
            AcmeAccountKey.wrapForEscrow(scalar, prf),
            AcmeAccountKey.wrapForEscrow(scalar, prf),
        )
    }

    @Test fun escrow_wrongPrf_fails() {
        val scalar = rand(32)
        val blob = AcmeAccountKey.wrapForEscrow(scalar, rand(32))
        try {
            AcmeAccountKey.unwrapFromEscrow(blob, rand(32))
            fail("expected GCM tag failure under a different PRF secret")
        } catch (_: javax.crypto.AEADBadTagException) { /* ok */ }
    }
}
