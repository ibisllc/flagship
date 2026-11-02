// Messages key attestations (docs/voici-and-messages.md §6.3, §9.3): .com's CA vouches that "a Flagship account in
// good standing" holds a per-page pseudonym key P, naming no account. Kotlin twin of
// packages/protocol/src/messagesAttestation.ts, for what the app computes: the request it signs and the check of an
// answer. The abuse tag is opaque bytes here (only its SHA-256 is checked); sealing and opening it, and the abuse
// key list, live on .com and the offline review tool only.
//
//   request  flagship/messages-key-attestation-request/v1|<username>|<Ppub>|<renewOfHash or "">|<deviceCheckRef>|<issuedAt>
//            Ed25519 by an account device key; deviceCheckRef "ios", "android" or "none".
//   answer   flagship/messages-key-attestation/v1|<Ppub>|<abuseEpoch>|<H(abuseTag)>|<issuedAt>|<expiresAt>
//            Ed25519 by .com's CA key; envelope {kind:"MessagesKeyAttestation", version:1, pseudonymPub, abuseEpoch,
//            abuseTagHash, abuseTag (base64), issuedAt, expiresAt, signedBy, signature}.
// renewOfHash = SHA-256 hex of canonicalJson(previous attestation envelope).
//
// Public API (object MessagesAttestations): TAG_MESSAGES_KEY_ATTESTATION, TAG_MESSAGES_KEY_ATTESTATION_REQUEST,
// MESSAGES_ATTESTATION_TTL_MS, MESSAGES_ATTESTATION_RENEW_GRACE_MS, MESSAGES_ATTESTATION_REQUEST_SKEW_MS,
// DEVICE_CHECK_REFS, canonicalMessagesKeyAttestationRequest, signMessagesKeyAttestationRequest,
// verifyMessagesKeyAttestationRequest, canonicalMessagesKeyAttestation, signMessagesKeyAttestation,
// parseMessagesKeyAttestation, messagesAttestationHash, checkMessagesKeyAttestation (codes malformed, unknown-ca,
// bad-signature, bad-abuse-tag, wrong-key, not-yet-valid, expired). Data classes MessagesKeyAttestationRequest,
// MessagesKeyAttestation (+ toJson).

package com.flagshipserver.app.core.voici

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

data class MessagesKeyAttestationRequest(
    val username: String,
    val pseudonymPub: String,
    /** "" for a first attestation. */
    val renewOfHash: String,
    val deviceCheckRef: String,
    val issuedAt: Long,
)

data class MessagesKeyAttestation(
    val pseudonymPub: String,
    val abuseEpoch: Long,
    val abuseTagHash: String,
    /** Standard base64 of the sealed abuse tag. */
    val abuseTag: String,
    val issuedAt: Long,
    val expiresAt: Long,
    val signedBy: String,
    val signature: String,
) {
    fun toJson(): JsonObject = JsonObject(
        linkedMapOf(
            "kind" to JsonPrimitive("MessagesKeyAttestation"),
            "version" to JsonPrimitive(1),
            "pseudonymPub" to JsonPrimitive(pseudonymPub),
            "abuseEpoch" to JsonPrimitive(abuseEpoch),
            "abuseTagHash" to JsonPrimitive(abuseTagHash),
            "abuseTag" to JsonPrimitive(abuseTag),
            "issuedAt" to JsonPrimitive(issuedAt),
            "expiresAt" to JsonPrimitive(expiresAt),
            "signedBy" to JsonPrimitive(signedBy),
            "signature" to JsonPrimitive(signature),
        ),
    )
}

object MessagesAttestations {
    const val TAG_MESSAGES_KEY_ATTESTATION = "flagship/messages-key-attestation/v1"
    const val TAG_MESSAGES_KEY_ATTESTATION_REQUEST = "flagship/messages-key-attestation-request/v1"
    const val MESSAGES_ATTESTATION_TTL_MS = 30L * 86_400_000
    const val MESSAGES_ATTESTATION_RENEW_GRACE_MS = 7L * 86_400_000
    const val MESSAGES_ATTESTATION_REQUEST_SKEW_MS = 10L * 60_000
    private const val ABUSE_TAG_MAX_BYTES = 4096
    val DEVICE_CHECK_REFS: List<String> = listOf("ios", "android", "none")

    private val USERNAME = Regex("^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$")
    private fun isTime(n: Long) = n in 0..VoiciJs.MAX_SAFE
    private val ATTESTATION_KEYS = listOf("abuseEpoch", "abuseTag", "abuseTagHash", "expiresAt", "issuedAt", "kind", "pseudonymPub", "signature", "signedBy", "version")

    fun canonicalMessagesKeyAttestationRequest(r: MessagesKeyAttestationRequest): ByteArray {
        fun bad(f: String): Nothing = throw IllegalArgumentException("$TAG_MESSAGES_KEY_ATTESTATION_REQUEST: bad $f")
        if (!USERNAME.matches(r.username)) bad("username")
        if (!WebEnvelopes.isLowerHex(r.pseudonymPub, 32)) bad("pseudonymPub")
        if (r.renewOfHash != "" && !WebEnvelopes.isLowerHex(r.renewOfHash, 32)) bad("renewOfHash")
        if (r.deviceCheckRef !in DEVICE_CHECK_REFS) bad("deviceCheckRef")
        if (!isTime(r.issuedAt)) bad("issuedAt")
        return VoiciJs.utf8(listOf(TAG_MESSAGES_KEY_ATTESTATION_REQUEST, r.username, r.pseudonymPub, r.renewOfHash, r.deviceCheckRef, r.issuedAt.toString()).joinToString("|"))
    }

    fun signMessagesKeyAttestationRequest(r: MessagesKeyAttestationRequest, deviceSeed: ByteArray): String =
        VoiciJs.hex(VoiciJs.edSign(deviceSeed, canonicalMessagesKeyAttestationRequest(r)))

    fun verifyMessagesKeyAttestationRequest(r: MessagesKeyAttestationRequest, signature: String, devicePub: String): Boolean = try {
        WebEnvelopes.ed25519VerifyHex(signature, canonicalMessagesKeyAttestationRequest(r), devicePub)
    } catch (_: IllegalArgumentException) {
        false
    }

    /** The signed bytes of an answer (signedBy, signature and the tag bytes themselves are not in them). */
    fun canonicalMessagesKeyAttestation(b: MessagesKeyAttestation): ByteArray {
        fun bad(f: String): Nothing = throw IllegalArgumentException("$TAG_MESSAGES_KEY_ATTESTATION: bad $f")
        if (!WebEnvelopes.isLowerHex(b.pseudonymPub, 32)) bad("pseudonymPub")
        if (!isTime(b.abuseEpoch) || b.abuseEpoch < 1) bad("abuseEpoch")
        if (!WebEnvelopes.isLowerHex(b.abuseTagHash, 32)) bad("abuseTagHash")
        if (!isTime(b.issuedAt) || !isTime(b.expiresAt) || b.expiresAt <= b.issuedAt) bad("time")
        return VoiciJs.utf8(
            listOf(TAG_MESSAGES_KEY_ATTESTATION, b.pseudonymPub, b.abuseEpoch.toString(), b.abuseTagHash, b.issuedAt.toString(), b.expiresAt.toString()).joinToString("|"),
        )
    }

    /** .com's side, over tag bytes it sealed: here for tests and tooling. */
    fun signMessagesKeyAttestation(pseudonymPub: String, abuseEpoch: Long, issuedAt: Long, expiresAt: Long, abuseTag: ByteArray, caSeed: ByteArray): MessagesKeyAttestation {
        val unsigned = MessagesKeyAttestation(
            pseudonymPub, abuseEpoch, WebEnvelopes.sha256Hex(abuseTag), WebEnvelopes.b64Encode(abuseTag), issuedAt, expiresAt,
            VoiciJs.hex(VoiciJs.edPub(caSeed)), "",
        )
        return unsigned.copy(signature = VoiciJs.hex(VoiciJs.edSign(caSeed, canonicalMessagesKeyAttestation(unsigned))))
    }

    /** Strict shape (exact keys, hex lengths, canonical base64 of at most 4 KiB); no signature check. */
    fun parseMessagesKeyAttestation(v: JsonElement?): MessagesKeyAttestation? {
        val r = VoiciJs.obj(v) ?: return null
        if (r.keys.sorted() != ATTESTATION_KEYS) return null
        if (VoiciJs.str(r["kind"]) != "MessagesKeyAttestation" || !VoiciJs.isNumEq(r["version"], 1)) return null
        val tag = WebEnvelopes.b64Decode(r["abuseTag"]) ?: return null
        if (tag.size > ABUSE_TAG_MAX_BYTES) return null
        if (!WebEnvelopes.isLowerHex(r["signedBy"], 32) || !WebEnvelopes.isLowerHex(r["signature"], 64)) return null
        val a = MessagesKeyAttestation(
            pseudonymPub = VoiciJs.str(r["pseudonymPub"]) ?: return null,
            abuseEpoch = VoiciJs.time(r["abuseEpoch"]) ?: return null,
            abuseTagHash = VoiciJs.str(r["abuseTagHash"]) ?: return null,
            abuseTag = VoiciJs.str(r["abuseTag"])!!,
            issuedAt = VoiciJs.time(r["issuedAt"]) ?: return null,
            expiresAt = VoiciJs.time(r["expiresAt"]) ?: return null,
            signedBy = VoiciJs.str(r["signedBy"])!!,
            signature = VoiciJs.str(r["signature"])!!,
        )
        return try {
            canonicalMessagesKeyAttestation(a)
            a
        } catch (_: IllegalArgumentException) {
            null
        }
    }

    /** What a renewal names: SHA-256 hex of the canonical JSON of the previous attestation. */
    fun messagesAttestationHash(a: MessagesKeyAttestation): String = WebEnvelopes.sha256Hex(WebEnvelopes.canonicalJsonBytes(a.toJson()))

    /**
     * Checks an attestation against authorized CA keys (hex): shape, signedBy among caKeys, the signature,
     * H(abuseTag) = abuseTagHash, pseudonymPub when given, and `now` inside [issuedAt, expiresAt).
     */
    fun checkMessagesKeyAttestation(v: JsonElement?, caKeys: Collection<String>, now: Long, pseudonymPub: String? = null): VoiciOutcome<MessagesKeyAttestation> {
        val a = parseMessagesKeyAttestation(v) ?: return VoiciOutcome.Refused("malformed")
        if (a.signedBy !in caKeys) return VoiciOutcome.Refused("unknown-ca")
        if (!WebEnvelopes.ed25519VerifyHex(a.signature, canonicalMessagesKeyAttestation(a), a.signedBy)) return VoiciOutcome.Refused("bad-signature")
        if (WebEnvelopes.sha256Hex(WebEnvelopes.b64Decode(a.abuseTag)!!) != a.abuseTagHash) return VoiciOutcome.Refused("bad-abuse-tag")
        if (pseudonymPub != null && a.pseudonymPub != pseudonymPub) return VoiciOutcome.Refused("wrong-key")
        if (now < a.issuedAt) return VoiciOutcome.Refused("not-yet-valid")
        if (now >= a.expiresAt) return VoiciOutcome.Refused("expired")
        return VoiciOutcome.Ok(a)
    }
}
