// The app's voi.ci logic that is not wire protocol (docs/voici-and-messages.md §5, §6, §7, §10): the owner's keys,
// the pieces a page state turns into, reading a published page back, the conversations the inbox builds, and the
// records the app signs (replies, drafts, blocks, reports, consumes, revokes, acks, the sign-in answer). Pure:
// VoiciCenter does the I/O and holds the keys only while it uses them.

package com.flagshipserver.app.core.voici

import com.flagshipserver.app.core.pq.PqHybrid
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.security.SecureRandom

/** The owner's per-page keys (§1): the inbox X-Wing key and the messages signing key, for one inbox epoch. */
class VoiciOwnerKeys(val pageId: String, val epoch: Long, val inbox: VoiciKeyPair, val sign: VoiciKeyPair) {
    val inboxPub: String get() = VoiciJs.hex(inbox.publicKey)
    val signPub: String get() = VoiciJs.hex(sign.publicKey)

    companion object {
        fun derive(umk: ByteArray, pageId: String, epoch: Long) = VoiciOwnerKeys(
            pageId, epoch,
            VoiciMessages.deriveVoiciInboxKey(umk, pageId, epoch),
            VoiciMessages.deriveVoiciOwnerSignKey(umk, pageId, epoch),
        )
    }
}

/** A visitor's keys toward one page (§6.2): pseudonym P (Ed25519) and thread key T (X-Wing). */
class VoiciVisitorKeys(val pageId: String, val pseudonym: VoiciKeyPair, val thread: VoiciKeyPair) {
    val pseudonymPub: String get() = VoiciJs.hex(pseudonym.publicKey)
    val threadPub: String get() = VoiciJs.hex(thread.publicKey)

    companion object {
        fun derive(umk: ByteArray, pageId: String): VoiciVisitorKeys {
            val secret = VoiciMessages.deriveMessagesSecret(umk)
            return VoiciVisitorKeys(pageId, VoiciMessages.deriveMessagesPseudonymKey(secret, pageId), VoiciMessages.deriveMessagesThreadKey(secret, pageId))
        }
    }
}

/** One piece of a page to publish: its role, bytes (null when only the published copy is known) and hash. */
class VoiciPlannedPiece(val role: String, val sha256: String, val size: Long, val bytes: ByteArray?, val contentType: String) {
    val ref: VoiciPieceRef get() = VoiciPieceRef(role, sha256, size)
}

@Serializable
data class StoredVoiciMessage(
    val msgId: String,
    val from: String,
    val seq: Long,
    val sentAt: Long,
    val text: String,
    val replyTo: String? = null,
    /** True for the owner's replies (any of the owner's devices). */
    val mine: Boolean = false,
    /** "sent" (`.com` stored it), "delivered" (an owner device fetched it), "direct" (the phone acked it). */
    val status: String = "sent",
    /** The envelope as received, kept so the owner can report it. */
    val envelope: JsonObject? = null,
)

@Serializable
data class StoredVoiciConversation(
    val conv: String,
    val pageId: String,
    val pseudonymPub: String,
    val threadPub: String,
    val messages: List<StoredVoiciMessage> = emptyList(),
) {
    val visitorMessages: List<StoredVoiciMessage> get() = messages.filter { !it.mine }
    val lastAt: Long get() = messages.maxOfOrNull { it.sentAt } ?: 0
    val ordered: List<StoredVoiciMessage> get() = messages.sortedWith(compareBy({ it.sentAt }, { it.msgId }))

    /** A gap in the visitor's `seq` (§7.3): "Some messages haven't arrived yet". */
    val hasGap: Boolean get() {
        val seqs = visitorMessages.map { it.seq }.sorted()
        return seqs.isNotEmpty() && (seqs.first() != 1L || seqs.zipWithNext().any { (a, b) -> b != a + 1 })
    }
}

/** How a mailbox item was handled. */
sealed class VoiciInboxOutcome {
    data class Added(val conv: StoredVoiciConversation, val message: StoredVoiciMessage) : VoiciInboxOutcome()
    data class Dropped(val code: String) : VoiciInboxOutcome()
}

object VoiciOwner {
    private val rng = SecureRandom()
    fun randomHex(bytes: Int): String = VoiciJs.hex(ByteArray(bytes).also(rng::nextBytes))

    fun defaultProfile(displayName: String) = VoiciProfile(
        displayName = displayName.take(64).ifEmpty { "Flagship" },
        bio = "",
        avatar = null,
        theme = "classic",
        links = emptyList(),
    )

    fun emptyState(displayName: String) = VoiciPageState(defaultProfile(displayName), 0, emptyList(), 0)

    // ── page state ⇄ JSON (local storage only) ──

    fun parsePageState(o: JsonObject?): VoiciPageState? {
        o ?: return null
        val profile = VoiciPage.parseVoiciProfile(o["profile"]) ?: return null
        val accepts = VoiciJs.safeInt(o["acceptsMessages"])?.toInt() ?: return null
        val chunks = VoiciJs.arr(o["chunks"])?.map { c -> VoiciJs.arr(c)?.map { VoiciPage.parseVoiciPost(it) ?: return null } ?: return null } ?: return null
        return VoiciPageState(profile, accepts, chunks, VoiciJs.time(o["issuedAt"]) ?: 0)
    }

    // ── pieces ──

    fun profileBytes(p: VoiciProfile): ByteArray = WebEnvelopes.canonicalJsonBytes(p.toJson())
    fun chunkBytes(n: Int, posts: List<VoiciPost>): ByteArray = WebEnvelopes.canonicalJsonBytes(VoiciChunk(n, posts).toJson())

    /** The images a state names: the avatar and every card image. */
    fun imageShas(state: VoiciPageState): Set<String> {
        val out = LinkedHashSet<String>()
        state.profile.avatar?.let(out::add)
        for (c in state.chunks) for (p in c) for (l in p.links) l.card?.image?.let(out::add)
        return out
    }

    /**
     * Every piece of [state]: profile, avatar, chunk-n, card-<prefix>. An image's bytes come from [image]; one
     * that is only in the [published] index keeps its listed size (it is already stored). Throws when an image is
     * nowhere.
     */
    fun planPieces(state: VoiciPageState, image: (String) -> ByteArray?, published: List<VoiciPieceRef> = emptyList()): List<VoiciPlannedPiece> {
        val known = published.associateBy { it.sha256 }
        val out = ArrayList<VoiciPlannedPiece>()
        val profile = profileBytes(state.profile)
        out += VoiciPlannedPiece("profile", WebEnvelopes.sha256Hex(profile), profile.size.toLong(), profile, "application/json")
        fun img(role: String, sha: String) {
            val b = image(sha)
            if (b != null) {
                require(WebEnvelopes.sha256Hex(b) == sha) { "image hash" }
                out += VoiciPlannedPiece(role, sha, b.size.toLong(), b, "image/jpeg")
            } else {
                val ref = requireNotNull(known[sha]) { "missing image $sha" }
                out += VoiciPlannedPiece(role, sha, ref.size, null, "image/jpeg")
            }
        }
        state.profile.avatar?.let { img("avatar", it) }
        state.chunks.forEachIndexed { i, posts ->
            val b = chunkBytes(i, posts)
            out += VoiciPlannedPiece("chunk-$i", WebEnvelopes.sha256Hex(b), b.size.toLong(), b, "application/json")
        }
        val cards = LinkedHashSet<String>()
        for (c in state.chunks) for (p in c) for (l in p.links) l.card?.image?.let(cards::add)
        for (sha in cards) img(VoiciPage.voiciCardRole(sha), sha)
        return out
    }

    /** A published index's pieces read back into a page state ([fetch] returns a piece's bytes, checked here). */
    fun readPublished(index: VoiciPageIndex, fetch: (VoiciPieceRef) -> ByteArray?): VoiciPageState? {
        fun get(ref: VoiciPieceRef): ByteArray? = fetch(ref)?.takeIf { it.size.toLong() == ref.size && WebEnvelopes.sha256Hex(it) == ref.sha256 }
        val byRole = index.body.pieces.associateBy { it.role }
        val profile = byRole["profile"]?.let(::get)?.let(VoiciPage::parseVoiciProfilePiece) ?: return null
        val n = index.body.pieces.count { it.role.startsWith("chunk-") }
        val chunks = (0 until n).map { i -> byRole["chunk-$i"]?.let(::get)?.let { VoiciPage.parseVoiciChunkPiece(it, i) } }
        if (!VoiciPage.voiciPieceRefsOk(index.body, profile, chunks)) return null
        return VoiciPageState(profile, index.body.acceptsMessages, chunks.map { it!!.posts }, index.body.issuedAt)
    }

    // ── the inbox (§7, §12.1) ──

    /**
     * One stored envelope, verified then opened, into [convs]. History is checked at its own `sentAt` (the 10-minute
     * window applies only where a message is received for sending). [inboxSeeds] are the owner's inbox seeds by
     * epoch (newest first); [ownerSignPubs] the owner's signing keys of those epochs.
     */
    fun readInboxItem(
        envelope: JsonObject,
        pageId: String,
        origin: String,
        caKeys: Collection<String>,
        blocked: Set<String>,
        revoked: Set<String>,
        inboxSeeds: List<ByteArray>,
        ownerSignPubs: List<String>,
        convs: Map<String, StoredVoiciConversation>,
        status: String,
    ): VoiciInboxOutcome {
        val kind = VoiciJs.str(envelope["kind"])
        val sentAt = VoiciJs.time(envelope["sentAt"]) ?: return VoiciInboxOutcome.Dropped("malformed")
        when (kind) {
            "voici-message" -> {
                val ctx = VoiciMessageCheckContext(pageId, true, origin, caKeys, sentAt, blocked, revoked)
                val ok = VoiciMessages.checkVoiciMessage(envelope, ctx)
                val c = ok.valueOrNull() ?: return VoiciInboxOutcome.Dropped(ok.code)
                val env = c.envelope
                val existing = convs[env.conv]
                if (existing?.messages?.any { it.msgId == env.msgId } == true) return VoiciInboxOutcome.Dropped("duplicate")
                if (existing?.visitorMessages?.any { it.seq == env.seq } == true) return VoiciInboxOutcome.Dropped("replayed-seq")
                val body = WebEnvelopes.b64Decode(env.bodyB64) ?: return VoiciInboxOutcome.Dropped("malformed")
                val pt = open(body, env.conv, env.msgId, inboxSeeds) ?: return VoiciInboxOutcome.Dropped("decrypt-failed")
                val msg = StoredVoiciMessage(env.msgId, env.from, env.seq, env.sentAt, pt.text, pt.replyTo, mine = false, status = status, envelope = envelope)
                val conv = (existing ?: StoredVoiciConversation(env.conv, pageId, env.from, c.cred.threadStmt.threadPub)).let { it.copy(messages = it.messages + msg) }
                return VoiciInboxOutcome.Added(conv, msg)
            }
            "voici-reply" -> {
                val conv = VoiciJs.str(envelope["conv"]) ?: return VoiciInboxOutcome.Dropped("malformed")
                val existing = convs[conv] ?: return VoiciInboxOutcome.Dropped("unknown-conv")
                val from = VoiciJs.str(envelope["from"])
                if (from !in ownerSignPubs) return VoiciInboxOutcome.Dropped("bad-signature")
                val ok = VoiciMessages.checkVoiciReply(envelope, pageId, from!!, conv)
                val env = ok.valueOrNull()?.envelope ?: return VoiciInboxOutcome.Dropped(ok.code)
                if (existing.messages.any { it.msgId == env.msgId }) return VoiciInboxOutcome.Dropped("duplicate")
                val body = WebEnvelopes.b64Decode(env.bodyB64) ?: return VoiciInboxOutcome.Dropped("malformed")
                val pt = open(body, conv, env.msgId, inboxSeeds) ?: return VoiciInboxOutcome.Dropped("decrypt-failed")
                val msg = StoredVoiciMessage(env.msgId, env.from, env.seq, env.sentAt, pt.text, pt.replyTo, mine = true, status = "sent")
                return VoiciInboxOutcome.Added(existing.copy(messages = existing.messages + msg), msg)
            }
            else -> return VoiciInboxOutcome.Dropped("wrong-kind")
        }
    }

    private fun open(body: ByteArray, conv: String, msgId: String, seeds: List<ByteArray>): VoiciPlaintext? {
        for (s in seeds) VoiciMessages.openVoiciBody(body, conv, msgId, s).valueOrNull()?.let { return it }
        return null
    }

    // ── what the owner signs ──

    /** A reply (§7.4): sealed to the visitor's T and the owner's own inbox key, signed by the owner signing key. */
    fun reply(keys: VoiciOwnerKeys, conv: StoredVoiciConversation, text: String, replyTo: String?, pageSeq: Long, now: Long): WebEnvelope {
        val msgId = randomHex(16)
        val seq = (conv.messages.filter { it.mine && it.from == keys.signPub }.maxOfOrNull { it.seq } ?: 0) + 1
        val body = VoiciMessages.sealVoiciBody(
            conv.conv, msgId, now, keys.signPub,
            listOf(WebEnvelopes.hexToBytes(conv.threadPub), keys.inbox.publicKey),
            VoiciPlaintext(text, replyTo),
        )
        val env = WebEnvelope("voici-reply", keys.pageId, conv.conv, keys.signPub, msgId, seq, now, WebEnvelopes.b64Encode(body), JsonObject(mapOf("pageSeq" to JsonPrimitive(pageSeq))))
        return WebEnvelopes.signWebEnvelopeEd25519(env, keys.sign.seed)
    }

    /** A draft op (§5.2) as a `voici-draft` envelope signed by the device key, with its grant as the cred. */
    fun draftEnvelope(draftsKey: ByteArray, username: String, op: VoiciDraftOp, devicePub: String, sign: (ByteArray) -> ByteArray, grant: JsonObject, grantSignature: String, seq: Long): WebEnvelope {
        val body = VoiciMessages.sealVoiciDraft(draftsKey, username, op)
        val cred = JsonObject(mapOf("grant" to grant, "grantSignature" to JsonPrimitive(grantSignature)))
        val env = WebEnvelope("voici-draft", username, "", devicePub, op.opId, seq, op.at, WebEnvelopes.b64Encode(body), cred, sigAlg = "ed25519")
        return env.copy(sig = VoiciJs.hex(sign(WebEnvelopes.canonicalWebEnvelope(env))))
    }

    fun blockBody(keys: VoiciOwnerKeys, pseudonymPub: String, block: Boolean, now: Long): JsonObject {
        val b = VoiciBlock(keys.pageId, pseudonymPub, if (block) "block" else "unblock", now)
        return JsonObject(
            mapOf(
                "block" to JsonObject(linkedMapOf("pageId" to JsonPrimitive(b.pageId), "pseudonymPub" to JsonPrimitive(b.pseudonymPub), "op" to JsonPrimitive(b.op), "issuedAt" to JsonPrimitive(b.issuedAt))),
                "signature" to JsonPrimitive(VoiciMessages.signVoiciBlock(b, keys.sign.seed)),
            ),
        )
    }

    /**
     * A message report (§9.2) by the owner, flat as `.com` takes it: {kind:"message", pageId, envelope, reason,
     * attached, issuedAt, signature}. The app does not seal the text to the abuse key (`attached` null).
     */
    fun reportBody(keys: VoiciOwnerKeys, envelope: JsonObject, reason: String, now: Long): JsonObject? {
        val env = WebEnvelopes.parseWebEnvelope(envelope) ?: return null
        val r = VoiciMessageReport(keys.pageId, env, reason, null, now)
        val sig = VoiciMessages.signVoiciMessageReport(r, keys.sign.seed)
        return JsonObject(
            linkedMapOf(
                "kind" to JsonPrimitive("message"), "pageId" to JsonPrimitive(r.pageId), "envelope" to env.toJson(),
                "reason" to JsonPrimitive(reason), "attached" to kotlinx.serialization.json.JsonNull, "issuedAt" to JsonPrimitive(now),
                "signature" to JsonPrimitive(sig),
            ),
        )
    }

    const val TAG_DRAFTS_CONSUME = "flagship/voici-drafts-consume/v1"

    /** `flagship/voici-drafts-consume/v1|<u>|<opIds sorted, joined ,>|<issuedAt>` (packages/protocol voiciDraftsConsume.ts), by the sensitive key. */
    fun canonicalConsume(username: String, opIds: List<String>, issuedAt: Long): ByteArray =
        VoiciJs.utf8(listOf(TAG_DRAFTS_CONSUME, username, opIds.sorted().joinToString(","), issuedAt.toString()).joinToString("|"))

    /** Wire `{consume:{username, opIds, issuedAt}, signature}` (voiciDraftsConsume.ts); 1 to 200 ids. */
    fun consumeBody(username: String, opIds: List<String>, issuedAt: Long, sensitiveSeed: ByteArray): JsonObject = JsonObject(
        mapOf(
            "consume" to JsonObject(
                linkedMapOf("username" to JsonPrimitive(username), "opIds" to JsonArray(opIds.sorted().map { JsonPrimitive(it) }), "issuedAt" to JsonPrimitive(issuedAt)),
            ),
            "signature" to JsonPrimitive(VoiciJs.hex(VoiciJs.edSign(sensitiveSeed, canonicalConsume(username, opIds, issuedAt)))),
        ),
    )

    /** `{revoke:{delegatePub, issuedAt}, principalPub, signature}` (§6.4; B1 finds the page from P's stored messages). */
    fun revokeBody(visitor: VoiciVisitorKeys, delegatePub: String, now: Long): JsonObject {
        val r = WebDelegationRevoke(delegatePub, now)
        return JsonObject(
            mapOf(
                "revoke" to r.toJson(),
                "principalPub" to JsonPrimitive(visitor.pseudonymPub),
                "signature" to JsonPrimitive(WebDelegations.signWebDelegationRevoke(r, visitor.pseudonym.seed)),
            ),
        )
    }

    // ── the device grant behind a draft ──

    /** Does [grant] (as listed by `/device-grants`) name [devicePub] of [username], live, signed by the account? */
    fun grantOk(grant: JsonElement?, grantSignature: String, devicePub: String, username: String, account: com.flagshipserver.app.api.VoiciAccountKeys, now: Long): Boolean {
        val g = VoiciJs.obj(grant) ?: return false
        val grantId = VoiciJs.str(g["grantId"]) ?: return false
        val user = VoiciJs.str(g["username"]) ?: return false
        val deviceId = VoiciJs.str(g["deviceId"]) ?: return false
        val pub = VoiciJs.str(g["devicePubHex"]) ?: return false
        val scopes = VoiciJs.arr(g["scopes"])?.map { VoiciJs.str(it) ?: return false } ?: return false
        val issuedAt = VoiciJs.time(g["issuedAt"]) ?: return false
        val expiresAt = VoiciJs.time(g["expiresAt"]) ?: return false
        if (!user.equals(username, true) || pub.lowercase() != devicePub || expiresAt <= now) return false
        val bytes = runCatching {
            com.flagshipserver.app.core.DeviceCapabilityGrant.canonicalBytes(grantId, user, deviceId, pub, scopes, issuedAt, expiresAt)
        }.getOrNull() ?: return false
        val signers = listOfNotNull(account.adminRootPub, account.irkPub)
        return signers.any { WebEnvelopes.ed25519VerifyHex(grantSignature, bytes, it) }
    }

    /** The cred shape of a `/device-grants` row: {grant:{...without signature}, signature}. */
    fun grantCred(row: JsonObject): Pair<JsonObject, String>? {
        val sig = VoiciJs.str(row["signatureHex"]) ?: return null
        val grant = JsonObject(row.filterKeys { it != "signatureHex" && it != "signerRoot" })
        return grant to sig
    }

    // ── the phone ack ──

    fun ack(conv: String, msgId: String, receivedAt: Long, phoneRoutePub: String, seed: ByteArray): VoiciAck =
        VoiciMessages.signVoiciAck(VoiciAck(conv, msgId, receivedAt, phoneRoutePub), seed)

    // ── Sign in with Flagship (§6.5) ──

    const val SIGN_IN_BACKDATE_MS = 5L * 60_000

    // ── reply notices (visitor side): the app reads its own thread like a browser would ──

    const val TAG_VOICI_THREAD_FETCH = "flagship/voici-thread-fetch/v1"
    private val CURSOR = Regex("^[A-Za-z0-9_-]{0,64}$")

    /** `flagship/voici-thread-fetch/v1|<conv>|<since>|<issuedAt>` (voiciMessages.ts canonicalVoiciThreadFetch). */
    fun canonicalThreadFetch(conv: String, since: String, issuedAt: Long): ByteArray {
        require(WebEnvelopes.isLowerHex(conv, 32) && CURSOR.matches(since) && issuedAt >= 0) { "$TAG_VOICI_THREAD_FETCH: bad field" }
        return VoiciJs.utf8(listOf(TAG_VOICI_THREAD_FETCH, conv, since, issuedAt.toString()).joinToString("|"))
    }

    /**
     * The app's own reader key toward a page (P-256), the same on every device of the account and on iOS:
     * HKDF-SHA256(messagesSecret, salt empty, "flagship/voici-app-reader/v1|<pageId>", 32). P delegates to it; the
     * account key never signs a thread fetch.
     */
    fun readerKey(messagesSecret: ByteArray, pageId: String): ByteArray = VoiciJs.hkdf32(messagesSecret, "flagship/voici-app-reader/v1|$pageId")

    /** The thread-fetch body {conv, since, issuedAt, sig, cred} under P's delegation to the reader key (iOS's shape). */
    fun threadFetchBody(visitor: VoiciVisitorKeys, att: MessagesKeyAttestation, readerPriv: ByteArray, since: String, now: Long): JsonObject {
        val conv = VoiciMessages.voiciConv(visitor.pageId, visitor.pseudonymPub)
        val nonce = WebEnvelopes.sha256Hex("${visitor.pageId}|${att.issuedAt}").take(32)
        val d = WebDelegation("voici-messages", com.flagshipserver.app.core.Endpoints.voiciOrigin, visitor.pageId, visitor.pseudonymPub, "p256",
            VoiciJs.hex(VoiciJs.p256PublicKey(readerPriv)), att.issuedAt, att.expiresAt, nonce)
        val cred = JsonObject(linkedMapOf("attestation" to att.toJson(), "delegation" to d.toJson(), "delegationSig" to JsonPrimitive(WebDelegations.signWebDelegation(d, visitor.pseudonym.seed))))
        return JsonObject(
            linkedMapOf(
                "conv" to JsonPrimitive(conv), "since" to JsonPrimitive(since), "issuedAt" to JsonPrimitive(now),
                "sig" to JsonPrimitive(VoiciJs.hex(VoiciJs.p256Sign(readerPriv, canonicalThreadFetch(conv, since, now)))), "cred" to cred,
            ),
        )
    }

    fun signInAnswer(
        req: VoiciSignInRequest,
        visitor: VoiciVisitorKeys,
        attestation: JsonObject,
        attestationExpiresAt: Long,
        now: Long,
    ): JsonObject {
        // E: issued 5 minutes back, so a browser or `.com` whose clock runs behind this phone's still finds them valid.
        val issued = maxOf(0L, now - SIGN_IN_BACKDATE_MS)
        val d = WebDelegation("voici-messages", req.origin, req.pageId, visitor.pseudonymPub, "p256", req.delegatePub, issued, attestationExpiresAt, req.nonce)
        val ts = VoiciThreadStatement(req.pageId, visitor.pseudonymPub, visitor.threadPub, issued)
        return JsonObject(
            linkedMapOf(
                "kind" to JsonPrimitive(VoiciMessages.TAG_VOICI_SIGN_IN),
                "pageId" to JsonPrimitive(req.pageId),
                "pseudonymPub" to JsonPrimitive(visitor.pseudonymPub),
                "attestation" to attestation,
                "delegation" to d.toJson(),
                "delegationSig" to JsonPrimitive(WebDelegations.signWebDelegation(d, visitor.pseudonym.seed)),
                "threadStmt" to ts.toJson(),
                "threadSig" to JsonPrimitive(VoiciMessages.signVoiciThreadStatement(ts, visitor.pseudonym.seed)),
                "threadSeed" to JsonPrimitive(VoiciJs.hex(visitor.thread.seed)),
            ),
        )
    }

    /** The attestation request (§6.3) and its signature by the account device key. */
    fun attestationRequest(username: String, visitor: VoiciVisitorKeys, renewOfHash: String, deviceCheckRef: String, now: Long, deviceSeedSign: (ByteArray) -> ByteArray): Pair<JsonObject, String> {
        val r = MessagesKeyAttestationRequest(username, visitor.pseudonymPub, renewOfHash, deviceCheckRef, now)
        val bytes = MessagesAttestations.canonicalMessagesKeyAttestationRequest(r)
        val json = JsonObject(
            linkedMapOf(
                "username" to JsonPrimitive(r.username), "pseudonymPub" to JsonPrimitive(r.pseudonymPub), "renewOfHash" to JsonPrimitive(r.renewOfHash),
                "deviceCheckRef" to JsonPrimitive(r.deviceCheckRef), "issuedAt" to JsonPrimitive(r.issuedAt),
            ),
        )
        return json to VoiciJs.hex(deviceSeedSign(bytes))
    }

    fun requestHash(request: JsonObject): String {
        val r = MessagesKeyAttestationRequest(
            VoiciJs.str(request["username"])!!, VoiciJs.str(request["pseudonymPub"])!!, VoiciJs.str(request["renewOfHash"])!!,
            VoiciJs.str(request["deviceCheckRef"])!!, VoiciJs.time(request["issuedAt"])!!,
        )
        return WebEnvelopes.sha256Hex(MessagesAttestations.canonicalMessagesKeyAttestationRequest(r))
    }

    /** Is the thread seed's public key the statement's (the browser checks it too)? */
    fun threadSeedMatches(seedHex: String, threadPub: String): Boolean =
        VoiciJs.hex(PqHybrid.hybridSealKeygen(WebEnvelopes.hexToBytes(seedHex)).publicKey) == threadPub
}
