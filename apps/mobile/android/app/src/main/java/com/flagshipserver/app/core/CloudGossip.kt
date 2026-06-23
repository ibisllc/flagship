// Kotlin mirror of the Phase-3 cloud-gossip / per-service leadership foundation
// in `packages/protocol/src/cloudGossip.ts` and the Swift mirror
// (FlagshipCore/CloudGossip.swift). PURE crypto / canonical-bytes plumbing —
// MUST stay byte-identical to the TS implementation; the pinned cross-platform
// vectors in `CloudGossipVectorTest.kt` lock every byte/hex in.
//
//   1. CGK   — HKDF-SHA256(ikm = umkSeed, salt = empty,
//              info = "flagship.cloud-gossip.v1", 32). One key PER CLOUD (no
//              serverId) — derived the SAME way as ServerKeys.deriveSwk, only
//              the info differs.
//   2. set-leader — owner-IRK-signed preferred-server vote, mirroring the
//              server-decommission envelope conventions.
//   3. gossip — canonical bytes + an HMAC-SHA256 tag keyed by the CGK, plus an
//              AES-256-GCM nonce-prefixed seal/open transport keyed by the CGK.
//   4. clout  — the pure comparator + per-service elector.
//   5. birthDateFromAuthCode — AuthCode.issuedAt is the immutable birth date.

package com.flagshipserver.app.core

import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

object CloudGossip {
    private val rng = SecureRandom()

    // ── 1. CGK ──────────────────────────────────────────────────────────
    private const val INFO_CGK = "flagship.cloud-gossip.v1"

    /** CGK = HKDF-SHA256(ikm = umkSeed, salt = empty,
     *  info = "flagship.cloud-gossip.v1", 32) — per-cloud (no serverId).
     *  Mirrors ServerKeys.deriveSwk's HKDF construction (empty salt). */
    fun deriveCGK(umkSeed: ByteArray): ByteArray {
        require(umkSeed.size == 32) { "UMK seed must be 32 bytes" }
        return hkdfSha256(umkSeed, INFO_CGK.toByteArray(Charsets.UTF_8))
    }

    // ── 2. set-leader vote ──────────────────────────────────────────────
    const val SET_LEADER_TAG = "flagship/set-leader/v1"
    const val SET_LEADER_NONE = "none"

    /** Owner-IRK-signed preferred-server vote canonical bytes (byte-identical
     *  to TS + Swift):
     *   flagship/set-leader/v1|<user>|<preferredStkPubHex>|<issuedAt>|<nonce>
     *  user, preferredStkPubHex, nonce are lowercased; issuedAt is decimal.
     *  preferredStkPubHex == "none" clears the vote. */
    fun setLeaderCanonicalBytes(
        user: String,
        preferredStkPubHex: String,
        issuedAt: Long,
        nonce: String,
    ): ByteArray =
        listOf(
            SET_LEADER_TAG,
            user.lowercase(),
            preferredStkPubHex.lowercase(),
            issuedAt.toString(),
            nonce.lowercase(),
        ).joinToString("|").toByteArray(Charsets.UTF_8)

    // ── 3. gossip announcement ──────────────────────────────────────────
    const val GOSSIP_TAG = "flagship/gossip/v1"
    const val GOSSIP_VOTE_NONE = "none"
    const val GOSSIP_VOTE_DATE_NONE = 0L

    /** Canonical gossip bytes (byte-identical to TS + Swift):
     *   flagship/gossip/v1|<user>|<name>|<birthAuthHex>|<birthDate>|<voteStkHex>|<voteDate>|<services>|<liveness>|<issuedAt>
     *  services = the slugs SORTED + ","-joined (deterministic). name,
     *  birthAuthHex, voteStkHex lowercased; the dates are decimal. */
    fun gossipCanonicalBytes(
        user: String,
        name: String,
        birthAuthHex: String,
        birthDate: Long,
        voteStkHex: String,
        voteDate: Long,
        services: List<String>,
        liveness: String,
        issuedAt: Long,
    ): ByteArray {
        val svc = services.sorted().joinToString(",")
        return listOf(
            GOSSIP_TAG,
            user.lowercase(),
            name.lowercase(),
            birthAuthHex.lowercase(),
            birthDate.toString(),
            voteStkHex.lowercase(),
            voteDate.toString(),
            svc,
            liveness,
            issuedAt.toString(),
        ).joinToString("|").toByteArray(Charsets.UTF_8)
    }

    /** HMAC-SHA256 of the canonical gossip bytes under the CGK, lowercased hex. */
    fun macGossip(canonical: ByteArray, cgk: ByteArray): String {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(cgk, "HmacSHA256"))
        return HexUtil.encode(mac.doFinal(canonical))
    }

    /** Constant-time check that `mac` (lowercased hex) is the CGK-HMAC of the
     *  canonical bytes. Never throws. */
    fun verifyGossipMac(canonical: ByteArray, mac: String, cgk: ByteArray): Boolean {
        return try {
            val expected = macGossip(canonical, cgk)
            val got = mac.lowercase()
            if (expected.length != got.length) return false
            var diff = 0
            for (i in expected.indices) diff = diff or (expected[i].code xor got[i].code)
            diff == 0
        } catch (_: Throwable) {
            false
        }
    }

    /** AES-256-GCM transport seal keyed by the CGK. Wire layout (nonce-prefixed):
     *   [nonce: 12 B][ciphertext + GCM tag: var] */
    fun sealGossip(plaintext: ByteArray, cgk: ByteArray): ByteArray {
        val nonce = ByteArray(12).also(rng::nextBytes)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(cgk, "AES"), GCMParameterSpec(128, nonce))
        val ctWithTag = cipher.doFinal(plaintext) // ciphertext ‖ 16-byte GCM tag
        val out = ByteArray(nonce.size + ctWithTag.size)
        System.arraycopy(nonce, 0, out, 0, nonce.size)
        System.arraycopy(ctWithTag, 0, out, nonce.size, ctWithTag.size)
        return out
    }

    /** Open a sealGossip blob with the CGK. Throws AEADBadTagException on a
     *  wrong key / corrupted tag. */
    fun openGossip(blob: ByteArray, cgk: ByteArray): ByteArray {
        require(blob.size >= 12 + 16) { "sealed gossip blob too short" }
        val nonce = blob.copyOfRange(0, 12)
        val ctWithTag = blob.copyOfRange(12, blob.size)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(cgk, "AES"), GCMParameterSpec(128, nonce))
        return cipher.doFinal(ctWithTag)
    }

    // ── 4. clout ranking ────────────────────────────────────────────────
    data class CloutMember(
        val id: String,
        val domain: String,
        val birthDate: Long,
        /** The owner's set-leader vote issuedAt (ms), or null when not voted. */
        val voteIssuedAt: Long?,
        /** "live" | "unreachable" | "never". */
        val liveness: String,
        val services: List<String>,
    )

    /** The raw clout comparator. Returns true when `a` STRICTLY outranks `b`
     *  (i.e. `a` should lead over `b`):
     *    1. higher voteIssuedAt wins (null treated as the lowest);
     *    2. tie → lower birthDate (oldest birth certificate) wins;
     *    3. tie → lower domain lexicographically. */
    fun cloutLess(a: CloutMember, b: CloutMember): Boolean {
        val av = a.voteIssuedAt
        val bv = b.voteIssuedAt
        if (av != bv) {
            return when {
                av != null && bv != null -> av > bv
                av != null && bv == null -> true   // a voted, b not → a leads
                else -> false                       // a not voted, b voted → b leads
            }
        }
        if (a.birthDate != b.birthDate) return a.birthDate < b.birthDate
        return a.domain < b.domain
    }

    /** Elect the leader for one service: among the `live` members that run
     *  serviceSlug, the highest-clout one. null when no live runner exists. */
    fun electLeadForService(members: List<CloutMember>, serviceSlug: String): CloutMember? {
        val eligible = members.filter { it.liveness == "live" && it.services.contains(serviceSlug) }
        if (eligible.isEmpty()) return null
        var lead = eligible[0]
        for (i in 1 until eligible.size) {
            if (cloutLess(eligible[i], lead)) lead = eligible[i]
        }
        return lead
    }

    // ── 5. birth date ───────────────────────────────────────────────────
    /** The immutable birth date: AuthCode.issuedAt (ms). The create-time,
     *  owner-IRK-signed auth code is signed once, so issuedAt is a stable,
     *  unforgeable per-pod birth instant. */
    fun birthDateFromAuthCode(issuedAt: Long): Long = issuedAt

    // ── shared HKDF (mirrors ServerKeys.hkdfSha256) ─────────────────────
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
