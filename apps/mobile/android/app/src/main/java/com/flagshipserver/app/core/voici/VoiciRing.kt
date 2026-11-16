// Ringing a caller back (docs/voici-calls.md, owner-approved 2026-11-15): the Kotlin twin of the ring section of
// packages/protocol/src/voiciCallModes.ts (vectors: test-vectors/voici-call-modes/vectors.json `ring`). The owner taps
// Call in a conversation whose caller chose "Call and allow call-back": the app signs a ring with the page's owner
// messages key, the hint sealed to the caller's thread key T, and `.com` pushes it (content-free) to the caller's
// devices over the conversation's ring-back channel. The caller's app opens the hint and dials out to this page; the
// owner's phone answers as for any call. The caller stays a pseudonym to the owner.
//
//   ring  flagship/voici-ring/v1|<pageId>|<conv>|<ringId>|<H(hint bytes)>|<media>|<issuedAt>   Ed25519 by ownerSignPub
//   hint  flagship/hybrid-seal/v1, purpose flagship/voici-ring-hint/v1, context [conv, ringId], to T;
//         canonical JSON {v:1, pageId, username, conv, ringId, media, issuedAt}

package com.flagshipserver.app.core.voici

import com.flagshipserver.app.core.pq.PqHybrid
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

data class VoiciRing(val pageId: String, val conv: String, val ringId: String, val hint: String, val media: String, val issuedAt: Long) {
    fun toJson() = JsonObject(
        linkedMapOf(
            "pageId" to JsonPrimitive(pageId), "conv" to JsonPrimitive(conv), "ringId" to JsonPrimitive(ringId),
            "hint" to JsonPrimitive(hint), "media" to JsonPrimitive(media), "issuedAt" to JsonPrimitive(issuedAt),
        ),
    )
}

object VoiciRings {
    const val TAG_RING = "flagship/voici-ring/v1"
    const val TAG_RING_HINT = "flagship/voici-ring-hint/v1"
    /** A ring lasts as long as an incoming call rings. */
    const val RING_TTL_MS = 45_000L
    private val PAGE_ID = Regex("^[0-9a-f]{32}$")
    private val USERNAME = Regex("^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$")
    private fun hex(s: String, bytes: Int) = s.length == bytes * 2 && s.all { it in '0'..'9' || it in 'a'..'f' }

    /** The hint for the caller's thread key [threadPub] (X-Wing); [eseed] 64 random bytes. */
    fun sealHint(threadPub: ByteArray, pageId: String, username: String, conv: String, ringId: String, media: String, issuedAt: Long, eseed: ByteArray): ByteArray {
        require(PAGE_ID.matches(pageId) && USERNAME.matches(username) && hex(conv, 32) && hex(ringId, 16) && media in VoiciCalls.MEDIA_VALUES && issuedAt >= 0) { TAG_RING_HINT }
        val plain = WebEnvelopes.canonicalJsonBytes(
            mapOf("v" to 1, "pageId" to pageId, "username" to username, "conv" to conv, "ringId" to ringId, "media" to media, "issuedAt" to issuedAt),
        )
        return PqHybrid.hybridSealWithRandomness(
            threadPub,
            PqHybrid.HybridSealOptions(purpose = TAG_RING_HINT, senderKeyId = ByteArray(32), issuedAt = issuedAt),
            listOf(VoiciJs.utf8(conv), VoiciJs.utf8(ringId)),
            plain,
            eseed,
        )
    }

    fun canonicalRing(r: VoiciRing): ByteArray {
        val hintBytes = WebEnvelopes.b64Decode(r.hint)
        require(PAGE_ID.matches(r.pageId) && hex(r.conv, 32) && hex(r.ringId, 16) && hintBytes != null && r.media in VoiciCalls.MEDIA_VALUES && r.issuedAt >= 0) { TAG_RING }
        return VoiciJs.utf8(listOf(TAG_RING, r.pageId, r.conv, r.ringId, WebEnvelopes.sha256Hex(hintBytes!!), r.media, r.issuedAt.toString()).joinToString("|"))
    }

    fun signRing(r: VoiciRing, ownerSignSeed: ByteArray): String = VoiciJs.hex(VoiciJs.edSign(ownerSignSeed, canonicalRing(r)))

    fun verifyRing(r: VoiciRing, signature: String, ownerSignPub: String): Boolean =
        runCatching { WebEnvelopes.ed25519VerifyHex(signature, canonicalRing(r), ownerSignPub) }.getOrDefault(false)
}
