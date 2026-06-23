package com.flagshipserver.app.core

import com.google.crypto.tink.subtle.Ed25519Sign
import com.google.crypto.tink.subtle.Ed25519Verify
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * Pins the Kotlin Phase-3 cloud-gossip / leadership primitives to the EXACT
 * cross-platform vectors. The TS half lives in
 * `packages/protocol/tests/cloudGossipVectors.test.ts`; the Swift half in
 * `CloudGossipCanonicalTests.swift`. Any drift in the CGK HKDF info, the
 * canonical tag/separator/field-order/lowercasing/number-stringification, the
 * HMAC, or the clout comparator breaks gossip authentication + leadership.
 */
class CloudGossipVectorTest {
    private fun hex(b: ByteArray) = HexUtil.encode(b)

    // ── 1. CGK ──────────────────────────────────────────────────────────
    @Test
    fun cgkPinnedVector() {
        val seed = ByteArray(32) { 0x07 }
        assertEquals(
            "1d8e3bc393a91de22edec0b862a0539856bdc73b42ab60a26d7d51fbb091badd",
            hex(CloudGossip.deriveCGK(seed)),
        )
    }

    // ── 2. set-leader ───────────────────────────────────────────────────
    private val voteCanonical =
        "flagship/set-leader/v1|alice|${"aa".repeat(32)}|1700|deadbeef"

    @Test
    fun setLeaderCanonicalBytes() {
        assertEquals(
            voteCanonical,
            String(
                CloudGossip.setLeaderCanonicalBytes("alice", "aa".repeat(32), 1700L, "deadbeef"),
                Charsets.UTF_8,
            ),
        )
    }

    @Test
    fun setLeaderLowercases() {
        assertEquals(
            voteCanonical,
            String(
                CloudGossip.setLeaderCanonicalBytes("Alice", "AA".repeat(32), 1700L, "DEADBEEF"),
                Charsets.UTF_8,
            ),
        )
    }

    @Test
    fun setLeaderNoneClears() {
        assertEquals(
            "flagship/set-leader/v1|alice|none|1700|deadbeef",
            String(
                CloudGossip.setLeaderCanonicalBytes("alice", "none", 1700L, "deadbeef"),
                Charsets.UTF_8,
            ),
        )
    }

    @Test
    fun setLeaderSignVerifyRoundTrip() {
        val kp = Ed25519Sign.KeyPair.newKeyPair()
        val signer = Ed25519Sign(kp.privateKey)
        val verifier = Ed25519Verify(kp.publicKey)
        val bytes = CloudGossip.setLeaderCanonicalBytes("alice", "aa".repeat(32), 1700L, "deadbeef")
        assertEquals(voteCanonical, String(bytes, Charsets.UTF_8))
        val sig = signer.sign(bytes)
        verifier.verify(sig, bytes) // throws on mismatch — reaching here = ok
        // A different preferred-server ⇒ different bytes ⇒ the sig must not verify.
        val other = CloudGossip.setLeaderCanonicalBytes("alice", "bb".repeat(32), 1700L, "deadbeef")
        try {
            verifier.verify(sig, other)
            fail("set-leader sig must not verify for a different preferred server")
        } catch (_: Throwable) {
            // expected
        }
    }

    // ── 3. gossip ───────────────────────────────────────────────────────
    private fun cgk() = CloudGossip.deriveCGK(ByteArray(32) { 0x07 })

    private val gossipCanonical =
        "flagship/gossip/v1|alice|${"bb".repeat(32)}|${"cc".repeat(32)}|1000|none|0|chat,notes,photos|live|1700"

    private fun gossipBytes() = CloudGossip.gossipCanonicalBytes(
        user = "alice",
        name = "bb".repeat(32),
        birthAuthHex = "cc".repeat(32),
        birthDate = 1000L,
        voteStkHex = "none",
        voteDate = 0L,
        services = listOf("photos", "notes", "chat"), // unsorted on purpose
        liveness = "live",
        issuedAt = 1700L,
    )

    @Test
    fun gossipCanonicalSortsServices() {
        assertEquals(gossipCanonical, String(gossipBytes(), Charsets.UTF_8))
    }

    @Test
    fun gossipHmacPinned() {
        assertEquals(
            "2454b8b48b4e560e4613e32cb46c0df1161dfb934dd0c3f550a7507ff4a1647e",
            CloudGossip.macGossip(gossipBytes(), cgk()),
        )
    }

    @Test
    fun gossipVerifyMac() {
        val bytes = gossipBytes()
        assertTrue(CloudGossip.verifyGossipMac(bytes, CloudGossip.macGossip(bytes, cgk()), cgk()))
        assertFalse(CloudGossip.verifyGossipMac(bytes, "00".repeat(32), cgk()))
        assertFalse(CloudGossip.verifyGossipMac(bytes, "not-hex", cgk()))
        val wrong = CloudGossip.deriveCGK(ByteArray(32) { 0x09 })
        assertFalse(CloudGossip.verifyGossipMac(bytes, CloudGossip.macGossip(bytes, cgk()), wrong))
    }

    @Test
    fun gossipSealOpenRoundTrip() {
        val pt = "hello-gossip".toByteArray(Charsets.UTF_8)
        val blob = CloudGossip.sealGossip(pt, cgk())
        assertEquals(12 + pt.size + 16, blob.size) // nonce + ct + GCM tag
        assertEquals("hello-gossip", String(CloudGossip.openGossip(blob, cgk()), Charsets.UTF_8))
        val wrong = CloudGossip.deriveCGK(ByteArray(32) { 0x09 })
        try {
            CloudGossip.openGossip(blob, wrong)
            fail("openGossip must throw on a wrong CGK")
        } catch (_: Throwable) {
            // expected (AEADBadTagException)
        }
    }

    // ── 4. clout ────────────────────────────────────────────────────────
    private fun mk(
        id: String, domain: String, birth: Long, vote: Long?, liveness: String, services: List<String>,
    ) = CloudGossip.CloutMember(id, domain, birth, vote, liveness, services)

    @Test
    fun cloutScenarioAVoteWins() {
        val m = listOf(
            mk("p1", "home.alice.flagship.services", 1000L, null, "live", listOf("photos")),
            mk("p2", "work.alice.flagship.services", 2000L, 5000L, "live", listOf("photos")),
        )
        assertEquals("p2", CloudGossip.electLeadForService(m, "photos")?.id)
    }

    @Test
    fun cloutScenarioBOldestBirthWins() {
        val m = listOf(
            mk("p1", "home.alice.flagship.services", 2000L, null, "live", listOf("notes")),
            mk("p2", "work.alice.flagship.services", 1000L, null, "live", listOf("notes")),
        )
        assertEquals("p2", CloudGossip.electLeadForService(m, "notes")?.id)
    }

    @Test
    fun cloutScenarioCLowestDomainWins() {
        val m = listOf(
            mk("pz", "zeta.alice.flagship.services", 1000L, 3000L, "live", listOf("chat")),
            mk("pa", "alpha.alice.flagship.services", 1000L, 3000L, "live", listOf("chat")),
        )
        assertEquals("pa", CloudGossip.electLeadForService(m, "chat")?.id)
    }

    @Test
    fun cloutOnlyLiveRunnersEligible() {
        val dead = listOf(
            mk("p1", "home.alice.flagship.services", 1000L, 9000L, "unreachable", listOf("mail")),
            mk("p2", "work.alice.flagship.services", 1000L, null, "never", listOf("mail")),
        )
        assertNull(CloudGossip.electLeadForService(dead, "mail"))
        val mixed = listOf(
            mk("p1", "home.alice.flagship.services", 1000L, null, "live", listOf("photos")),
            mk("p2", "work.alice.flagship.services", 2000L, null, "live", listOf("notes")),
        )
        assertEquals("p2", CloudGossip.electLeadForService(mixed, "notes")?.id)
    }

    @Test
    fun cloutLessIsTotalOrder() {
        val voted = mk("v", "z.a", 5000L, 9000L, "live", emptyList())
        val old = mk("o", "a.a", 1000L, null, "live", emptyList())
        assertTrue(CloudGossip.cloutLess(voted, old))
        assertFalse(CloudGossip.cloutLess(old, voted))
    }

    // ── 5. birth date ───────────────────────────────────────────────────
    @Test
    fun birthDateFromAuthCode() {
        assertEquals(1234567L, CloudGossip.birthDateFromAuthCode(1234567L))
    }
}
