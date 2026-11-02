// voi.ci Messages (docs/voici-and-messages.md §1, §6-§10): key derivations from the UMK, the conversation id, the
// sealed body (AES-256-GCM under a random CEK, the CEK wrapped with the hybrid seal to two X-Wing keys), the thread
// statement, the checks for the voici-message / voici-reply / voici-draft envelopes, the phone's delivery ack, block
// orders, draft ops, the Messages state blob, message and page reports and the "Sign in with Flagship" payloads.
// Kotlin twin of packages/protocol/src/voiciMessages.ts (the browser's thread-fetch signature and the abuse-side
// report sealing are not ported: the app never makes them). Vectors: packages/protocol/test-vectors/messages/.
//
// Derivations (HKDF-SHA256, salt empty, 32 bytes):
//   inbox X-Wing seed   KDF(umk, "flagship/voici-inbox/v1|<pageId>|<inboxEpoch>")
//   owner signing seed  KDF(umk, "flagship/voici-owner-sign/v1|<pageId>|<inboxEpoch>")      Ed25519
//   messages secret     KDF(umk, "flagship/messages-secret/v1")
//   pseudonym seed P    KDF(messagesSecret, "flagship/messages-pseudonym/v1|<pageId>")       Ed25519
//   thread seed T       KDF(messagesSecret, "flagship/messages-thread/v1|<pageId>")          X-Wing
//   drafts key          KDF(umk, "flagship/voici-drafts/v1")                                 AES-256-GCM
//   state key           KDF(umk, "flagship/messages-state/v1")                               AES-256-GCM
//   conv                SHA-256 hex of "flagship/voici-conv/v1|<pageId>|<Ppub hex>"
// Sealed body: canonicalJson({suite, nonce, ct, wraps:[{keyId, sealed}, {..}]}); ct = AES-256-GCM(CEK, nonce, aad
// "flagship/voici-body/v1|<conv>|<msgId>", canonicalJson({v:1, text, replyTo})); each wrap seals the CEK with
// purpose "flagship/voici-cek/v1", context [conv, msgId], senderKeyId = SHA-256(raw `from` key), issuedAt = sentAt.
// Other signed records: flagship/voici-thread-key/v1, flagship/voici-ack/v1, flagship/voici-block/v1,
// flagship/voici-report/v1, flagship/voici-draft/v1 (draft AEAD), flagship/voici-sign-in/v1 and
// flagship/voici-sign-in-request/v1 (pipe payload kinds).
//
// Public API (object VoiciMessages): the TAG_* constants, VOICI_SEND_SKEW_MS, VOICI_DRAFT_MAX_*, VOICI_STATE_MAX_BYTES,
// deriveVoiciInboxKey, deriveVoiciOwnerSignKey, deriveMessagesSecret, deriveMessagesPseudonymKey,
// deriveMessagesThreadKey, deriveVoiciDraftsKey, deriveMessagesStateKey, voiciConv, sealVoiciBody,
// parseVoiciSealedBody, openVoiciBody, canonicalVoiciThreadStatement, signVoiciThreadStatement,
// parseVoiciThreadStatement, checkVoiciMessage, checkVoiciReply, checkVoiciDraft, canonicalVoiciAck, signVoiciAck,
// verifyVoiciAck, canonicalVoiciBlock, signVoiciBlock, verifyVoiciBlock, parseVoiciBlock, VOICI_DRAFT_OP_KINDS,
// parseVoiciDraftOp, sealVoiciDraft, parseVoiciDraftBody, openVoiciDraft, emptyMessagesState, parseMessagesState,
// mergeMessagesState, sealMessagesState, openMessagesState, VOICI_REPORT_REASONS, canonicalVoiciReport,
// signVoiciMessageReport, verifyVoiciMessageReport, parseVoiciSignInRequest, checkVoiciSignInAnswer.

package com.flagshipserver.app.core.voici

import com.flagshipserver.app.core.pq.PqHybrid
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.security.SecureRandom

data class VoiciPlaintext(val text: String, val replyTo: String?) {
    fun toJson() = JsonObject(linkedMapOf("v" to JsonPrimitive(1), "text" to JsonPrimitive(text), "replyTo" to (replyTo?.let { JsonPrimitive(it) } ?: JsonNull)))
}

/** Fixed randomness, for vectors only. */
class VoiciSealRandomness(val cek: ByteArray, val nonce: ByteArray, val eseeds: List<ByteArray>)

data class VoiciWrap(val keyId: String, val sealed: String)
data class VoiciSealedBody(val nonce: String, val ct: String, val wraps: List<VoiciWrap>)

data class VoiciThreadStatement(val pageId: String, val pseudonymPub: String, val threadPub: String, val issuedAt: Long) {
    fun toJson() = JsonObject(
        linkedMapOf("pageId" to JsonPrimitive(pageId), "pseudonymPub" to JsonPrimitive(pseudonymPub), "threadPub" to JsonPrimitive(threadPub), "issuedAt" to JsonPrimitive(issuedAt)),
    )
}

data class VoiciMessageCred(
    val attestation: MessagesKeyAttestation,
    val delegation: WebDelegation,
    val delegationSig: String,
    val threadStmt: VoiciThreadStatement,
    val threadSig: String,
)

class VoiciMessageCheckContext(
    val pageId: String,
    val acceptsMessages: Boolean,
    /** Website origin a delegation must name ("https://voi.ci", gym "https://gym.voi.ci"). */
    val origin: String,
    val caKeys: Collection<String>,
    val now: Long,
    /** Pseudonyms this page blocked and pseudonyms Flagship banned (hex). */
    val blocked: Set<String>? = null,
    /** Revoked browser keys (delegatePub hex). */
    val revoked: Set<String>? = null,
    /** Called after the cheap filters, before any signature check; return "rate-limited" to stop. */
    val rateLimit: ((WebEnvelope) -> String?)? = null,
)

data class VoiciMessageChecked(val envelope: WebEnvelope, val cred: VoiciMessageCred)
data class VoiciReplyChecked(val envelope: WebEnvelope, val pageSeq: Long)

data class VoiciAck(val conv: String, val msgId: String, val receivedAt: Long, val phoneRoutePub: String, val signature: String = "") {
    fun toJson() = JsonObject(
        linkedMapOf(
            "conv" to JsonPrimitive(conv), "msgId" to JsonPrimitive(msgId), "receivedAt" to JsonPrimitive(receivedAt),
            "phoneRoutePub" to JsonPrimitive(phoneRoutePub), "signature" to JsonPrimitive(signature),
        ),
    )
}

data class VoiciBlock(val pageId: String, val pseudonymPub: String, val op: String, val issuedAt: Long)

data class VoiciDraftImage(val sha256: String, val data: String)

/** {v:1, opId, op, at, deviceId, post? | postId? | profile? | accepts?, images?}. */
data class VoiciDraftOp(
    val opId: String,
    val op: String,
    val at: Long,
    val deviceId: String,
    val post: VoiciPost? = null,
    val postId: String? = null,
    val profile: VoiciProfile? = null,
    val accepts: Int? = null,
    val images: List<VoiciDraftImage>? = null,
) {
    fun toJson(): JsonObject {
        val m = linkedMapOf<String, JsonElement>("v" to JsonPrimitive(1), "opId" to JsonPrimitive(opId), "op" to JsonPrimitive(op), "at" to JsonPrimitive(at), "deviceId" to JsonPrimitive(deviceId))
        post?.let { m["post"] = it.toJson() }
        postId?.let { m["postId"] = JsonPrimitive(it) }
        profile?.let { m["profile"] = it.toJson() }
        accepts?.let { m["accepts"] = JsonPrimitive(it) }
        images?.let { l -> m["images"] = JsonArray(l.map { JsonObject(linkedMapOf("sha256" to JsonPrimitive(it.sha256), "data" to JsonPrimitive(it.data))) }) }
        return JsonObject(m)
    }
}

data class MessagesNickname(val name: String, val at: Long)
data class MessagesSignedInSite(val pageId: String, val delegatePub: String, val at: Long)

data class MessagesState(
    val nicknames: Map<String, MessagesNickname> = emptyMap(),
    val blocks: List<String> = emptyList(),
    val accepted: List<String> = emptyList(),
    val archived: List<String> = emptyList(),
    val readUpTo: Map<String, String> = emptyMap(),
    val signedInSites: List<MessagesSignedInSite> = emptyList(),
    val pendingOps: List<VoiciDraftOp> = emptyList(),
) {
    fun toJson() = JsonObject(
        linkedMapOf(
            "v" to JsonPrimitive(1),
            "nicknames" to JsonObject(nicknames.mapValues { (_, n) -> JsonObject(linkedMapOf("name" to JsonPrimitive(n.name), "at" to JsonPrimitive(n.at))) }),
            "blocks" to JsonArray(blocks.map { JsonPrimitive(it) }),
            "accepted" to JsonArray(accepted.map { JsonPrimitive(it) }),
            "archived" to JsonArray(archived.map { JsonPrimitive(it) }),
            "readUpTo" to JsonObject(readUpTo.mapValues { JsonPrimitive(it.value) }),
            "signedInSites" to JsonArray(
                signedInSites.map { JsonObject(linkedMapOf("pageId" to JsonPrimitive(it.pageId), "delegatePub" to JsonPrimitive(it.delegatePub), "at" to JsonPrimitive(it.at))) },
            ),
            "pendingOps" to JsonArray(pendingOps.map { it.toJson() }),
        ),
    )
}

data class MessagesStateBlob(val version: Long, val nonce: String, val ct: String) {
    fun toJson() = JsonObject(linkedMapOf("version" to JsonPrimitive(version), "nonce" to JsonPrimitive(nonce), "ct" to JsonPrimitive(ct)))
}

sealed interface VoiciReport

/** By the owner: {kind:"message", pageId, envelope, reason, attached: base64 | null, issuedAt}. */
data class VoiciMessageReport(val pageId: String, val envelope: WebEnvelope, val reason: String, val attached: String?, val issuedAt: Long) : VoiciReport

/** By anyone: {kind:"page", username, seq, reason, note, issuedAt}. */
data class VoiciPageReport(val username: String, val seq: Long, val reason: String, val note: String, val issuedAt: Long) : VoiciReport

data class VoiciSignInRequest(val origin: String, val pageId: String, val username: String, val delegatePub: String, val nonce: String)

data class VoiciSignInAnswer(val pageId: String, val pseudonymPub: String, val cred: VoiciMessageCred, val threadSeed: String)

object VoiciMessages {
    const val TAG_VOICI_INBOX = "flagship/voici-inbox/v1"
    const val TAG_VOICI_OWNER_SIGN = "flagship/voici-owner-sign/v1"
    const val TAG_MESSAGES_SECRET = "flagship/messages-secret/v1"
    const val TAG_MESSAGES_PSEUDONYM = "flagship/messages-pseudonym/v1"
    const val TAG_MESSAGES_THREAD = "flagship/messages-thread/v1"
    const val TAG_VOICI_DRAFTS = "flagship/voici-drafts/v1"
    const val TAG_MESSAGES_STATE = "flagship/messages-state/v1"
    const val TAG_VOICI_CONV = "flagship/voici-conv/v1"
    const val TAG_VOICI_BODY = "flagship/voici-body/v1"
    const val TAG_VOICI_CEK = "flagship/voici-cek/v1"
    const val TAG_VOICI_THREAD_KEY = "flagship/voici-thread-key/v1"
    const val TAG_VOICI_ACK = "flagship/voici-ack/v1"
    const val TAG_VOICI_BLOCK = "flagship/voici-block/v1"
    const val TAG_VOICI_DRAFT = "flagship/voici-draft/v1"
    const val TAG_VOICI_REPORT = "flagship/voici-report/v1"
    const val TAG_VOICI_SIGN_IN = "flagship/voici-sign-in/v1"
    const val TAG_VOICI_SIGN_IN_REQUEST = "flagship/voici-sign-in-request/v1"

    const val VOICI_SEND_SKEW_MS = 10L * 60_000
    const val VOICI_DRAFT_MAX_ENVELOPE_BYTES = 1024 * 1024
    const val VOICI_DRAFT_MAX_BODY_BYTES = 960 * 1024
    const val VOICI_DRAFT_MAX_IMAGE_BYTES = 150 * 1024
    const val VOICI_DRAFT_MAX_IMAGES = 4
    const val VOICI_STATE_MAX_BYTES = 256 * 1024

    private val PAGE_ID = Regex("^[0-9a-f]{32}$")
    private val USERNAME = Regex("^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$")
    private val rng = SecureRandom()
    private fun random(n: Int) = ByteArray(n).also(rng::nextBytes)
    private fun isTime(n: Long) = n in 0..VoiciJs.MAX_SAFE
    private fun hex(s: String?, n: Int? = null) = WebEnvelopes.isLowerHex(s, n)
    private fun hex(e: JsonElement?, n: Int? = null) = WebEnvelopes.isLowerHex(e, n)
    private fun str(e: JsonElement?) = VoiciJs.str(e)
    private fun no(code: String): VoiciOutcome<Nothing> = VoiciOutcome.Refused(code)

    // ── derivations ──

    private fun needPageId(pageId: String) = require(PAGE_ID.matches(pageId)) { "pageId must be 16 bytes of lowercase hex" }
    private fun needEpoch(e: Long) = require(e in 1..VoiciJs.MAX_SAFE) { "inboxEpoch must be an integer >= 1" }

    /** The owner's inbox X-Wing key: seed (32, the secret) and publicKey (1216). */
    fun deriveVoiciInboxKey(umkSeed: ByteArray, pageId: String, inboxEpoch: Long): VoiciKeyPair {
        needPageId(pageId)
        needEpoch(inboxEpoch)
        val seed = VoiciJs.hkdf32(umkSeed, "$TAG_VOICI_INBOX|$pageId|$inboxEpoch")
        return VoiciKeyPair(seed, PqHybrid.hybridSealKeygen(seed).publicKey)
    }

    /** The owner's messages signing key (Ed25519): signs replies, blocks and phone acks. */
    fun deriveVoiciOwnerSignKey(umkSeed: ByteArray, pageId: String, inboxEpoch: Long): VoiciKeyPair {
        needPageId(pageId)
        needEpoch(inboxEpoch)
        val seed = VoiciJs.hkdf32(umkSeed, "$TAG_VOICI_OWNER_SIGN|$pageId|$inboxEpoch")
        return VoiciKeyPair(seed, VoiciJs.edPub(seed))
    }

    fun deriveMessagesSecret(umkSeed: ByteArray): ByteArray = VoiciJs.hkdf32(umkSeed, TAG_MESSAGES_SECRET)

    /** The sender's pseudonym key P toward one page (Ed25519). */
    fun deriveMessagesPseudonymKey(messagesSecret: ByteArray, pageId: String): VoiciKeyPair {
        needPageId(pageId)
        val seed = VoiciJs.hkdf32(messagesSecret, "$TAG_MESSAGES_PSEUDONYM|$pageId")
        return VoiciKeyPair(seed, VoiciJs.edPub(seed))
    }

    /** The sender's thread key T toward one page (X-Wing). */
    fun deriveMessagesThreadKey(messagesSecret: ByteArray, pageId: String): VoiciKeyPair {
        needPageId(pageId)
        val seed = VoiciJs.hkdf32(messagesSecret, "$TAG_MESSAGES_THREAD|$pageId")
        return VoiciKeyPair(seed, PqHybrid.hybridSealKeygen(seed).publicKey)
    }

    fun deriveVoiciDraftsKey(umkSeed: ByteArray): ByteArray = VoiciJs.hkdf32(umkSeed, TAG_VOICI_DRAFTS)
    fun deriveMessagesStateKey(umkSeed: ByteArray): ByteArray = VoiciJs.hkdf32(umkSeed, TAG_MESSAGES_STATE)

    fun voiciConv(pageId: String, pseudonymPub: String): String {
        needPageId(pageId)
        require(hex(pseudonymPub, 32)) { "pseudonym key must be 32 bytes of lowercase hex" }
        return WebEnvelopes.sha256Hex("$TAG_VOICI_CONV|$pageId|$pseudonymPub")
    }

    // ── sealed body ──

    private fun plaintextBytes(p: VoiciPlaintext): ByteArray {
        VoiciText.checkVoiciText(VoiciTextField.messageText, p.text)?.let { throw IllegalArgumentException("voici body: text refused ($it)") }
        require(p.replyTo == null || hex(p.replyTo, 16)) { "voici body: bad replyTo" }
        return WebEnvelopes.canonicalJsonBytes(p.toJson())
    }

    private fun bodyAad(conv: String, msgId: String) = VoiciJs.utf8("$TAG_VOICI_BODY|$conv|$msgId")

    /** Seals `plaintext` for a message (recipients [inboxPub, threadPub]) or a reply ([threadPub, inboxPub]). */
    fun sealVoiciBody(
        conv: String,
        msgId: String,
        sentAt: Long,
        fromPub: String,
        recipients: List<ByteArray>,
        plaintext: VoiciPlaintext,
        rnd: VoiciSealRandomness? = null,
    ): ByteArray {
        require(hex(msgId, 16) && hex(conv, 32) && hex(fromPub)) { "voici body: bad ids" }
        require(recipients.size == 2) { "voici body: two recipients" }
        val cek = rnd?.cek ?: random(32)
        val nonce = rnd?.nonce ?: random(12)
        require(cek.size == 32 && nonce.size == 12) { "voici body: bad randomness" }
        val ct = VoiciJs.gcmEncrypt(cek, nonce, bodyAad(conv, msgId), plaintextBytes(plaintext))
        val wraps = recipients.mapIndexed { i, pub ->
            val eseed = rnd?.eseeds?.getOrNull(i) ?: random(PqHybrid.HYBRID_SEAL_RANDOMNESS_LEN)
            val sealed = PqHybrid.hybridSealWithRandomness(
                pub,
                PqHybrid.HybridSealOptions(purpose = TAG_VOICI_CEK, senderKeyId = VoiciJs.sha256(WebEnvelopes.hexToBytes(fromPub)), issuedAt = sentAt),
                listOf(VoiciJs.utf8(conv), VoiciJs.utf8(msgId)),
                cek,
                eseed,
            )
            mapOf("keyId" to VoiciJs.hex(PqHybrid.pqKeyId(PqHybrid.SUITE_HYBRID_SEAL_V1, pub)), "sealed" to WebEnvelopes.b64Encode(sealed))
        }
        return WebEnvelopes.canonicalJsonBytes(mapOf("suite" to PqHybrid.TAG_HYBRID_SEAL_V1, "nonce" to VoiciJs.hex(nonce), "ct" to WebEnvelopes.b64Encode(ct), "wraps" to wraps))
    }

    private fun canonicalText(v: JsonElement, text: String): Boolean = try {
        WebEnvelopes.canonicalJson(v) == text
    } catch (_: IllegalArgumentException) {
        false
    }

    /** Strict outer schema of a sealed body (before anything is decrypted): canonical JSON, exactly two wraps. */
    fun parseVoiciSealedBody(bodyBytes: ByteArray?): VoiciSealedBody? {
        val text = VoiciJs.utf8Fatal(bodyBytes ?: return null) ?: return null
        val r = VoiciJs.obj(VoiciJs.parseJson(text)) ?: return null
        if (!VoiciJs.exactKeysOpt(r, listOf("suite", "nonce", "ct", "wraps")) || str(r["suite"]) != PqHybrid.TAG_HYBRID_SEAL_V1) return null
        if (!hex(r["nonce"], 12) || WebEnvelopes.b64Decode(r["ct"]) == null) return null
        val ws = VoiciJs.arr(r["wraps"]) ?: return null
        if (ws.size != 2) return null
        val wraps = ArrayList<VoiciWrap>()
        for (we in ws) {
            val w = VoiciJs.obj(we) ?: return null
            if (!VoiciJs.exactKeysOpt(w, listOf("keyId", "sealed")) || !hex(w["keyId"], 32) || WebEnvelopes.b64Decode(w["sealed"]) == null) return null
            wraps.add(VoiciWrap(str(w["keyId"])!!, str(w["sealed"])!!))
        }
        if (!canonicalText(r, text)) return null
        return VoiciSealedBody(str(r["nonce"])!!, str(r["ct"])!!, wraps)
    }

    /**
     * Unwraps the CEK with the recipient's X-Wing seed, decrypts, then the inner schema and the text refusals.
     * Codes: malformed, no-wrap, decrypt-failed, inner-schema, or a text refusal.
     */
    fun openVoiciBody(bodyBytes: ByteArray, conv: String, msgId: String, recipientSeed: ByteArray): VoiciOutcome<VoiciPlaintext> {
        val b = parseVoiciSealedBody(bodyBytes) ?: return no("malformed")
        val myId = VoiciJs.hex(PqHybrid.pqKeyId(PqHybrid.SUITE_HYBRID_SEAL_V1, PqHybrid.hybridSealKeygen(recipientSeed).publicKey))
        val w = b.wraps.firstOrNull { it.keyId == myId } ?: return no("no-wrap")
        val pt = try {
            val cek = PqHybrid.hybridOpen(recipientSeed, TAG_VOICI_CEK, listOf(VoiciJs.utf8(conv), VoiciJs.utf8(msgId)), WebEnvelopes.b64Decode(w.sealed)!!).plaintext
            if (cek.size != 32) return no("decrypt-failed")
            VoiciJs.gcmDecrypt(cek, WebEnvelopes.hexToBytes(b.nonce), bodyAad(conv, msgId), WebEnvelopes.b64Decode(b.ct)!!)
        } catch (_: Exception) {
            return no("decrypt-failed")
        }
        val text = VoiciJs.utf8Fatal(pt) ?: return no("inner-schema")
        val r = VoiciJs.parseJson(text) ?: return no("inner-schema")
        val o = VoiciJs.obj(r) ?: return no("inner-schema")
        if (!VoiciJs.exactKeysOpt(o, listOf("v", "text", "replyTo")) || !VoiciJs.isNumEq(o["v"], 1) || str(o["text"]) == null) return no("inner-schema")
        if (o["replyTo"] !is JsonNull && !hex(o["replyTo"], 16)) return no("inner-schema")
        VoiciText.checkVoiciText(VoiciTextField.messageText, str(o["text"]))?.let { return no(it) }
        if (!canonicalText(o, text)) return no("inner-schema")
        return VoiciOutcome.Ok(VoiciPlaintext(str(o["text"])!!, str(o["replyTo"])))
    }

    // ── thread statement ──

    fun canonicalVoiciThreadStatement(s: VoiciThreadStatement): ByteArray {
        needPageId(s.pageId)
        if (!hex(s.pseudonymPub, 32) || !hex(s.threadPub, 1216) || !isTime(s.issuedAt)) throw IllegalArgumentException("$TAG_VOICI_THREAD_KEY: bad field")
        return VoiciJs.utf8(listOf(TAG_VOICI_THREAD_KEY, s.pageId, s.pseudonymPub, s.threadPub, s.issuedAt.toString()).joinToString("|"))
    }

    fun signVoiciThreadStatement(s: VoiciThreadStatement, pseudonymSeed: ByteArray): String =
        VoiciJs.hex(VoiciJs.edSign(pseudonymSeed, canonicalVoiciThreadStatement(s)))

    fun parseVoiciThreadStatement(v: JsonElement?): VoiciThreadStatement? {
        val o = VoiciJs.obj(v) ?: return null
        if (!VoiciJs.exactKeysOpt(o, listOf("pageId", "pseudonymPub", "threadPub", "issuedAt"))) return null
        val s = VoiciThreadStatement(str(o["pageId"]) ?: return null, str(o["pseudonymPub"]) ?: return null, str(o["threadPub"]) ?: return null, VoiciJs.time(o["issuedAt"]) ?: return null)
        return try {
            canonicalVoiciThreadStatement(s)
            s
        } catch (_: IllegalArgumentException) {
            null
        }
    }

    // ── envelope checks ──

    private fun outer(input: Any?, maxEnvelope: Int, maxBody: Int): VoiciOutcome<WebEnvelope> {
        when (input) {
            is String -> if (VoiciJs.utf8(input).size > maxEnvelope) return no("too-large")
            is JsonElement -> if (VoiciJs.utf8(input.toString()).size > maxEnvelope) return no("too-large")
            else -> return no("malformed")
        }
        return WebEnvelopes.parseWebEnvelope(input, maxBody)?.let { VoiciOutcome.Ok(it) } ?: no("malformed")
    }

    private fun fresh(sentAt: Long, now: Long) = Math.abs(sentAt - now) <= VOICI_SEND_SKEW_MS

    /**
     * The receiver's checks for a voici-message (§8.3, §12.1), cheapest first: size, outer schema, kind, audience,
     * accepting, blocked / banned, revoked, rate limits, attestation (CA, abuse-tag hash, key = from), delegation (by
     * P, scope voici-messages, origin, audience, principal = from, within the attestation's life), thread statement,
     * conv, the envelope's P-256 signature by the delegated key, freshness. Nothing is decrypted.
     */
    fun checkVoiciMessage(input: Any?, ctx: VoiciMessageCheckContext): VoiciOutcome<VoiciMessageChecked> {
        val o = outer(input, WebEnvelopes.WEB_ENVELOPE_MAX_BYTES, WebEnvelopes.WEB_ENVELOPE_MAX_BODY_BYTES)
        val env = o.valueOrNull() ?: return o as VoiciOutcome.Refused
        if (env.kind != "voici-message" || env.sigAlg != "p256") return no("wrong-kind")
        if (!hex(env.from, 32) || !hex(env.conv, 32)) return no("malformed")
        if (parseVoiciSealedBody(WebEnvelopes.b64Decode(env.bodyB64)) == null) return no("malformed")
        val c = env.cred
        if (!VoiciJs.exactKeysOpt(c, listOf("attestation", "delegation", "delegationSig", "threadStmt", "threadSig"))) return no("malformed")
        if (env.audience != ctx.pageId) return no("wrong-audience")
        if (!ctx.acceptsMessages) return no("not-accepting")
        if (ctx.blocked?.contains(env.from) == true) return no("blocked")
        val delegatePub = str(VoiciJs.obj(c["delegation"])?.get("delegatePub"))
        if (delegatePub != null && ctx.revoked?.contains(delegatePub) == true) return no("revoked")
        ctx.rateLimit?.invoke(env)?.let { return no(it) }
        val att = MessagesAttestations.checkMessagesKeyAttestation(c["attestation"], ctx.caKeys, ctx.now, env.from).valueOrNull()
            ?: return no("bad-attestation")
        val del = WebDelegations.checkWebDelegation(
            c["delegation"], str(c["delegationSig"]),
            WebDelegations.Want("voici-messages", ctx.origin, ctx.pageId, env.from, ctx.now, att.expiresAt),
        ).valueOrNull() ?: return no("bad-delegation")
        val ts = parseVoiciThreadStatement(c["threadStmt"])
        val threadSig = str(c["threadSig"])
        if (ts == null || ts.pageId != ctx.pageId || ts.pseudonymPub != env.from || threadSig == null) return no("bad-thread")
        if (!WebEnvelopes.ed25519VerifyHex(threadSig, canonicalVoiciThreadStatement(ts), env.from)) return no("bad-thread")
        if (env.conv != voiciConv(ctx.pageId, env.from)) return no("wrong-conv")
        if (!WebEnvelopes.verifyWebEnvelopeSignature(env, del.delegatePub)) return no("bad-signature")
        if (!fresh(env.sentAt, ctx.now)) return no("stale")
        return VoiciOutcome.Ok(VoiciMessageChecked(env, VoiciMessageCred(att, del, str(c["delegationSig"])!!, ts, threadSig)))
    }

    /**
     * A voici-reply: kind, audience = pageId, cred exactly {pageSeq}, from = ownerSignPub, conv = `conv` when given,
     * the Ed25519 signature, and freshness only when `freshAt` is given.
     */
    fun checkVoiciReply(input: Any?, pageId: String, ownerSignPub: String, conv: String? = null, freshAt: Long? = null): VoiciOutcome<VoiciReplyChecked> {
        val o = outer(input, WebEnvelopes.WEB_ENVELOPE_MAX_BYTES, WebEnvelopes.WEB_ENVELOPE_MAX_BODY_BYTES)
        val env = o.valueOrNull() ?: return o as VoiciOutcome.Refused
        if (env.kind != "voici-reply" || env.sigAlg != "ed25519") return no("wrong-kind")
        val pageSeq = VoiciJs.time(env.cred["pageSeq"])
        if (!hex(env.conv, 32) || !VoiciJs.exactKeysOpt(env.cred, listOf("pageSeq")) || pageSeq == null || pageSeq < 1) return no("malformed")
        if (parseVoiciSealedBody(WebEnvelopes.b64Decode(env.bodyB64)) == null) return no("malformed")
        if (env.audience != pageId) return no("wrong-audience")
        if (conv != null && env.conv != conv) return no("wrong-conv")
        if (env.from != ownerSignPub || !WebEnvelopes.verifyWebEnvelopeSignature(env, ownerSignPub)) return no("bad-signature")
        if (freshAt != null && !fresh(env.sentAt, freshAt)) return no("stale")
        return VoiciOutcome.Ok(VoiciReplyChecked(env, pageSeq))
    }

    /**
     * A voici-draft from another device of the owner's account: kind, audience = username, conv "", cred exactly
     * {grant, grantSignature}, the Ed25519 signature by `from`, then `checkGrant` (the caller's grant-chain check) and
     * freshness when `freshAt` is given. Caps: VOICI_DRAFT_MAX_*.
     */
    fun checkVoiciDraft(
        input: Any?,
        username: String,
        checkGrant: (grant: JsonElement?, grantSignature: String, devicePub: String) -> Boolean,
        freshAt: Long? = null,
    ): VoiciOutcome<WebEnvelope> {
        val o = outer(input, VOICI_DRAFT_MAX_ENVELOPE_BYTES, VOICI_DRAFT_MAX_BODY_BYTES)
        val env = o.valueOrNull() ?: return o
        if (env.kind != "voici-draft" || env.sigAlg != "ed25519") return no("wrong-kind")
        if (env.conv != "" || !hex(env.from, 32) || !VoiciJs.exactKeysOpt(env.cred, listOf("grant", "grantSignature")) || !hex(env.cred["grantSignature"], 64)) return no("malformed")
        if (parseVoiciDraftBody(WebEnvelopes.b64Decode(env.bodyB64)) == null) return no("malformed")
        if (env.audience != username) return no("wrong-audience")
        if (!WebEnvelopes.verifyWebEnvelopeSignature(env, env.from)) return no("bad-signature")
        if (!checkGrant(env.cred["grant"], str(env.cred["grantSignature"])!!, env.from)) return no("bad-grant")
        if (freshAt != null && !fresh(env.sentAt, freshAt)) return no("stale")
        return VoiciOutcome.Ok(env)
    }

    // ── phone ack ──

    /** conv "" for a draft; signed by the owner messages signing key or the admin device key. */
    fun canonicalVoiciAck(a: VoiciAck): ByteArray {
        if ((a.conv != "" && !hex(a.conv, 32)) || !hex(a.msgId, 16) || !isTime(a.receivedAt) || !hex(a.phoneRoutePub) || a.phoneRoutePub.isEmpty()) {
            throw IllegalArgumentException("$TAG_VOICI_ACK: bad field")
        }
        return VoiciJs.utf8(listOf(TAG_VOICI_ACK, a.conv, a.msgId, a.receivedAt.toString(), a.phoneRoutePub).joinToString("|"))
    }

    fun signVoiciAck(a: VoiciAck, seed: ByteArray): VoiciAck = a.copy(signature = VoiciJs.hex(VoiciJs.edSign(seed, canonicalVoiciAck(a))))

    /** Shape + signature by signerPub + it acknowledges msgId (and conv when given); the ack or null. */
    fun verifyVoiciAck(v: JsonElement?, signerPub: String, msgId: String, conv: String? = null): VoiciAck? {
        val o = VoiciJs.obj(v) ?: return null
        if (!VoiciJs.exactKeysOpt(o, listOf("conv", "msgId", "receivedAt", "phoneRoutePub", "signature"))) return null
        val sig = str(o["signature"]) ?: return null
        val a = VoiciAck(str(o["conv"]) ?: return null, str(o["msgId"]) ?: return null, VoiciJs.time(o["receivedAt"]) ?: return null, str(o["phoneRoutePub"]) ?: return null)
        val bytes = try {
            canonicalVoiciAck(a)
        } catch (_: IllegalArgumentException) {
            return null
        }
        if (a.msgId != msgId || (conv != null && a.conv != conv)) return null
        return if (WebEnvelopes.ed25519VerifyHex(sig, bytes, signerPub)) a.copy(signature = sig) else null
    }

    // ── block ──

    fun canonicalVoiciBlock(b: VoiciBlock): ByteArray {
        needPageId(b.pageId)
        if (!hex(b.pseudonymPub, 32) || (b.op != "block" && b.op != "unblock") || !isTime(b.issuedAt)) throw IllegalArgumentException("$TAG_VOICI_BLOCK: bad field")
        return VoiciJs.utf8(listOf(TAG_VOICI_BLOCK, b.pageId, b.pseudonymPub, b.op, b.issuedAt.toString()).joinToString("|"))
    }

    fun signVoiciBlock(b: VoiciBlock, ownerSignSeed: ByteArray): String = VoiciJs.hex(VoiciJs.edSign(ownerSignSeed, canonicalVoiciBlock(b)))

    fun verifyVoiciBlock(b: VoiciBlock, signature: String, ownerSignPub: String): Boolean = try {
        WebEnvelopes.ed25519VerifyHex(signature, canonicalVoiciBlock(b), ownerSignPub)
    } catch (_: IllegalArgumentException) {
        false
    }

    fun parseVoiciBlock(v: JsonElement?): VoiciBlock? {
        val o = VoiciJs.obj(v) ?: return null
        if (!VoiciJs.exactKeysOpt(o, listOf("pageId", "pseudonymPub", "op", "issuedAt"))) return null
        val b = VoiciBlock(str(o["pageId"]) ?: return null, str(o["pseudonymPub"]) ?: return null, str(o["op"]) ?: return null, VoiciJs.time(o["issuedAt"]) ?: return null)
        return try {
            canonicalVoiciBlock(b)
            b
        } catch (_: IllegalArgumentException) {
            null
        }
    }

    // ── draft ops (§5.2) ──

    val VOICI_DRAFT_OP_KINDS: List<String> = listOf("post-add", "post-edit", "post-delete", "profile", "accept-messages")
    private val OP_FIELD = mapOf("post-add" to "post", "post-edit" to "post", "post-delete" to "postId", "profile" to "profile", "accept-messages" to "accepts")
    private val DEVICE_ID = Regex("^[A-Za-z0-9-]{1,64}$")

    /** Strict schema of a draft op; null when malformed. */
    fun parseVoiciDraftOp(v: JsonElement?): VoiciDraftOp? {
        val o = VoiciJs.obj(v) ?: return null
        if (!VoiciJs.isNumEq(o["v"], 1) || !hex(o["opId"], 16)) return null
        val at = VoiciJs.time(o["at"]) ?: return null
        val op = str(o["op"])
        if (op == null || op !in VOICI_DRAFT_OP_KINDS) return null
        val deviceId = str(o["deviceId"])
        if (deviceId == null || !DEVICE_ID.matches(deviceId)) return null
        val field = OP_FIELD.getValue(op)
        if (!VoiciJs.exactKeysOpt(o, listOf("v", "opId", "op", "at", "deviceId", field), listOf("images"))) return null
        var out = VoiciDraftOp(str(o["opId"])!!, op, at, deviceId)
        out = when (field) {
            "post" -> out.copy(post = VoiciPage.parseVoiciPost(o["post"]) ?: return null)
            "postId" -> if (hex(o["postId"], 16)) out.copy(postId = str(o["postId"])) else return null
            "profile" -> out.copy(profile = VoiciPage.parseVoiciProfile(o["profile"]) ?: return null)
            else -> when {
                VoiciJs.isNumEq(o["accepts"], 0) -> out.copy(accepts = 0)
                VoiciJs.isNumEq(o["accepts"], 1) -> out.copy(accepts = 1)
                else -> return null
            }
        }
        if (o.containsKey("images")) {
            val arr = VoiciJs.arr(o["images"]) ?: return null
            if (arr.size > VOICI_DRAFT_MAX_IMAGES) return null
            val imgs = ArrayList<VoiciDraftImage>()
            for (ie in arr) {
                val im = VoiciJs.obj(ie) ?: return null
                if (!VoiciJs.exactKeysOpt(im, listOf("sha256", "data")) || !hex(im["sha256"], 32)) return null
                val bytes = WebEnvelopes.b64Decode(im["data"]) ?: return null
                if (bytes.size > VOICI_DRAFT_MAX_IMAGE_BYTES || WebEnvelopes.sha256Hex(bytes) != str(im["sha256"]) || !VoiciPage.isVoiciJpeg(bytes)) return null
                imgs.add(VoiciDraftImage(str(im["sha256"])!!, str(im["data"])!!))
            }
            out = out.copy(images = imgs)
        }
        return out
    }

    private fun draftAad(username: String, opId: String) = VoiciJs.utf8("$TAG_VOICI_DRAFT|$username|$opId")

    /** The voici-draft body: canonicalJson({suite:"flagship/voici-draft/v1", nonce:<hex 12>, ct:<b64>}). */
    fun sealVoiciDraft(draftsKey: ByteArray, username: String, op: VoiciDraftOp, nonce: ByteArray = random(12)): ByteArray {
        require(USERNAME.matches(username) && nonce.size == 12) { "$TAG_VOICI_DRAFT: bad input" }
        val json = op.toJson()
        requireNotNull(parseVoiciDraftOp(json)) { "$TAG_VOICI_DRAFT: malformed op" }
        val ct = VoiciJs.gcmEncrypt(draftsKey, nonce, draftAad(username, op.opId), WebEnvelopes.canonicalJsonBytes(json))
        return WebEnvelopes.canonicalJsonBytes(mapOf("suite" to TAG_VOICI_DRAFT, "nonce" to VoiciJs.hex(nonce), "ct" to WebEnvelopes.b64Encode(ct)))
    }

    /** {nonce, ct} of a canonical draft body, or null. */
    fun parseVoiciDraftBody(bodyBytes: ByteArray?): Pair<String, String>? {
        val text = VoiciJs.utf8Fatal(bodyBytes ?: return null) ?: return null
        val r = VoiciJs.obj(VoiciJs.parseJson(text)) ?: return null
        if (!VoiciJs.exactKeysOpt(r, listOf("suite", "nonce", "ct")) || str(r["suite"]) != TAG_VOICI_DRAFT || !hex(r["nonce"], 12) || WebEnvelopes.b64Decode(r["ct"]) == null) return null
        return if (canonicalText(r, text)) str(r["nonce"])!! to str(r["ct"])!! else null
    }

    /** Opens a draft body; the op's opId must equal the envelope's msgId (the AEAD binds both). */
    fun openVoiciDraft(draftsKey: ByteArray, username: String, opId: String, bodyBytes: ByteArray): VoiciDraftOp? {
        val (nonce, ct) = parseVoiciDraftBody(bodyBytes) ?: return null
        return try {
            val pt = VoiciJs.gcmDecrypt(draftsKey, WebEnvelopes.hexToBytes(nonce), draftAad(username, opId), WebEnvelopes.b64Decode(ct)!!)
            val op = parseVoiciDraftOp(VoiciJs.parseJson(VoiciJs.utf8Fatal(pt) ?: return null) ?: return null)
            if (op != null && op.opId == opId) op else null
        } catch (_: Exception) {
            null
        }
    }

    // ── Messages state blob (§10.1) ──

    fun emptyMessagesState(): MessagesState = MessagesState()

    fun parseMessagesState(v: JsonElement?): MessagesState? {
        val o = VoiciJs.obj(v) ?: return null
        if (!VoiciJs.isNumEq(o["v"], 1) || !VoiciJs.exactKeysOpt(o, listOf("v", "nicknames", "blocks", "accepted", "archived", "readUpTo", "signedInSites", "pendingOps"))) return null
        val nickObj = VoiciJs.obj(o["nicknames"]) ?: return null
        val readObj = VoiciJs.obj(o["readUpTo"]) ?: return null
        val nick = LinkedHashMap<String, MessagesNickname>()
        for ((k, ne) in nickObj) {
            val n = VoiciJs.obj(ne) ?: return null
            if (!hex(k, 32) || !VoiciJs.exactKeysOpt(n, listOf("name", "at")) || VoiciText.checkVoiciText(VoiciTextField.nickname, n["name"]) != null) return null
            nick[k] = MessagesNickname(str(n["name"])!!, VoiciJs.time(n["at"]) ?: return null)
        }
        fun list(e: JsonElement?, bytes: Int): List<String>? {
            val a = VoiciJs.arr(e) ?: return null
            return if (a.all { hex(it, bytes) }) a.map { str(it)!! } else null
        }
        val blocks = list(o["blocks"], 32) ?: return null
        val accepted = list(o["accepted"], 32) ?: return null
        val archived = list(o["archived"], 32) ?: return null
        val read = LinkedHashMap<String, String>()
        for ((k, m) in readObj) {
            if (!hex(k, 32) || !hex(m, 16)) return null
            read[k] = str(m)!!
        }
        val sitesArr = VoiciJs.arr(o["signedInSites"]) ?: return null
        val opsArr = VoiciJs.arr(o["pendingOps"]) ?: return null
        val sites = ArrayList<MessagesSignedInSite>()
        for (se in sitesArr) {
            val s = VoiciJs.obj(se) ?: return null
            if (!VoiciJs.exactKeysOpt(s, listOf("pageId", "delegatePub", "at"))) return null
            val pageId = str(s["pageId"])
            if (pageId == null || !PAGE_ID.matches(pageId) || !hex(s["delegatePub"], 65)) return null
            sites.add(MessagesSignedInSite(pageId, str(s["delegatePub"])!!, VoiciJs.time(s["at"]) ?: return null))
        }
        val ops = opsArr.map { parseVoiciDraftOp(it) ?: return null }
        return MessagesState(nick, blocks, accepted, archived, read, sites, ops)
    }

    /**
     * The compare-and-set merge (§10.1): sets are unions, the newer nickname wins (ties: local), readUpTo keeps the
     * local entry, signed-in sites union by delegatePub (newer at), pending ops union by opId. Sorted output.
     */
    fun mergeMessagesState(local: MessagesState, remote: MessagesState): MessagesState {
        val nicknames = LinkedHashMap(remote.nicknames)
        for ((k, n) in local.nicknames) {
            val cur = nicknames[k]
            if (cur == null || n.at >= cur.at) nicknames[k] = n
        }
        val sites = LinkedHashMap<String, MessagesSignedInSite>()
        for (s in remote.signedInSites + local.signedInSites) {
            val cur = sites[s.delegatePub]
            if (cur == null || s.at >= cur.at) sites[s.delegatePub] = s
        }
        val ops = LinkedHashMap<String, VoiciDraftOp>()
        for (o in remote.pendingOps + local.pendingOps) ops[o.opId] = o
        return MessagesState(
            nicknames = nicknames.toSortedMap(),
            blocks = (local.blocks + remote.blocks).distinct().sorted(),
            accepted = (local.accepted + remote.accepted).distinct().sorted(),
            archived = (local.archived + remote.archived).distinct().sorted(),
            readUpTo = (remote.readUpTo + local.readUpTo).toSortedMap(),
            signedInSites = sites.values.sortedBy { it.delegatePub },
            pendingOps = ops.values.sortedBy { it.opId },
        )
    }

    private fun stateAad(username: String, version: Long) = VoiciJs.utf8("$TAG_MESSAGES_STATE|$username|$version")

    fun sealMessagesState(stateKey: ByteArray, username: String, version: Long, s: MessagesState, nonce: ByteArray = random(12)): MessagesStateBlob {
        val json = s.toJson()
        require(USERNAME.matches(username) && isTime(version) && version >= 1 && nonce.size == 12 && parseMessagesState(json) != null) { "$TAG_MESSAGES_STATE: bad input" }
        val pt = WebEnvelopes.canonicalJsonBytes(json)
        require(pt.size <= VOICI_STATE_MAX_BYTES) { "$TAG_MESSAGES_STATE: too large" }
        return MessagesStateBlob(version, VoiciJs.hex(nonce), WebEnvelopes.b64Encode(VoiciJs.gcmEncrypt(stateKey, nonce, stateAad(username, version), pt)))
    }

    fun openMessagesState(stateKey: ByteArray, username: String, blob: JsonElement?): MessagesState? {
        val o = VoiciJs.obj(blob) ?: return null
        if (!VoiciJs.exactKeysOpt(o, listOf("version", "nonce", "ct")) || !hex(o["nonce"], 12)) return null
        val version = VoiciJs.time(o["version"]) ?: return null
        val ct = WebEnvelopes.b64Decode(o["ct"]) ?: return null
        if (ct.size > VOICI_STATE_MAX_BYTES + 16) return null
        return try {
            val pt = VoiciJs.gcmDecrypt(stateKey, WebEnvelopes.hexToBytes(str(o["nonce"])!!), stateAad(username, version), ct)
            parseMessagesState(VoiciJs.parseJson(VoiciJs.utf8Fatal(pt) ?: return null))
        } catch (_: Exception) {
            null
        }
    }

    // ── reports (§9.2) ──

    val VOICI_REPORT_REASONS: List<String> = listOf("spam", "harassment", "impersonation", "illegal", "other")

    /**
     * message: flagship/voici-report/v1|message|<pageId>|<H(canonicalJson(envelope))>|<reason>|<H(attached) or "">|<issuedAt>
     * page:    flagship/voici-report/v1|page|<username>|<seq>|<reason>|<H(UTF-8 note)>|<issuedAt>
     * `attached` is opaque sealed bytes here (base64); only its hash is signed.
     */
    fun canonicalVoiciReport(r: VoiciReport): ByteArray {
        fun bad(f: String): Nothing = throw IllegalArgumentException("$TAG_VOICI_REPORT: bad $f")
        when (r) {
            is VoiciMessageReport -> {
                if (r.reason !in VOICI_REPORT_REASONS || !isTime(r.issuedAt)) bad("field")
                needPageId(r.pageId)
                val att = if (r.attached == null) "" else WebEnvelopes.sha256Hex(WebEnvelopes.b64Decode(r.attached) ?: bad("attached"))
                return VoiciJs.utf8(
                    listOf(TAG_VOICI_REPORT, "message", r.pageId, WebEnvelopes.sha256Hex(WebEnvelopes.canonicalJsonBytes(r.envelope.toJson())), r.reason, att, r.issuedAt.toString()).joinToString("|"),
                )
            }
            is VoiciPageReport -> {
                if (r.reason !in VOICI_REPORT_REASONS || !isTime(r.issuedAt)) bad("field")
                if (!USERNAME.matches(r.username) || !isTime(r.seq) || r.seq < 1 || VoiciText.checkVoiciText(VoiciTextField.reportNote, r.note) != null) bad("field")
                return VoiciJs.utf8(listOf(TAG_VOICI_REPORT, "page", r.username, r.seq.toString(), r.reason, WebEnvelopes.sha256Hex(r.note), r.issuedAt.toString()).joinToString("|"))
            }
        }
    }

    fun signVoiciMessageReport(r: VoiciMessageReport, ownerSignSeed: ByteArray): String = VoiciJs.hex(VoiciJs.edSign(ownerSignSeed, canonicalVoiciReport(r)))

    fun verifyVoiciMessageReport(r: VoiciMessageReport, signature: String, ownerSignPub: String): Boolean = try {
        WebEnvelopes.ed25519VerifyHex(signature, canonicalVoiciReport(r), ownerSignPub)
    } catch (_: IllegalArgumentException) {
        false
    }

    // ── Sign in with Flagship over /qr-pipe (§6.1, §6.5) ──

    private val SIGN_IN_ORIGIN = Regex("^https://[a-z0-9.-]{1,253}$")

    /** Browser → app: {kind: TAG_VOICI_SIGN_IN_REQUEST, origin, pageId, username, delegatePub, nonce}. */
    fun parseVoiciSignInRequest(v: JsonElement?): VoiciSignInRequest? {
        val o = VoiciJs.obj(v) ?: return null
        if (!VoiciJs.exactKeysOpt(o, listOf("kind", "origin", "pageId", "username", "delegatePub", "nonce")) || str(o["kind"]) != TAG_VOICI_SIGN_IN_REQUEST) return null
        val origin = str(o["origin"]) ?: return null
        if (!SIGN_IN_ORIGIN.matches(origin)) return null
        val pageId = str(o["pageId"]) ?: return null
        val username = str(o["username"]) ?: return null
        if (!PAGE_ID.matches(pageId) || !USERNAME.matches(username)) return null
        if (!hex(o["delegatePub"], 65) || !str(o["delegatePub"])!!.startsWith("04") || !hex(o["nonce"], 16)) return null
        return VoiciSignInRequest(origin, pageId, username, str(o["delegatePub"])!!, str(o["nonce"])!!)
    }

    /**
     * The browser's check of the app's answer {kind: TAG_VOICI_SIGN_IN, pageId, pseudonymPub, attestation,
     * delegation, delegationSig, threadStmt, threadSig, threadSeed}: everything it will put in each message's cred
     * must already verify. Codes: malformed, bad-attestation, bad-delegation, bad-thread.
     */
    fun checkVoiciSignInAnswer(v: JsonElement?, request: VoiciSignInRequest, caKeys: Collection<String>, now: Long): VoiciOutcome<VoiciSignInAnswer> {
        val keys = listOf("kind", "pageId", "pseudonymPub", "attestation", "delegation", "delegationSig", "threadStmt", "threadSig", "threadSeed")
        val o = VoiciJs.obj(v) ?: return no("malformed")
        if (!VoiciJs.exactKeysOpt(o, keys) || str(o["kind"]) != TAG_VOICI_SIGN_IN || str(o["pageId"]) != request.pageId) return no("malformed")
        val ppub = str(o["pseudonymPub"])
        val threadSig = str(o["threadSig"])
        if (!hex(ppub, 32) || !hex(o["threadSeed"], 32) || threadSig == null) return no("malformed")
        val att = MessagesAttestations.checkMessagesKeyAttestation(o["attestation"], caKeys, now, ppub).valueOrNull() ?: return no("bad-attestation")
        val del = WebDelegations.checkWebDelegation(
            o["delegation"], str(o["delegationSig"]),
            WebDelegations.Want("voici-messages", request.origin, request.pageId, ppub!!, now, att.expiresAt),
        ).valueOrNull()
        if (del == null || del.delegatePub != request.delegatePub || del.nonce != request.nonce) return no("bad-delegation")
        val ts = parseVoiciThreadStatement(o["threadStmt"])
        if (ts == null || ts.pageId != request.pageId || ts.pseudonymPub != ppub) return no("bad-thread")
        if (!WebEnvelopes.ed25519VerifyHex(threadSig, canonicalVoiciThreadStatement(ts), ppub)) return no("bad-thread")
        val seed = str(o["threadSeed"])!!
        if (VoiciJs.hex(PqHybrid.hybridSealKeygen(WebEnvelopes.hexToBytes(seed)).publicKey) != ts.threadPub) return no("bad-thread")
        return VoiciOutcome.Ok(VoiciSignInAnswer(request.pageId, ppub, VoiciMessageCred(att, del, str(o["delegationSig"])!!, ts, threadSig), seed))
    }
}
