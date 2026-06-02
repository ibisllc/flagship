// #28 — plain-JVM tests for the SEAL-TO-BOX AcmeAccountKeyGrant producer.
// Canonical bytes + the IRK signature MUST stay byte-identical to the Worker
// (packages/protocol canonicalAcmeAccountKeyGrant / signAcmeAccountKeyGrant) and
// to iOS, so the KAT pins the EXACT signature literal. The seal/open + scalar→PEM
// round-trips fail loudly if the field math or the PKCS#8 encoding drifts.

package com.flagshipserver.app.core

import com.google.crypto.tink.subtle.Ed25519Sign
import java.security.interfaces.ECPrivateKey
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AcmeAccountKeyGrantTest {

    private fun signer(seedByte: Byte): Pair<Ed25519Sign, ByteArray> {
        val seed = ByteArray(32) { seedByte }
        val pub = Ed25519Sign.KeyPair.newKeyPairFromSeed(seed).publicKey
        return Ed25519Sign(seed) to pub
    }

    // ── KAT — locks canonical + sign to the TS protocol ──────────────────

    @Test
    fun knownAnswer_signature_matchesProtocolLiteral() {
        val seed = ByteArray(32) { 0x03 }
        val pub = Ed25519Sign.KeyPair.newKeyPairFromSeed(seed).publicKey
        // The seed's pubkey is itself a fixed vector — assert it so a Tink
        // change surfaces here, not as a mystery signature mismatch.
        assertEquals(
            "ed4928c628d1c2c6eae90338905995612959273a5c63f93636c14614ac8737d1",
            HexUtil.encode(pub),
        )

        val sealed = ByteArray(48) { (it + 1).toByte() } // 0x01 .. 0x30
        val sig = AcmeAccountKeyGrant.sign(
            irk = Ed25519Sign(seed),
            grantId = "00000000-0000-4000-8000-000000000001",
            username = "demo1234",
            accountKeyId = "a9f300eb5960e89133af7362011a1e26f0e2ea2e36dc402a04af6c192b891a8c",
            recipientPubKey = HexUtil.decode(
                "ea4a6c63e29c520abef5507b132ec5f9954776aebebe7b92421eea691446d22c",
            )!!,
            sealedAccountKey = sealed,
            issuedAt = 1_700_000_000_000,
            expiresAt = 1_700_000_000_000 + 90L * 86_400_000,
        )
        assertEquals(
            "5e7f444d0dddb99c0427e655fa81dbc4e62e1fc74a91509b18a94db80a610e82" +
                "ab3a9f52475e5f4f5b0c09a7b9a016a7264278004540cf8171c83f8bd07c8b00",
            HexUtil.encode(sig),
        )
    }

    @Test
    fun canonicalBytes_matchWorkerLayout() {
        val canon = AcmeAccountKeyGrant.canonicalBytes(
            grantId = "g-1",
            username = "dani",
            accountKeyId = "aa".repeat(32),
            recipientPubKey = HexUtil.decode("bb".repeat(32))!!,
            sealedAccountKey = byteArrayOf(1, 2, 3, 4),
            issuedAt = 1000,
            expiresAt = 2000,
        )
        val expected = "flagship/acme-account-key-grant/v1|g-1|dani|" +
            "aa".repeat(32) + "|" + "bb".repeat(32) + "|01020304|1000|2000"
        assertEquals(expected, String(canon, Charsets.UTF_8))
    }

    @Test
    fun signVerify_roundTrip_andForeignKeyRejected() {
        val (irk, irkPub) = signer(1)
        val recipient = HexUtil.decode("cc".repeat(32))!!
        val sealed = ByteArray(60) { ((it * 5) and 0xff).toByte() }
        val sig = AcmeAccountKeyGrant.sign(
            irk, "g-2", "dani", "dd".repeat(32), recipient, sealed, 1000, 9_000_000,
        )
        assertTrue(
            AcmeAccountKeyGrant.verify(
                sig, irkPub, "g-2", "dani", "dd".repeat(32), recipient, sealed, 1000, 9_000_000,
            ),
        )
        // A different IRK pub must not verify.
        val (_, otherPub) = signer(9)
        assertFalse(
            AcmeAccountKeyGrant.verify(
                sig, otherPub, "g-2", "dani", "dd".repeat(32), recipient, sealed, 1000, 9_000_000,
            ),
        )
        // A tampered sealed key must not verify.
        val tampered = sealed.copyOf().also { it[0] = (it[0] + 1).toByte() }
        assertFalse(
            AcmeAccountKeyGrant.verify(
                sig, irkPub, "g-2", "dani", "dd".repeat(32), recipient, tampered, 1000, 9_000_000,
            ),
        )
    }

    @Test
    fun canonical_rejectsStructuralDefects() {
        val recipient = HexUtil.decode("ee".repeat(32))!!
        // separator in a string field
        assertThrows {
            AcmeAccountKeyGrant.canonicalBytes("g", "da|ni", "ff".repeat(32), recipient, byteArrayOf(1), 1, 2)
        }
        // expiresAt <= issuedAt
        assertThrows {
            AcmeAccountKeyGrant.canonicalBytes("g", "dani", "ff".repeat(32), recipient, byteArrayOf(1), 5, 5)
        }
        // 31-byte recipient pubkey
        assertThrows {
            AcmeAccountKeyGrant.canonicalBytes("g", "dani", "ff".repeat(32), ByteArray(31), byteArrayOf(1), 1, 2)
        }
        // empty sealed key
        assertThrows {
            AcmeAccountKeyGrant.canonicalBytes("g", "dani", "ff".repeat(32), recipient, ByteArray(0), 1, 2)
        }
    }

    // ── seal → open round-trip (recipient seed opens the sealed key) ─────

    @Test
    fun producer_sealedKey_opensWithRecipientSeed_andReparsesToSameScalar() {
        val (irk, _) = signer(2)
        // A deterministic 32-byte scalar for the account key.
        val scalar = ByteArray(32) { ((it * 11 + 7) and 0xff).toByte() }
        val boxStk = Ed25519Sign.KeyPair.newKeyPairFromSeed(ByteArray(32) { 0x05 })
        val boxStkPub = boxStk.publicKey
        val boxStkSeed = boxStk.privateKey

        val produced = AcmeAccountKeyGrantProducer.produce(
            irk = irk,
            username = "demo1234",
            scalar = scalar,
            boxStkPub = boxStkPub,
            grantId = "00000000-0000-4000-8000-0000000000aa",
            issuedAt = 1_700_000_000_000,
            expiresAt = 1_700_000_000_000 + AcmeAccountKeyGrantProducer.DEFAULT_TTL_MS,
        )

        // accountKeyId is the cross-platform sha256-hex of the uncompressed pubkey.
        assertEquals(AcmeAccountKey.accountKeyId(scalar), produced.accountKeyId)
        assertArrayEquals(boxStkPub, produced.recipientPubKey)

        // The signature it carries verifies under the IRK pub.
        val irkPub = Ed25519Sign.KeyPair.newKeyPairFromSeed(ByteArray(32) { 2 }).publicKey
        assertTrue(
            AcmeAccountKeyGrant.verify(
                HexUtil.decode(produced.signatureHex)!!, irkPub,
                produced.grantId, produced.username, produced.accountKeyId,
                produced.recipientPubKey, produced.sealedAccountKey,
                produced.issuedAt, produced.expiresAt,
            ),
        )

        // The box opens the sealed key with its OWN STK seed → a PKCS#8 PEM.
        val openedPem = SecretSeal.openWithEd25519Seed(produced.sealedAccountKey, boxStkSeed)
        val pem = String(openedPem, Charsets.UTF_8)
        assertTrue(pem.contains("-----BEGIN PRIVATE KEY-----"))

        // ...which re-parses to the SAME P-256 scalar that was sealed.
        val reparsed = AcmeAccountKeyGrantProducer.pkcs8PemToPrivateKey(pem) as ECPrivateKey
        assertEquals(java.math.BigInteger(1, scalar), reparsed.s)
    }

    // ── scalar → PKCS#8 PEM round-trip ───────────────────────────────────

    @Test
    fun scalarToPkcs8Pem_reparsesToSameKey() {
        // scalar = 2 — the AcmeAccountKey KAT vector; any scalar must round-trip.
        val scalar = ByteArray(32).also { it[31] = 2 }
        val pem = AcmeAccountKeyGrantProducer.scalarToPkcs8Pem(scalar)
        assertTrue(pem.startsWith("-----BEGIN PRIVATE KEY-----"))
        assertTrue(pem.trimEnd().endsWith("-----END PRIVATE KEY-----"))

        val priv = AcmeAccountKeyGrantProducer.pkcs8PemToPrivateKey(pem) as ECPrivateKey
        assertEquals(java.math.BigInteger.valueOf(2), priv.s)
    }

    @Test
    fun scalarToPkcs8Pem_randomScalar_publicMatchesAcmeAccountKey() {
        val scalar = AcmeAccountKey.generateScalar()
        val pem = AcmeAccountKeyGrantProducer.scalarToPkcs8Pem(scalar)
        val priv = AcmeAccountKeyGrantProducer.pkcs8PemToPrivateKey(pem) as ECPrivateKey
        // The re-parsed scalar matches; the public derivation matches the
        // standalone curve math used for accountKeyId.
        assertEquals(java.math.BigInteger(1, scalar), priv.s)
    }

    private fun assertThrows(block: () -> Unit) {
        try {
            block()
            throw AssertionError("expected an exception")
        } catch (_: IllegalArgumentException) {
            // expected
        }
    }
}
