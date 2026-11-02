// voi.ci pages (docs/voici-and-messages.md §2, §3, §5): the signed index of content-addressed pieces, the piece
// schemas and caps, anti-rollback, the piece-upload signature, the one-namespace key, post chunking and the
// two-admin-device merge. Kotlin twin of packages/protocol/src/voiciPage.ts; vectors in
// packages/protocol/test-vectors/voici/.
//
//   flagship/voici-page/v1|<username>|<pageId>|<seq>|<issuedAt>|<acceptsMessages 0|1>|<inboxEpoch>|<inboxPub>
//     |<ownerSignPub>|<pieces>|<signerKind admin-root|irk>|<signerPub>
//   pieces = "<role>:<sha256>:<size>" sorted (code-unit order), joined by ","
//   flagship/voici-piece-upload/v1|<u>|<pageId>|<sha256>|<size>|<issuedAt>
//
// Public API (object VoiciPage): TAG_VOICI_PAGE, TAG_VOICI_PIECE_UPLOAD, VOICI_* caps, VOICI_THEMES,
// voiciNamespaceKey, isVoiciJpeg, voiciJpegHasMetadata, parseVoiciProfile, parseVoiciProfilePiece, parseVoiciPost,
// parseVoiciChunkPiece, voiciCardRole, canonicalVoiciPageIndex, signVoiciPageIndex, parseVoiciPageIndex,
// checkVoiciPageIndex, checkVoiciPublish (codes malformed, wrong-username, not-sensitive-key, bad-signature,
// rolled-back, stale, seq-conflict, wrong-page), voiciPieceRefsOk, canonicalVoiciPieceUpload, signVoiciPieceUpload,
// verifyVoiciPieceUpload, chunkVoiciPosts, mergeVoiciPage. Data classes VoiciProfile, VoiciProfileLink, VoiciCard,
// VoiciPostLink, VoiciPost, VoiciChunk, VoiciPieceRef, VoiciPageIndexBody, VoiciPageIndex, VoiciPieceUpload,
// VoiciPageState (each with toJson where it travels).

package com.flagshipserver.app.core.voici

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

data class VoiciProfileLink(val url: String, val label: String, val site: String?) {
    fun toJson() = JsonObject(linkedMapOf("url" to JsonPrimitive(url), "label" to JsonPrimitive(label), "site" to (site?.let { JsonPrimitive(it) } ?: JsonNull)))
}

data class VoiciProfile(val displayName: String, val bio: String, val avatar: String?, val theme: String, val links: List<VoiciProfileLink>) {
    val v: Int get() = 1
    fun toJson() = JsonObject(
        linkedMapOf(
            "v" to JsonPrimitive(1),
            "displayName" to JsonPrimitive(displayName),
            "bio" to JsonPrimitive(bio),
            "avatar" to (avatar?.let { JsonPrimitive(it) } ?: JsonNull),
            "theme" to JsonPrimitive(theme),
            "links" to JsonArray(links.map { it.toJson() }),
        ),
    )
}

data class VoiciCard(val title: String, val site: String, val description: String, val image: String?) {
    fun toJson() = JsonObject(
        linkedMapOf(
            "title" to JsonPrimitive(title), "site" to JsonPrimitive(site), "description" to JsonPrimitive(description),
            "image" to (image?.let { JsonPrimitive(it) } ?: JsonNull),
        ),
    )
}

data class VoiciPostLink(val url: String, val card: VoiciCard?) {
    fun toJson() = JsonObject(linkedMapOf("url" to JsonPrimitive(url), "card" to (card?.toJson() ?: JsonNull)))
}

data class VoiciPost(val id: String, val createdAt: Long, val editedAt: Long?, val text: String, val links: List<VoiciPostLink>) {
    fun toJson() = JsonObject(
        linkedMapOf(
            "id" to JsonPrimitive(id),
            "createdAt" to JsonPrimitive(createdAt),
            "editedAt" to (editedAt?.let { JsonPrimitive(it) } ?: JsonNull),
            "text" to JsonPrimitive(text),
            "links" to JsonArray(links.map { it.toJson() }),
        ),
    )
}

data class VoiciChunk(val chunk: Int, val posts: List<VoiciPost>) {
    fun toJson() = JsonObject(linkedMapOf("v" to JsonPrimitive(1), "chunk" to JsonPrimitive(chunk), "posts" to JsonArray(posts.map { it.toJson() })))
}

data class VoiciPieceRef(val role: String, val sha256: String, val size: Long) {
    val key: String get() = "$role:$sha256:$size"
    fun toJson() = JsonObject(linkedMapOf("role" to JsonPrimitive(role), "sha256" to JsonPrimitive(sha256), "size" to JsonPrimitive(size)))
}

data class VoiciPageIndexBody(
    val username: String,
    val pageId: String,
    val seq: Long,
    val issuedAt: Long,
    val acceptsMessages: Int,
    val inboxEpoch: Long,
    val inboxPub: String,
    val ownerSignPub: String,
    val pieces: List<VoiciPieceRef>,
    /** "admin-root" or "irk". */
    val signerKind: String,
    /** Filled in by signVoiciPageIndex. */
    val signerPub: String = "",
)

data class VoiciPageIndex(val body: VoiciPageIndexBody, val signature: String) {
    fun toJson(): JsonObject = JsonObject(
        linkedMapOf(
            "kind" to JsonPrimitive("VoiciPage"),
            "version" to JsonPrimitive(1),
            "username" to JsonPrimitive(body.username),
            "pageId" to JsonPrimitive(body.pageId),
            "seq" to JsonPrimitive(body.seq),
            "issuedAt" to JsonPrimitive(body.issuedAt),
            "acceptsMessages" to JsonPrimitive(body.acceptsMessages),
            "inboxEpoch" to JsonPrimitive(body.inboxEpoch),
            "inboxPub" to JsonPrimitive(body.inboxPub),
            "ownerSignPub" to JsonPrimitive(body.ownerSignPub),
            "pieces" to JsonArray(body.pieces.map { it.toJson() }),
            "signerKind" to JsonPrimitive(body.signerKind),
            "signerPub" to JsonPrimitive(body.signerPub),
            "signature" to JsonPrimitive(signature),
        ),
    )
}

data class VoiciPieceUpload(val username: String, val pageId: String, val sha256: String, val size: Long, val issuedAt: Long)

data class VoiciPageState(
    val profile: VoiciProfile,
    val acceptsMessages: Int,
    /** Chunk n holds posts in creation order; chunk 0 the oldest. */
    val chunks: List<List<VoiciPost>>,
    /** The published index's issuedAt (0 for a page never published). */
    val issuedAt: Long,
) {
    fun toJson() = JsonObject(
        linkedMapOf(
            "profile" to profile.toJson(),
            "acceptsMessages" to JsonPrimitive(acceptsMessages),
            "chunks" to JsonArray(chunks.map { c -> JsonArray(c.map { it.toJson() }) }),
            "issuedAt" to JsonPrimitive(issuedAt),
        ),
    )
}

object VoiciPage {
    const val TAG_VOICI_PAGE = "flagship/voici-page/v1"
    const val TAG_VOICI_PIECE_UPLOAD = "flagship/voici-piece-upload/v1"

    const val VOICI_PROFILE_MAX_BYTES = 16 * 1024
    const val VOICI_CHUNK_MAX_BYTES = 256 * 1024
    const val VOICI_CHUNK_MAX_POSTS = 20
    const val VOICI_AVATAR_MAX_BYTES = 150 * 1024
    const val VOICI_CARD_IMAGE_MAX_BYTES = 40 * 1024
    const val VOICI_INDEX_MAX_BYTES = 300 * 1024
    const val VOICI_INDEX_MAX_PIECES = 2000
    const val VOICI_PROFILE_MAX_LINKS = 12
    const val VOICI_POST_MAX_LINKS = 3
    const val VOICI_INDEX_SKEW_MS = 10L * 60_000
    val VOICI_THEMES: List<String> = listOf("classic", "ink", "sea")

    private val PAGE_ID = Regex("^[0-9a-f]{32}$")
    private val USERNAME = Regex("^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$")
    private val ROLE = Regex("^(profile|avatar|chunk-(0|[1-9][0-9]{0,5})|card-[0-9a-f]{16})$")
    private val INDEX_KEYS = listOf("kind", "version", "username", "pageId", "seq", "issuedAt", "acceptsMessages", "inboxEpoch", "inboxPub", "ownerSignPub", "pieces", "signerKind", "signerPub", "signature")
    private fun isTime(n: Long) = n in 0..VoiciJs.MAX_SAFE
    private fun hex(s: String?, n: Int) = WebEnvelopes.isLowerHex(s, n)
    private fun hex(e: JsonElement?, n: Int) = WebEnvelopes.isLowerHex(e, n)

    /** One namespace with custom link names and codes (§4.1): lowercase, hyphens removed. */
    fun voiciNamespaceKey(name: String): String = name.lowercase().replace("-", "")

    fun isVoiciJpeg(b: ByteArray): Boolean = b.size >= 4 && b[0] == 0xff.toByte() && b[1] == 0xd8.toByte() && b[2] == 0xff.toByte()

    /** True when a JPEG carries an APP1 (EXIF/XMP) or APP2 (ICC) segment before its scan. */
    fun voiciJpegHasMetadata(b: ByteArray): Boolean {
        if (!isVoiciJpeg(b)) return false
        var i = 2
        while (i + 4 <= b.size && b[i] == 0xff.toByte()) {
            val m = b[i + 1].toInt() and 0xff
            if (m == 0xda || m == 0xd9) return false
            if (m == 0xe1 || m == 0xe2) return true
            i += 2 + (((b[i + 2].toInt() and 0xff) shl 8) or (b[i + 3].toInt() and 0xff))
        }
        return false
    }

    private fun parseJsonPiece(bytes: ByteArray, max: Int): JsonObject? {
        if (bytes.size > max) return null
        val text = VoiciJs.utf8Fatal(bytes) ?: return null
        val v = VoiciJs.obj(VoiciJs.parseJson(text)) ?: return null
        return try {
            if (WebEnvelopes.canonicalJson(v) == text) v else null
        } catch (_: IllegalArgumentException) {
            null
        }
    }

    private fun nullOrHex32(e: JsonElement?): Pair<Boolean, String?> = when {
        e is JsonNull -> true to null
        hex(e, 32) -> true to VoiciJs.str(e)
        else -> false to null
    }

    fun parseVoiciProfile(v: JsonElement?): VoiciProfile? {
        val o = VoiciJs.obj(v) ?: return null
        if (!VoiciJs.exactKeys(o, listOf("v", "displayName", "bio", "avatar", "theme", "links")) || !VoiciJs.isNumEq(o["v"], 1)) return null
        if (VoiciText.checkVoiciText(VoiciTextField.displayName, o["displayName"]) != null || VoiciText.checkVoiciText(VoiciTextField.bio, o["bio"]) != null) return null
        val (avOk, avatar) = nullOrHex32(o["avatar"])
        if (!avOk) return null
        val theme = VoiciJs.str(o["theme"])
        if (theme == null || theme !in VOICI_THEMES) return null
        val arr = VoiciJs.arr(o["links"]) ?: return null
        if (arr.size > VOICI_PROFILE_MAX_LINKS) return null
        val links = ArrayList<VoiciProfileLink>()
        var mail = 0
        for (le in arr) {
            val l = VoiciJs.obj(le) ?: return null
            if (!VoiciJs.exactKeys(l, listOf("url", "label", "site"))) return null
            if (VoiciText.checkVoiciLinkUrl(l["url"], true) != null || VoiciText.checkVoiciText(VoiciTextField.linkLabel, l["label"]) != null) return null
            val url = VoiciJs.str(l["url"])!!
            if (url.startsWith("mailto:") && ++mail > 1) return null
            val site: String? = if (l["site"] is JsonNull) null else (VoiciJs.str(l["site"])?.takeIf { it in VoiciText.SITE_IDS } ?: return null)
            links.add(VoiciProfileLink(url, VoiciJs.str(l["label"])!!, site))
        }
        return VoiciProfile(VoiciJs.str(o["displayName"])!!, VoiciJs.str(o["bio"])!!, avatar, theme, links)
    }

    /** A profile piece's bytes: size, canonical JSON, schema. */
    fun parseVoiciProfilePiece(bytes: ByteArray): VoiciProfile? = parseJsonPiece(bytes, VOICI_PROFILE_MAX_BYTES)?.let { parseVoiciProfile(it) }

    private fun parseCard(v: JsonElement?): VoiciCard? {
        val o = VoiciJs.obj(v) ?: return null
        if (!VoiciJs.exactKeys(o, listOf("title", "site", "description", "image"))) return null
        if (VoiciText.checkVoiciText(VoiciTextField.cardTitle, o["title"]) != null ||
            VoiciText.checkVoiciText(VoiciTextField.cardSite, o["site"]) != null ||
            VoiciText.checkVoiciText(VoiciTextField.cardDescription, o["description"]) != null
        ) return null
        val (ok, image) = nullOrHex32(o["image"])
        if (!ok) return null
        return VoiciCard(VoiciJs.str(o["title"])!!, VoiciJs.str(o["site"])!!, VoiciJs.str(o["description"])!!, image)
    }

    fun parseVoiciPost(v: JsonElement?): VoiciPost? {
        val o = VoiciJs.obj(v) ?: return null
        if (!VoiciJs.exactKeys(o, listOf("id", "createdAt", "editedAt", "text", "links"))) return null
        if (!hex(o["id"], 16)) return null
        val createdAt = VoiciJs.time(o["createdAt"]) ?: return null
        val editedAt: Long? = if (o["editedAt"] is JsonNull) null else (VoiciJs.time(o["editedAt"]) ?: return null)
        if (VoiciText.checkVoiciText(VoiciTextField.postText, o["text"]) != null) return null
        val arr = VoiciJs.arr(o["links"]) ?: return null
        if (arr.size > VOICI_POST_MAX_LINKS) return null
        val links = ArrayList<VoiciPostLink>()
        for (le in arr) {
            val l = VoiciJs.obj(le) ?: return null
            if (!VoiciJs.exactKeys(l, listOf("url", "card")) || VoiciText.checkVoiciLinkUrl(l["url"]) != null) return null
            val card = if (l["card"] is JsonNull) null else (parseCard(l["card"]) ?: return null)
            links.add(VoiciPostLink(VoiciJs.str(l["url"])!!, card))
        }
        return VoiciPost(VoiciJs.str(o["id"])!!, createdAt, editedAt, VoiciJs.str(o["text"])!!, links)
    }

    /** A chunk piece's bytes; `n` is the chunk number its role names. Post ids must be unique in the chunk. */
    fun parseVoiciChunkPiece(bytes: ByteArray, n: Int): VoiciChunk? {
        val v = parseJsonPiece(bytes, VOICI_CHUNK_MAX_BYTES) ?: return null
        if (!VoiciJs.exactKeys(v, listOf("v", "chunk", "posts")) || !VoiciJs.isNumEq(v["v"], 1) || !VoiciJs.isNumEq(v["chunk"], n.toLong())) return null
        val arr = VoiciJs.arr(v["posts"]) ?: return null
        if (arr.size > VOICI_CHUNK_MAX_POSTS) return null
        val ids = HashSet<String>()
        val posts = ArrayList<VoiciPost>()
        for (p in arr) {
            val q = parseVoiciPost(p) ?: return null
            if (!ids.add(q.id)) return null
            posts.add(q)
        }
        return VoiciChunk(n, posts)
    }

    fun voiciCardRole(sha256: String): String = "card-${sha256.take(16)}"

    // ── the index ──

    private fun piecesProblem(pieces: List<VoiciPieceRef>): String? {
        if (pieces.size > VOICI_INDEX_MAX_PIECES) return "pieces"
        val roles = HashSet<String>()
        var chunks = 0
        for (p in pieces) {
            if (!ROLE.matches(p.role) || !hex(p.sha256, 32) || !isTime(p.size) || p.size < 1) return "piece field"
            if (!roles.add(p.role)) return "duplicate role"
            if (p.role.startsWith("card-") && p.role != voiciCardRole(p.sha256)) return "card role"
            if (p.role.startsWith("chunk-")) chunks++
            val cap = when {
                p.role == "profile" -> VOICI_PROFILE_MAX_BYTES
                p.role == "avatar" -> VOICI_AVATAR_MAX_BYTES
                p.role.startsWith("card-") -> VOICI_CARD_IMAGE_MAX_BYTES
                else -> VOICI_CHUNK_MAX_BYTES
            }
            if (p.size > cap) return "piece size"
        }
        if ("profile" !in roles) return "no profile"
        for (i in 0 until chunks) if ("chunk-$i" !in roles) return "chunks not contiguous"
        val keys = pieces.map { it.key }
        for (i in 1 until keys.size) if (keys[i - 1] >= keys[i]) return "pieces not sorted"
        return null
    }

    fun canonicalVoiciPageIndex(b: VoiciPageIndexBody): ByteArray {
        fun bad(f: String): Nothing = throw IllegalArgumentException("$TAG_VOICI_PAGE: bad $f")
        if (!USERNAME.matches(b.username)) bad("username")
        if (!PAGE_ID.matches(b.pageId)) bad("pageId")
        if (!isTime(b.seq) || b.seq < 1 || !isTime(b.issuedAt)) bad("seq/issuedAt")
        if (b.acceptsMessages != 0 && b.acceptsMessages != 1) bad("acceptsMessages")
        if (!isTime(b.inboxEpoch) || b.inboxEpoch < 1) bad("inboxEpoch")
        if (!hex(b.inboxPub, 1216) || !hex(b.ownerSignPub, 32)) bad("keys")
        piecesProblem(b.pieces)?.let { bad(it) }
        if (b.signerKind != "admin-root" && b.signerKind != "irk") bad("signerKind")
        if (!hex(b.signerPub, 32)) bad("signerPub")
        return VoiciJs.utf8(
            listOf(
                TAG_VOICI_PAGE, b.username, b.pageId, b.seq.toString(), b.issuedAt.toString(), b.acceptsMessages.toString(),
                b.inboxEpoch.toString(), b.inboxPub, b.ownerSignPub, b.pieces.joinToString(",") { it.key }, b.signerKind, b.signerPub,
            ).joinToString("|"),
        )
    }

    /** Sorts the pieces, then signs with the sensitive key's seed (signerPub is set from it). */
    fun signVoiciPageIndex(body: VoiciPageIndexBody, signerSeed: ByteArray): VoiciPageIndex {
        val full = body.copy(pieces = body.pieces.sortedBy { it.key }, signerPub = VoiciJs.hex(VoiciJs.edPub(signerSeed)))
        return VoiciPageIndex(full, VoiciJs.hex(VoiciJs.edSign(signerSeed, canonicalVoiciPageIndex(full))))
    }

    /** Strict shape of an untrusted index (JSON text ≤ 300 KiB as a String, or a parsed value); no signature check. */
    fun parseVoiciPageIndex(input: Any?): VoiciPageIndex? {
        val v: JsonElement? = when (input) {
            is String -> {
                if (VoiciJs.utf8(input).size > VOICI_INDEX_MAX_BYTES) return null
                VoiciJs.parseJson(input) ?: return null
            }
            is JsonElement -> input
            else -> return null
        }
        val o = VoiciJs.obj(v) ?: return null
        if (!VoiciJs.exactKeys(o, INDEX_KEYS) || VoiciJs.str(o["kind"]) != "VoiciPage" || !VoiciJs.isNumEq(o["version"], 1) || !hex(o["signature"], 64)) return null
        val accepts = VoiciJs.num(o["acceptsMessages"])
        if (accepts != 0.0 && accepts != 1.0) return null
        val arr = VoiciJs.arr(o["pieces"]) ?: return null
        if (arr.size > VOICI_INDEX_MAX_PIECES) return null
        val pieces = ArrayList<VoiciPieceRef>()
        for (pe in arr) {
            val p = VoiciJs.obj(pe) ?: return null
            if (!VoiciJs.exactKeys(p, listOf("role", "sha256", "size"))) return null
            pieces.add(VoiciPieceRef(VoiciJs.str(p["role"]) ?: return null, VoiciJs.str(p["sha256"]) ?: return null, VoiciJs.time(p["size"]) ?: return null))
        }
        val body = VoiciPageIndexBody(
            username = VoiciJs.str(o["username"]) ?: return null,
            pageId = VoiciJs.str(o["pageId"]) ?: return null,
            seq = VoiciJs.time(o["seq"]) ?: return null,
            issuedAt = VoiciJs.time(o["issuedAt"]) ?: return null,
            acceptsMessages = accepts.toInt(),
            inboxEpoch = VoiciJs.time(o["inboxEpoch"]) ?: return null,
            inboxPub = VoiciJs.str(o["inboxPub"]) ?: return null,
            ownerSignPub = VoiciJs.str(o["ownerSignPub"]) ?: return null,
            pieces = pieces,
            signerKind = VoiciJs.str(o["signerKind"]) ?: return null,
            signerPub = VoiciJs.str(o["signerPub"]) ?: return null,
        )
        return try {
            canonicalVoiciPageIndex(body)
            VoiciPageIndex(body, VoiciJs.str(o["signature"])!!)
        } catch (_: IllegalArgumentException) {
            null
        }
    }

    /**
     * A reader's check: shape, the username asked for, signerPub = the account's current sensitive key (with its
     * kind), the signature, the pageId when given, and anti-rollback against highestSeenSeq (§2.9).
     */
    fun checkVoiciPageIndex(
        input: Any?,
        username: String,
        sensitiveKind: String,
        sensitivePub: String,
        highestSeenSeq: Long? = null,
        pageId: String? = null,
    ): VoiciOutcome<VoiciPageIndex> {
        val idx = parseVoiciPageIndex(input) ?: return VoiciOutcome.Refused("malformed")
        val b = idx.body
        if (b.username != username) return VoiciOutcome.Refused("wrong-username")
        if (b.signerKind != sensitiveKind || b.signerPub != sensitivePub) return VoiciOutcome.Refused("not-sensitive-key")
        if (!WebEnvelopes.ed25519VerifyHex(idx.signature, canonicalVoiciPageIndex(b), b.signerPub)) return VoiciOutcome.Refused("bad-signature")
        if (pageId != null && b.pageId != pageId) return VoiciOutcome.Refused("wrong-page")
        if (highestSeenSeq != null && b.seq < highestSeenSeq) return VoiciOutcome.Refused("rolled-back")
        return VoiciOutcome.Ok(idx)
    }

    /** .com's publish check (§3) after the reader's: issuedAt within 10 minutes, seq = stored + 1, pageId unchanged. */
    fun checkVoiciPublish(
        input: Any?,
        username: String,
        sensitiveKind: String,
        sensitivePub: String,
        storedSeq: Long,
        storedPageId: String?,
        now: Long,
    ): VoiciOutcome<VoiciPageIndex> {
        val r = checkVoiciPageIndex(input, username, sensitiveKind, sensitivePub)
        val idx = r.valueOrNull() ?: return r
        if (Math.abs(idx.body.issuedAt - now) > VOICI_INDEX_SKEW_MS) return VoiciOutcome.Refused("stale")
        if (idx.body.seq != storedSeq + 1) return VoiciOutcome.Refused("seq-conflict")
        if (storedPageId != null && idx.body.pageId != storedPageId) return VoiciOutcome.Refused("wrong-page")
        return r
    }

    /** The pieces the content names are the pieces the index lists (avatar, card images, chunk count). */
    fun voiciPieceRefsOk(index: VoiciPageIndexBody, profile: VoiciProfile, chunks: List<VoiciChunk?>): Boolean {
        val byRole = index.pieces.associate { it.role to it.sha256 }
        if (profile.avatar != byRole["avatar"]) return false
        val nChunks = index.pieces.count { it.role.startsWith("chunk-") }
        if (chunks.size != nChunks || chunks.withIndex().any { (i, c) -> c == null || c.chunk != i }) return false
        val cards = HashSet<String>()
        for (c in chunks) for (p in c!!.posts) for (l in p.links) l.card?.image?.let { cards.add(it) }
        val listed = index.pieces.filter { it.role.startsWith("card-") }
        return listed.size == cards.size && listed.all { it.sha256 in cards }
    }

    // ── piece upload ──

    fun canonicalVoiciPieceUpload(u: VoiciPieceUpload): ByteArray {
        if (!USERNAME.matches(u.username) || !PAGE_ID.matches(u.pageId) || !hex(u.sha256, 32) || !isTime(u.size) || u.size < 1 || !isTime(u.issuedAt)) {
            throw IllegalArgumentException("$TAG_VOICI_PIECE_UPLOAD: bad field")
        }
        return VoiciJs.utf8(listOf(TAG_VOICI_PIECE_UPLOAD, u.username, u.pageId, u.sha256, u.size.toString(), u.issuedAt.toString()).joinToString("|"))
    }

    fun signVoiciPieceUpload(u: VoiciPieceUpload, signerSeed: ByteArray): String = VoiciJs.hex(VoiciJs.edSign(signerSeed, canonicalVoiciPieceUpload(u)))

    fun verifyVoiciPieceUpload(u: VoiciPieceUpload, signature: String, signerPub: String): Boolean = try {
        WebEnvelopes.ed25519VerifyHex(signature, canonicalVoiciPieceUpload(u), signerPub)
    } catch (_: IllegalArgumentException) {
        false
    }

    // ── chunking and the merge (§5.3) ──

    private val byCreation = Comparator<VoiciPost> { a, b -> if (a.createdAt != b.createdAt) a.createdAt.compareTo(b.createdAt) else a.id.compareTo(b.id) }
    private fun stamp(p: VoiciPost) = p.editedAt ?: p.createdAt

    /** Posts (any order) into fresh chunks of at most 20, creation order: for a first publish. */
    fun chunkVoiciPosts(posts: List<VoiciPost>): List<List<VoiciPost>> = posts.sortedWith(byCreation).chunked(VOICI_CHUNK_MAX_POSTS)

    /**
     * Applies pending draft ops to a published state (ops in (at, opId) order): post-add of a new id appends to the
     * last chunk (a new chunk when it holds 20), of an existing id the newer stamp wins; post-edit replaces only a
     * newer version of a post still present; post-delete removes it; profile and accept-messages win when op.at is
     * later than the state's time. Pure.
     */
    fun mergeVoiciPage(published: VoiciPageState, ops: List<VoiciDraftOp>): VoiciPageState {
        val chunks = published.chunks.map { it.toMutableList() }.toMutableList()
        var profile = published.profile
        var profileAt = published.issuedAt
        var accepts = published.acceptsMessages
        var acceptsAt = published.issuedAt
        fun find(id: String): Pair<Int, Int>? {
            for (c in chunks.indices) {
                val i = chunks[c].indexOfFirst { it.id == id }
                if (i >= 0) return c to i
            }
            return null
        }
        val sorted = ops.sortedWith { a, b -> if (a.at != b.at) a.at.compareTo(b.at) else a.opId.compareTo(b.opId) }
        for (op in sorted) {
            val post = op.post
            if ((op.op == "post-add" || op.op == "post-edit") && post != null) {
                val at = find(post.id)
                if (at != null) {
                    val cur = chunks[at.first][at.second]
                    if (stamp(post) > stamp(cur)) {
                        chunks[at.first][at.second] = post
                        chunks[at.first].sortWith(byCreation)
                    }
                } else if (op.op == "post-add") {
                    if (chunks.isEmpty() || chunks.last().size >= VOICI_CHUNK_MAX_POSTS) chunks.add(mutableListOf())
                    chunks.last().add(post)
                    chunks.last().sortWith(byCreation)
                }
            } else if (op.op == "post-delete" && op.postId != null) {
                val at = find(op.postId)
                if (at != null) chunks[at.first].removeAt(at.second)
            } else if (op.op == "profile" && op.profile != null && op.at > profileAt) {
                profile = op.profile
                profileAt = op.at
            } else if (op.op == "accept-messages" && op.accepts != null && op.at > acceptsAt) {
                accepts = op.accepts
                acceptsAt = op.at
            }
        }
        return VoiciPageState(profile, accepts, chunks.map { it.toList() }, published.issuedAt)
    }
}
