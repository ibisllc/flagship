// An in-process `.com` for voi.ci pages and Messages (docs/voici-and-messages.md §3, §6.3, §8.3), for the UI gym
// and unit tests. It runs the same checks the real routes do (chunk A's functions), keeps pages, pieces, drafts,
// the mailbox and the state blob in memory, signs attestations with a throwaway CA key, and can play visitors: a
// browser that signed in and writes to a page.

package com.flagshipserver.app.api

import com.flagshipserver.app.core.voici.MessagesAttestations
import com.flagshipserver.app.core.voici.VoiciJs
import com.flagshipserver.app.core.voici.VoiciMessages
import com.flagshipserver.app.core.voici.VoiciOwner
import com.flagshipserver.app.core.voici.VoiciPage
import com.flagshipserver.app.core.voici.VoiciPageRemove
import com.flagshipserver.app.core.voici.VoiciPieceUpload
import com.flagshipserver.app.core.voici.VoiciPlaintext
import com.flagshipserver.app.core.voici.VoiciThreadStatement
import com.flagshipserver.app.core.voici.VoiciVisitorKeys
import com.flagshipserver.app.core.voici.WebDelegation
import com.flagshipserver.app.core.voici.WebDelegations
import com.flagshipserver.app.core.voici.WebEnvelope
import com.flagshipserver.app.core.voici.WebEnvelopes
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

class MockVoiciClient(
    var now: () -> Long = System::currentTimeMillis,
    val caSeed: ByteArray = ByteArray(32) { 0x5C },
) : VoiciClient {
    val caPub: String get() = VoiciJs.hex(VoiciJs.edPub(caSeed))

    val accounts = HashMap<String, VoiciAccountKeys>()
    val grants = HashMap<String, List<JsonObject>>()
    private val pages = HashMap<String, JsonObject>()
    val pieces = HashMap<String, ByteArray>()
    val drafts = HashMap<String, MutableList<VoiciDraftItem>>()
    val inbox = HashMap<String, MutableList<VoiciInboxItem>>()
    val blocks = HashMap<String, MutableSet<String>>()
    val revoked = HashSet<String>()
    /** A refusal the next revoke answers with (status, code). */
    var revokeRefusal: Pair<Int, String>? = null
    val revokeBodies = ArrayList<JsonObject>()
    /** Conversations an `unblock` order accepted (B1: lifts the awaiting-reply cap). */
    val accepted = HashSet<String>()
    val reports = ArrayList<JsonObject>()
    val attestRequests = ArrayList<JsonObject>()
    val states = HashMap<String, JsonObject>()
    val sent = ArrayList<JsonObject>()
    val consumed = ArrayList<String>()
    var publishCount = 0
    /** A refusal the next attest answers with (e.g. "first-contact-limit"). */
    var attestRefusal: String? = null
    var takenDown = HashSet<String>()
    /** Pages their owner took down: the removal's seq and pageId (the ladder continues from them). */
    val removed = HashMap<String, Pair<Long, String>>()
    val removals = ArrayList<JsonObject>()

    @Synchronized fun storedIndex(username: String): JsonObject? = pages[username]

    override suspend fun accountKeys(username: String) = accounts[username]

    override suspend fun page(username: String): JsonObject? = synchronized(this) { if (username in removed) null else pages[username] }

    override suspend fun piece(username: String, pageId: String, sha256: String): ByteArray? = synchronized(this) { pieces["$pageId/$sha256"] }

    private fun refuse(status: Int, code: String, extra: Map<String, JsonElement> = emptyMap()): Nothing =
        throw VoiciHttpError(status, code, JsonObject(mapOf("error" to JsonPrimitive(code), "code" to JsonPrimitive(code)) + extra))

    override suspend fun uploadPiece(username: String, pageId: String, sha256: String, size: Long, issuedAt: Long, signerPub: String, signature: String, bytes: ByteArray, contentType: String) {
        val acc = accounts[username] ?: refuse(404, "not-found")
        if (signerPub != acc.sensitivePub) refuse(403, "not-sensitive-key")
        if (!VoiciPage.verifyVoiciPieceUpload(VoiciPieceUpload(username, pageId, sha256, size, issuedAt), signature, signerPub)) refuse(403, "bad-signature")
        if (bytes.size.toLong() != size || WebEnvelopes.sha256Hex(bytes) != sha256) refuse(400, "bad-piece")
        synchronized(this) { pieces["$pageId/$sha256"] = bytes }
    }

    override suspend fun publish(username: String, index: JsonObject): JsonObject = synchronized(this) {
        val acc = accounts[username] ?: refuse(404, "not-found")
        if (username in takenDown) refuse(403, "taken-down")
        val stored = pages[username]?.let(VoiciPage::parseVoiciPageIndex)
        val gone = removed[username]
        val storedSeq = maxOf(stored?.body?.seq ?: 0, gone?.first ?: 0)
        val storedPageId = stored?.body?.pageId ?: gone?.second
        val r = VoiciPage.checkVoiciPublish(index, username, acc.sensitiveKind, acc.sensitivePub, storedSeq, storedPageId, now())
        // As `.com`: a seq-conflict names the stored index, seq, pageId and whether the page was removed.
        val idx = r.valueOrNull() ?: when (r.code) {
            "seq-conflict" -> refuse(409, "seq-conflict", conflictBody(username))
            "wrong-page" -> refuse(409, "wrong-page", mapOf("pageId" to JsonPrimitive(storedPageId)))
            else -> refuse(400, r.code)
        }
        for (p in idx.body.pieces) {
            val b = pieces["${idx.body.pageId}/${p.sha256}"] ?: refuse(400, "missing-piece")
            if (b.size.toLong() != p.size) refuse(400, "bad-piece")
        }
        removed.remove(username)
        pages[username] = index
        publishCount++
        index
    }

    private fun conflictBody(username: String): Map<String, JsonElement> {
        val stored = pages[username]?.let(VoiciPage::parseVoiciPageIndex)
        val gone = removed[username]
        return mapOf(
            "index" to (pages[username] ?: kotlinx.serialization.json.JsonNull),
            "seq" to JsonPrimitive(maxOf(stored?.body?.seq ?: 0, gone?.first ?: 0)),
            "pageId" to JsonPrimitive(stored?.body?.pageId ?: gone?.second),
            "removed" to JsonPrimitive(gone != null),
        )
    }

    /** `.com`'s removal check (checkVoiciPageRemove) against the stored page; already removed answers not-found. */
    override suspend fun removePage(username: String, remove: JsonObject): Unit = synchronized(this) {
        val acc = accounts[username] ?: refuse(404, "not-found")
        if (username in removed) refuse(404, "not-found")
        val stored = pages[username]?.let(VoiciPage::parseVoiciPageIndex) ?: refuse(404, "not-found")
        val r = VoiciPageRemove.check(remove, username, acc.sensitiveKind, acc.sensitivePub, stored.body.seq, stored.body.pageId, now())
        val ok = r.valueOrNull() ?: when (r.code) {
            "seq-conflict" -> refuse(409, "seq-conflict", conflictBody(username))
            "wrong-page" -> refuse(409, "wrong-page", mapOf("pageId" to JsonPrimitive(stored.body.pageId)))
            "malformed" -> refuse(400, "malformed")
            else -> refuse(403, r.code)
        }
        removed[username] = ok.seq to ok.pageId
        removals += remove
    }

    override suspend fun depositDraft(username: String, device: VoiciDeviceSigner, envelope: JsonObject) {
        synchronized(this) { drafts.getOrPut(username) { ArrayList() }.add(VoiciDraftItem(envelope, now())) }
    }

    override suspend fun drafts(username: String): List<VoiciDraftItem> = synchronized(this) { drafts[username].orEmpty().toList() }

    override suspend fun consumeDrafts(username: String, body: JsonObject) {
        val acc = accounts[username] ?: refuse(404, "not-found")
        val c = body["consume"] as JsonObject
        if (VoiciJs.str(c["username"]) != username) refuse(400, "malformed")
        val ids = (c["opIds"] as JsonArray).map { (it as JsonPrimitive).content }
        val at = (c["issuedAt"] as JsonPrimitive).content.toLong()
        val sig = (body["signature"] as JsonPrimitive).content
        if (!WebEnvelopes.ed25519VerifyHex(sig, VoiciOwner.canonicalConsume(username, ids, at), acc.sensitivePub)) refuse(403, "bad-signature")
        synchronized(this) {
            consumed += ids
            drafts[username]?.removeAll { VoiciJs.str(it.envelope["msgId"]) in ids }
        }
    }

    override suspend fun inbox(username: String, since: String): VoiciInboxPage = synchronized(this) {
        val all = inbox[username].orEmpty()
        val from = since.toIntOrNull() ?: 0
        VoiciInboxPage(all.drop(from), all.size.toString(), blocks[username].orEmpty().toList(), revoked.toList())
    }

    private fun ownerOf(pageId: String): String? = pages.entries.firstOrNull { VoiciJs.str(it.value["pageId"]) == pageId }?.key

    override suspend fun send(envelope: JsonObject, direct: Boolean) = synchronized(this) {
        val audience = VoiciJs.str(envelope["audience"]) ?: refuse(400, "malformed")
        val owner = ownerOf(audience) ?: refuse(404, "not-found")
        val idx = VoiciPage.parseVoiciPageIndex(pages[owner])!!
        when (VoiciJs.str(envelope["kind"])) {
            "voici-reply" -> if (VoiciMessages.checkVoiciReply(envelope, audience, idx.body.ownerSignPub).ok.not()) refuse(403, "bad-signature")
            "voici-message" -> {
                if (VoiciJs.str(envelope["from"]) in blocks[owner].orEmpty()) return@synchronized
            }
            else -> refuse(400, "malformed")
        }
        val list = inbox.getOrPut(owner) { ArrayList() }
        if (list.any { VoiciJs.str(it.envelope["msgId"]) == VoiciJs.str(envelope["msgId"]) }) return@synchronized
        list += VoiciInboxItem(envelope, now(), fetched = false, direct = direct)
        sent += envelope
    }

    override suspend fun block(username: String, body: JsonObject) {
        val b = VoiciMessages.parseVoiciBlock(body["block"]) ?: refuse(400, "malformed")
        synchronized(this) {
            val set = blocks.getOrPut(username) { HashSet() }
            if (b.op == "block") set += b.pseudonymPub else {
                set -= b.pseudonymPub
                accepted += VoiciMessages.voiciConv(b.pageId, b.pseudonymPub)
            }
        }
    }

    override suspend fun revoke(body: JsonObject) {
        revokeRefusal?.let { (status, code) -> revokeRefusal = null; refuse(status, code) }
        synchronized(this) { revokeBodies += body }
        val r = WebDelegations.parseWebDelegationRevoke(body["revoke"]) ?: refuse(400, "malformed")
        val p = VoiciJs.str(body["principalPub"]) ?: refuse(400, "malformed")
        if (!WebDelegations.verifyWebDelegationRevoke(r, VoiciJs.str(body["signature"]) ?: "", p)) refuse(403, "bad-signature")
        synchronized(this) { revoked += r.delegatePub }
    }

    override suspend fun report(body: JsonObject) {
        if (VoiciJs.str(body["kind"]) != "message" || body.keys != setOf("kind", "pageId", "envelope", "reason", "attached", "issuedAt", "signature")) refuse(400, "malformed")
        synchronized(this) { reports += body }
    }

    override suspend fun messagesState(username: String): JsonObject? = synchronized(this) { states[username] }

    override suspend fun putMessagesState(username: String, device: VoiciDeviceSigner, blob: JsonObject) = synchronized(this) {
        val stored = states[username]?.let { VoiciJs.time(it["version"]) } ?: 0
        if (VoiciJs.time(blob["version"]) != stored + 1) refuse(409, "version-conflict", states[username]?.let { mapOf("state" to it) } ?: emptyMap())
        states[username] = blob
    }

    override suspend fun attest(username: String, device: VoiciDeviceSigner, body: JsonObject): JsonObject {
        attestRefusal?.let { refuse(429, it, mapOf("retryAfterSec" to JsonPrimitive(7200))) }
        val req = body["request"] as? JsonObject ?: refuse(400, "malformed")
        synchronized(this) { attestRequests += body }
        val p = VoiciJs.str(req["pseudonymPub"]) ?: refuse(400, "malformed")
        val t = now()
        return MessagesAttestations.signMessagesKeyAttestation(p, 1, t, t + MessagesAttestations.MESSAGES_ATTESTATION_TTL_MS, ByteArray(64) { 7 }, caSeed).toJson()
    }

    val threadFetches = ArrayList<JsonObject>()

    override suspend fun thread(body: JsonObject): Triple<List<VoiciInboxItem>, String, Boolean> = synchronized(this) {
        threadFetches += body
        val conv = VoiciJs.str(body["conv"]) ?: refuse(400, "malformed")
        val since = VoiciJs.str(body["since"]) ?: refuse(400, "malformed")
        val at = VoiciJs.time(body["issuedAt"]) ?: refuse(400, "malformed")
        val cred = body["cred"] as? JsonObject ?: refuse(400, "malformed")
        val d = WebDelegations.parseWebDelegation(cred["delegation"]) ?: refuse(400, "malformed")
        val ok = WebDelegations.checkWebDelegation(cred["delegation"], VoiciJs.str(cred["delegationSig"]), WebDelegations.Want("voici-messages", d.origin, d.audience, d.principalPub, now()))
        if (!ok.ok || VoiciMessages.voiciConv(d.audience, d.principalPub) != conv) refuse(403, "bad-delegation")
        if (!WebEnvelopes.p256VerifyP1363(VoiciJs.str(body["sig"]), VoiciOwner.canonicalThreadFetch(conv, since, at), d.delegatePub)) refuse(403, "bad-signature")
        val owner = ownerOf(d.audience) ?: refuse(404, "not-found")
        val all = inbox[owner].orEmpty().withIndex().filter { VoiciJs.str(it.value.envelope["conv"]) == conv }
        val after = since.toIntOrNull() ?: 0
        val out = all.filter { it.index + 1 > after }
        Triple(out.map { it.value }, (out.lastOrNull()?.index?.plus(1) ?: after).let { if (it == 0) since else it.toString() }, false)
    }

    override suspend fun deviceGrants(username: String): List<JsonObject> = grants[username].orEmpty()

    override suspend fun phoneLive(username: String): JsonObject? = null

    override suspend fun phoneDeliver(username: String, envelope: JsonObject): JsonObject? = null

    // ── playing a visitor ──

    /** A browser signed in to [username]'s page as the account with [visitorUmk], writing [text]: a valid voici-message. */
    fun visitorMessage(username: String, visitorUmk: ByteArray, text: String, seq: Long = 1, browserPriv: ByteArray = ByteArray(32) { 0x21 }): JsonObject {
        val idx = synchronized(this) { VoiciPage.parseVoiciPageIndex(pages[username]) } ?: error("no page")
        val pageId = idx.body.pageId
        val v = VoiciVisitorKeys.derive(visitorUmk, pageId)
        val t = now()
        val att = MessagesAttestations.signMessagesKeyAttestation(v.pseudonymPub, 1, t - 1000, t + MessagesAttestations.MESSAGES_ATTESTATION_TTL_MS, ByteArray(64) { 7 }, caSeed)
        val b = VoiciJs.hex(VoiciJs.p256PublicKey(browserPriv))
        val d = WebDelegation("voici-messages", com.flagshipserver.app.core.Endpoints.voiciOrigin, pageId, v.pseudonymPub, "p256", b, t - 1000, att.expiresAt, "ab".repeat(16))
        val ts = VoiciThreadStatement(pageId, v.pseudonymPub, v.threadPub, t - 1000)
        val conv = VoiciMessages.voiciConv(pageId, v.pseudonymPub)
        val msgId = VoiciOwner.randomHex(16)
        val body = VoiciMessages.sealVoiciBody(conv, msgId, t, v.pseudonymPub, listOf(WebEnvelopes.hexToBytes(idx.body.inboxPub), v.thread.publicKey), VoiciPlaintext(text, null))
        val cred = JsonObject(
            linkedMapOf(
                "attestation" to att.toJson(), "delegation" to d.toJson(),
                "delegationSig" to JsonPrimitive(WebDelegations.signWebDelegation(d, v.pseudonym.seed)),
                "threadStmt" to ts.toJson(), "threadSig" to JsonPrimitive(VoiciMessages.signVoiciThreadStatement(ts, v.pseudonym.seed)),
            ),
        )
        val env = WebEnvelope("voici-message", pageId, conv, v.pseudonymPub, msgId, seq, t, WebEnvelopes.b64Encode(body), cred)
        return WebEnvelopes.signWebEnvelopeP256(env, browserPriv).toJson()
    }

    /** The visitor writes: the message lands in the owner's mailbox as `/api/voici/web/send` would store it. */
    suspend fun visitorWrites(username: String, visitorUmk: ByteArray, text: String, seq: Long = 1): JsonObject =
        visitorMessage(username, visitorUmk, text, seq).also { send(it) }
}
