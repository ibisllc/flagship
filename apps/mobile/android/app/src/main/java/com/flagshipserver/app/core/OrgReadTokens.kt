// Org read tokens (docs/account-read-token.md "Org routes"; packages/protocol orgReadToken.ts). `.com` serves an
// org's reads only to a bearer of one. This phone mints it as `seat:<seatId>` with a key at hand (an admin seat's own
// key while the session is open, else the seat member key from the open session's UMK), keeps it in memory until 10
// minutes before `.com`'s expiry, and mints again once after a 401. Minting never prompts. The plan and the invite
// offer need no token.

package com.flagshipserver.app.core

import com.flagshipserver.app.core.pq.OrgAuthority
import com.flagshipserver.app.core.pq.PqHex
import com.google.crypto.tink.subtle.Ed25519Sign
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.security.SecureRandom

/** A key this phone can mint an org read token with: the seat it signs for and an Ed25519 signer. */
class OrgReadTokenCredential(val seatId: String, val pubHex: String, val sign: (ByteArray) -> ByteArray) {
    companion object {
        /** An Ed25519 seed (the seat member key's, or the Ed25519 half of a seat admin key). */
        fun ofSeed(seatId: String, edSeed: ByteArray): OrgReadTokenCredential {
            val kp = Ed25519Sign.KeyPair.newKeyPairFromSeed(edSeed)
            val signer = Ed25519Sign(kp.privateKey)
            return OrgReadTokenCredential(seatId, PqHex.encode(kp.publicKey)) { m -> signer.sign(m) }
        }

        /** The seat member key, derived from the UMK for this org only. */
        fun member(umk: ByteArray, orgId: String, seatId: String): OrgReadTokenCredential {
            val (ed, ml) = OrgAuthority.memberSeeds(umk, orgId)
            try {
                return ofSeed(seatId, ed)
            } finally { ed.fill(0); ml.fill(0) }
        }
    }
}

object OrgReadToken {
    const val TAG = "flagship/org-read-token-request/v1"

    fun path(orgId: String): String = "/api/orgs/${orgId.lowercase()}/read-token"

    fun seatSubject(seatId: String): String = "seat:${seatId.lowercase()}"

    /** `TAG|orgId|subject|pubHex|issuedAt|nonceHex`. */
    fun canonicalRequest(orgId: String, subject: String, pubHex: String, issuedAt: Long, nonceHex: String): ByteArray =
        listOf(TAG, orgId, subject, pubHex, issuedAt.toString(), nonceHex).joinToString("|").toByteArray(Charsets.UTF_8)

    /** The body POSTed to [path]: `{request, signature}`. */
    fun requestBody(orgId: String, credential: OrgReadTokenCredential, issuedAt: Long, nonceHex: String): JsonObject {
        val subject = seatSubject(credential.seatId)
        val sig = credential.sign(canonicalRequest(orgId, subject, credential.pubHex, issuedAt, nonceHex))
        return buildJsonObject {
            put("request", buildJsonObject {
                put("orgId", orgId); put("subject", subject); put("pubHex", credential.pubHex); put("issuedAt", issuedAt); put("nonceHex", nonceHex)
            })
            put("signature", PqHex.encode(sig))
        }
    }

    private val ORG_GET = Regex("^/api/orgs/([0-9a-f]{32})/(.+)$")

    /** The org a GET of [path] reads with a token, or null (the public plan, the invite offer, anything else). */
    fun gatedOrg(path: String): String? {
        val m = ORG_GET.matchEntire(path.substringBefore('?')) ?: return null
        val sub = m.groupValues[2]
        if (sub == "plan" || sub == "read-token" || sub.startsWith("invites/")) return null
        return m.groupValues[1]
    }
}

class OrgReadTokens(
    /** The keys that can mint for an org without a prompt, best first. */
    @Volatile var credentials: suspend (orgId: String) -> List<OrgReadTokenCredential> = { emptyList() },
    private val rng: SecureRandom = SecureRandom(),
) {
    private val mutex = Mutex()
    private val cache = HashMap<String, Pair<String, Long>>()

    fun forgetAll() { synchronized(cache) { cache.clear() } }

    /** A token for [orgId], from memory or a fresh mint through [post]; null when no key at hand mints one. */
    suspend fun token(orgId: String, fresh: Boolean, now: Long, post: suspend (path: String, body: JsonObject) -> Pair<Int, JsonObject>): String? = mutex.withLock {
        val key = orgId.lowercase()
        synchronized(cache) {
            if (fresh) cache.remove(key)
            cache[key]?.let { (t, exp) -> if (now < exp - REFRESH_MARGIN_MS) return@withLock t }
        }
        for (c in credentials(key)) {
            val nonce = ByteArray(16).also(rng::nextBytes)
            val (status, json) = runCatching { post(OrgReadToken.path(key), OrgReadToken.requestBody(key, c, now, PqHex.encode(nonce))) }.getOrNull() ?: continue
            if (status != 200) continue
            val token = (json["token"] as? JsonPrimitive)?.takeIf { it.isString }?.content ?: continue
            val exp = (json["expiresAt"] as? JsonPrimitive)?.content?.toLongOrNull() ?: continue
            synchronized(cache) { cache[key] = token to exp }
            return@withLock token
        }
        null
    }

    companion object {
        private const val REFRESH_MARGIN_MS = 10 * 60_000L
        val shared = OrgReadTokens()
    }
}
