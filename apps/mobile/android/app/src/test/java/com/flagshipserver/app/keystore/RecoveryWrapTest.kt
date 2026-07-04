// Recovery.wrap / Recovery.unwrap roundtrip + cross-key isolation.
// wrap now returns ONE self-contained base64 blob (nonce ‖ ct ‖ tag) —
// the exact `wrappedUmk` value that ships on the wire. Pure-JVM — no
// Robolectric needed.

package com.flagshipserver.app.keystore

import com.flagshipserver.app.core.AcmeAccountKey
import com.flagshipserver.app.core.AdminRootEscrow
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class RecoveryWrapTest {
    private fun rand(n: Int): ByteArray =
        ByteArray(n).also { SecureRandom().nextBytes(it) }

    private fun hex(s: String): ByteArray =
        ByteArray(s.length / 2) { ((Character.digit(s[it * 2], 16) shl 4) + Character.digit(s[it * 2 + 1], 16)).toByte() }

    private fun b64(b: ByteArray): String = java.util.Base64.getEncoder().encodeToString(b)

    /** RFC 5869 HKDF-SHA256 (info empty) — mirrors the private helper in
     *  Recovery.kt / AdminRootEscrow.kt so the forward KAT can re-derive the
     *  wrap key without reaching into their internals. */
    private fun hkdf(ikm: ByteArray, salt: ByteArray, len: Int): ByteArray {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(salt, "HmacSHA256"))
        val prk = mac.doFinal(ikm)
        mac.init(SecretKeySpec(prk, "HmacSHA256"))
        val out = ByteArray(len)
        var t = ByteArray(0)
        var c = 1
        var w = 0
        while (w < len) {
            mac.reset(); mac.update(t); mac.update(c.toByte()); t = mac.doFinal()
            val n = minOf(t.size, len - w); System.arraycopy(t, 0, out, w, n); w += n; c++
        }
        return out
    }

    private fun sealFixedNonce(pt: ByteArray, prf: ByteArray, salt: String, nonce: ByteArray): String {
        val key = hkdf(prf, salt.toByteArray(), 32)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, nonce))
        val ct = cipher.doFinal(pt)
        return b64(nonce + ct)
    }

    /**
     * Cross-platform escrow KAT (Issue 2 anti-drift guard). A FIXED
     * (prfSecret, seeds, nonce) → pinned ciphertext, SHARED verbatim with the
     * webapp (apps/web/tests/fixtures/recoveryWrapGolden.json) and iOS
     * (AdminRootTests). Proves the escrow wrap is byte-identical across all
     * three surfaces — the guard that would have caught the webapp raw-PRF
     * divergence (only random-nonce round-trips existed before).
     */
    @Test fun escrowWrap_crossPlatformGoldenKAT() {
        val prf = hex("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f")
        val umk = hex("202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f")
        val acme = hex("404142434445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e5f")
        val admin = hex("606162636465666768696a6b6c6d6e6f707172737475767778797a7b7c7d7e7f")
        val nonce = hex("a0a1a2a3a4a5a6a7a8a9aaab")
        val umkBlob = "oKGio6SlpqeoqaqrhgoulhbK4Hw5GnZ/Eg3p2tE8znE4LEH4VNFNiZqUWTG1AJh5e1ANGjervCj+CdE/"
        val acmeBlob = "oKGio6SlpqeoqaqrYhwcBqIf+sPx7eZDHRsCyYYye+B4JJtN4LoVBzGOndkEPhG4pToPWRTfw7TS+I3I"
        val adminBlob = "oKGio6SlpqeoqaqrrTVhM+39nuBWm85By/ZoC+0FhIEMWdL4J2aBSr+wcO3RBVAkuZ8NANC3dtXp0j84"

        // (a) DECRYPT parity — the SHIPPED unwraps open the pinned webapp blobs.
        assertArrayEquals("web UMK blob unwraps on Android", umk, Recovery.unwrap(umkBlob, prf))
        assertArrayEquals(acme, AcmeAccountKey.unwrapFromEscrow(acmeBlob, prf))
        assertArrayEquals(admin, AdminRootEscrow.unwrapFromEscrow(adminBlob, prf))

        // (b) ENCRYPT parity — HKDF-SHA256 + AES-256-GCM with the fixed nonce
        //     reproduces the pinned ciphertext byte-for-byte.
        assertEquals(umkBlob, sealFixedNonce(umk, prf, "flagship/recovery-wrap/v1", nonce))
        assertEquals(acmeBlob, sealFixedNonce(acme, prf, "flagship/recovery-acme-wrap/v1", nonce))
        assertEquals(adminBlob, sealFixedNonce(admin, prf, "flagship/recovery-admin-root-wrap/v1", nonce))
    }

    @Test fun roundtripsUmkSeed() {
        val seed = rand(32)
        val prf = rand(32)
        val wrapped = Recovery.wrap(seed, prf)
        val recovered = Recovery.unwrap(wrapped, prf)
        assertArrayEquals(seed, recovered)
    }

    @Test fun wrappedBlobIsSelfContained() {
        // nonce(12) + ct(32 == seed) + tag(16) = 60 bytes inside the blob.
        val wrapped = Recovery.wrap(rand(32), rand(32))
        val raw = java.util.Base64.getDecoder().decode(wrapped)
        assertTrue("blob carries nonce+ct+tag", raw.size == 12 + 32 + 16)
    }

    @Test fun differentPrfSecretsFailToDecrypt() {
        val seed = rand(32)
        val prfA = rand(32)
        val prfB = rand(32)
        val wrapped = Recovery.wrap(seed, prfA)
        try {
            Recovery.unwrap(wrapped, prfB)
            fail("expected GCM tag failure")
        } catch (_: javax.crypto.AEADBadTagException) { /* ok */ }
    }

    @Test fun nonceIsFreshOnEverySeal() {
        val seed = rand(32)
        val prf = rand(32)
        val a = Recovery.wrap(seed, prf)
        val b = Recovery.wrap(seed, prf)
        // Distinct nonces ⇒ distinct blobs even for the same seed+prf.
        assertNotEquals(a, b)
    }
}
