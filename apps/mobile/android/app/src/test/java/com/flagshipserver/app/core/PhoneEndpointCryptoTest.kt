// Plain-JVM tests for the phone-side relay crypto (no android.jar needed —
// Tink + java.security only). The hand-rolled GF(2^255-19) field + the
// Ed25519->X25519 maps are the real correctness risk; the round-trips here
// fail loudly if the field math drifts. Mirrors the iOS PhoneEndpointTests /
// SecretRequestCoordinatorTests round-trips.

package com.flagshipserver.app.core

import com.google.crypto.tink.subtle.Ed25519Sign
import com.google.crypto.tink.subtle.Ed25519Verify
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PhoneEndpointCryptoTest {

    private fun hex(b: ByteArray) = b.joinToString("") { "%02x".format(it) }

    // Seal FOR an Ed25519 pubkey, open with the X25519 private derived from
    // that key's seed. If edwardsPubToMontgomery / edwardsSeedToMontgomery (or
    // the field arithmetic underneath) is wrong, the two X25519 keys won't
    // agree and AES-GCM open throws.
    @Test fun sealForEd25519Recipient_roundTrips_viaSeedMappedX25519() {
        val kp = Ed25519Sign.KeyPair.newKeyPair()
        val edPub = kp.publicKey
        val seed = kp.privateKey
        val secret = ByteArray(64) { ((it * 7) and 0xff).toByte() }

        val blob = SecretSeal.sealForEd25519Recipient(secret, edPub)
        // wire layout: [ephPub:32][nonce:12][ct + tag:16]
        assertEquals(32 + 12 + 16 + secret.size, blob.size)

        val x25519Priv = Curve25519Map.edwardsSeedToMontgomery(seed)
        val opened = SecretSeal.openWithX25519(blob, x25519Priv)
        assertArrayEquals(secret, opened)
    }

    // The full unlock-key reply: build() seals [ctxLen:4 BE][ctx][secret] for
    // the box STK; the box opens it and strips the (nonce,purpose) context.
    @Test fun sealedSecretResponse_unlockKey_roundTripsAgainstBoxStk() {
        val kp = Ed25519Sign.KeyPair.newKeyPair()
        val stkPub = kp.publicKey
        val seed = kp.privateKey
        val luksKey = ByteArray(64) { ((it * 3 + 1) and 0xff).toByte() }
        val nonceHex = "ab".repeat(32)

        val sealed = SealedSecretResponse.build(luksKey, stkPub, nonceHex, SecretPurpose.UNLOCK_KEY)
        val x25519Priv = Curve25519Map.edwardsSeedToMontgomery(seed)
        val framed = SecretSeal.openWithX25519(sealed, x25519Priv)

        val ctxLen = ((framed[0].toInt() and 0xff) shl 24) or
            ((framed[1].toInt() and 0xff) shl 16) or
            ((framed[2].toInt() and 0xff) shl 8) or
            (framed[3].toInt() and 0xff)
        val ctx = framed.copyOfRange(4, 4 + ctxLen)
        assertArrayEquals(SealedSecretResponse.context(nonceHex, SecretPurpose.UNLOCK_KEY), ctx)
        val recovered = framed.copyOfRange(4 + ctxLen, framed.size)
        assertArrayEquals(luksKey, recovered)
    }

    // Canonical bytes match the spec layout, verify under the signing STK, and
    // reject a foreign key (the "don't trust .com's echo" boundary).
    @Test fun secretRequest_canonicalBytes_verifyAndRejectForeign() {
        val kp = Ed25519Sign.KeyPair.newKeyPair()
        val stkPub = kp.publicKey
        val signer = Ed25519Sign(kp.privateKey)
        val serverDomain = "home.alice.flagship.services"
        val stkPubHex = hex(stkPub)
        val nonceHex = "cd".repeat(32)
        val issuedAt = 1_700_000_000_000L

        val canonical = SecretRequest.canonicalBytes(
            serverDomain, stkPubHex, SecretPurpose.UNLOCK_KEY, nonceHex, issuedAt,
        )
        assertEquals(
            "flagship/secret-request/v1|$serverDomain|$stkPubHex|unlock-key|$nonceHex|$issuedAt",
            String(canonical),
        )

        val sig = signer.sign(canonical)
        assertTrue(
            SecretRequest.verify(sig, stkPub, serverDomain, stkPubHex, SecretPurpose.UNLOCK_KEY, nonceHex, issuedAt),
        )

        val foreign = Ed25519Sign.KeyPair.newKeyPair().publicKey
        assertFalse(
            SecretRequest.verify(sig, foreign, serverDomain, stkPubHex, SecretPurpose.UNLOCK_KEY, nonceHex, issuedAt),
        )
    }

    private fun verifies(pub: ByteArray, sig: ByteArray, msg: ByteArray): Boolean =
        try { Ed25519Verify(pub).verify(sig, msg); true } catch (_: Throwable) { false }

    // A box-sealed lease: the LUKS key sealed for the box STK opens with the
    // box's seed-derived X25519 priv (validates the field math via build), and
    // the canonical bytes + IRK signature match the spec.
    @Test fun autoUnlockLeaseV2_buildRoundTripsAndCanonicalMatches() {
        val box = Ed25519Sign.KeyPair.newKeyPair()
        val irk = Ed25519Sign.KeyPair.newKeyPair()
        val luksKey = ByteArray(64) { ((it * 5 + 2) and 0xff).toByte() }

        val lease = AutoUnlockLeaseV2.build(
            serverDomain = "home.alice.flagship.services",
            stkPub = box.publicKey,
            leaseId = "deadbeefdeadbeef",
            luksKey = luksKey,
            issuedAt = 1L,
            expiresAt = 2L,
        )
        // sealedKey opens with the box STK's seed-mapped X25519 priv → the key.
        val x25519Priv = Curve25519Map.edwardsSeedToMontgomery(box.privateKey)
        assertArrayEquals(luksKey, SecretSeal.openWithX25519(lease.sealedKey, x25519Priv))

        // Canonical layout (maxUses absent ⇒ -1) + IRK signature verifies.
        assertEquals(
            "flagship/auto-unlock-lease/v2|home.alice.flagship.services|${hex(box.publicKey)}|deadbeefdeadbeef|${hex(lease.sealedKey)}|1|2|-1",
            String(lease.canonicalBytes()),
        )
        val sig = lease.sign(Ed25519Sign(irk.privateKey))
        assertTrue(verifies(irk.publicKey, sig, lease.canonicalBytes()))
    }

    @Test fun leaseRevocation_canonicalAndSign() {
        val irk = Ed25519Sign.KeyPair.newKeyPair()
        val rev = LeaseRevocation("home.alice.flagship.services", "abcd1234abcd1234", 7L)
        assertEquals(
            "flagship/auto-unlock-lease-revoke/v1|home.alice.flagship.services|abcd1234abcd1234|7",
            String(rev.canonicalBytes()),
        )
        val sig = rev.sign(Ed25519Sign(irk.privateKey))
        assertTrue(verifies(irk.publicKey, sig, rev.canonicalBytes()))
    }

    // Owner-role boot-auth header: build → base64url-decode → the bound
    // fields match and the signature verifies under the IRK over
    // BootAuth.canonicalBytes (the format apps/boot/src/gate.ts checks).
    @Test fun bootAuth_ownerHeader_decodesAndVerifies() {
        val irk = Ed25519Sign.KeyPair.newKeyPair()
        val pubHex = hex(irk.publicKey)
        val nonce = ByteArray(32) { 0x5a }
        val header = BootAuth.ownerHeader(
            serverDomain = "home.alice.flagship.services",
            method = "PUT",
            path = "/api/boot/lease",
            signer = Ed25519Sign(irk.privateKey),
            pubHex = pubHex,
            issuedAt = 1_700_000_000_000L,
            nonce = nonce,
        )
        assertTrue(header.startsWith("Flagship-Boot-v1 "))
        val jsonBytes = java.util.Base64.getUrlDecoder().decode(header.removePrefix("Flagship-Boot-v1 "))
        val obj = Json.parseToJsonElement(String(jsonBytes)).jsonObject
        assertEquals("owner", obj["role"]!!.jsonPrimitive.content)
        assertEquals("PUT", obj["method"]!!.jsonPrimitive.content)
        assertEquals("/api/boot/lease", obj["path"]!!.jsonPrimitive.content)
        assertEquals("home.alice.flagship.services", obj["serverDomain"]!!.jsonPrimitive.content)
        assertEquals(pubHex, obj["pubKeyHex"]!!.jsonPrimitive.content)
        val nonceHex = obj["nonceHex"]!!.jsonPrimitive.content
        val issuedAt = obj["issuedAt"]!!.jsonPrimitive.long
        val sigHex = obj["signatureHex"]!!.jsonPrimitive.content
        val canon = BootAuth.canonicalBytes(
            "owner", "home.alice.flagship.services", "PUT", "/api/boot/lease", pubHex, nonceHex, issuedAt,
        )
        assertTrue(verifies(irk.publicKey, HexUtil.decode(sigHex)!!, canon))
    }
}
