// Who may call a page, ringing a caller back, and a conversation's delete and reveal (docs/voici-calls.md, owner
// 2026-11-15/16): the Kotlin twin of packages/protocol/src/voiciCallModes.ts and voiciConversation.ts. Vectors:
// test-vectors/voici-call-modes/ (pow, anon, ringBack, ring) and test-vectors/voici-conversation/ (delete, reveal).
//
//   anon     flagship/voici-call-request-anon/v1|<pageId>|<conv>|<callId>|<browserPub>|<callerXwingPub>|<H(offerSdp)>
//              |<issuedAt>|<H(powChallenge)>|<powNonce>[|<media>]        P-256 by browserPub (an "anyone" page)
//   channel  flagship/voici-ring-back/v1|<pageId>|<conv>|<attach|stop>|<issuedAt>   by P (the caller's app) or B
//   delete   flagship/voici-conv-delete/v1|<pageId>|<conv>|<owner|caller>|<issuedAt>   owner key, P, or B
//   reveal   flagship/voici-reveal/v1|<conv>|<username>|<SHA-256 hex of the display name, or "->|<issuedAt>
//            Ed25519 by the caller's own page key; it travels inside the sealed conversation as {v:1, control}

package com.flagshipserver.app.core.voici

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

object VoiciCallModes {
    const val TAG_ANON = "flagship/voici-call-request-anon/v1"
    const val TAG_ANON_CONV = "flagship/voici-anon-conv/v1"
    const val TAG_POW = "flagship/voici-call-pow/v1"
    const val TAG_RING_BACK = "flagship/voici-ring-back/v1"
    const val TAG_CONV_DELETE = "flagship/voici-conv-delete/v1"
    const val TAG_REVEAL = "flagship/voici-reveal/v1"
    const val POW_MIN_BITS = 12
    const val POW_MAX_BITS = 26
    /** Who may call a page (the v2 index's callsFrom): anyone on the internet, or signed-in callers who allow call-back. */
    const val FROM_ANYONE = "anyone"
    const val FROM_CALLBACK = "callback"

    private val PAGE_ID = Regex("^[0-9a-f]{32}$")
    private val USERNAME = Regex("^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$")
    private val NONCE = Regex("^(0|[1-9][0-9]{0,15})$")
    private val ANON_KEYS = listOf("v", "kind", "pageId", "conv", "callId", "browserPub", "callerXwingPub", "offerSdp", "issuedAt", "pow", "sig")
    private val CRED_KEYS = listOf("attestation", "delegation", "delegationSig", "threadStmt", "threadSig")
    private fun hex(s: String?, bytes: Int) = s != null && s.length == bytes * 2 && s.all { it in '0'..'9' || it in 'a'..'f' }
    private fun str(e: JsonElement?) = VoiciJs.str(e)
    private fun no(code: String): VoiciOutcome<Nothing> = VoiciOutcome.Refused(code)
    private fun join(vararg parts: Any) = VoiciJs.utf8(parts.joinToString("|"))
    private fun isP256Pub(s: String?) = hex(s, 65) && s!!.startsWith("04") && VoiciJs.isP256Point(WebEnvelopes.hexToBytes(s))

    // ── proof of work ──

    data class Pow(val pageId: String, val issuedAt: Long, val bits: Int, val rand: String, val mac: String)

    fun parsePow(c: String?): Pow? {
        if (c == null || c.length > 256) return null
        val f = c.split("|")
        if (f.size != 6 || f[0] != TAG_POW || !PAGE_ID.matches(f[1]) || !NONCE.matches(f[2]) || !Regex("^[0-9]{2}$").matches(f[3]) || !hex(f[4], 16) || !hex(f[5], 32)) return null
        val bits = f[3].toInt()
        if (bits < POW_MIN_BITS || bits > POW_MAX_BITS) return null
        return Pow(f[1], f[2].toLong(), bits, f[4], f[5])
    }

    private fun leadingZeroBits(b: ByteArray): Int {
        var n = 0
        for (x in b) {
            val v = x.toInt() and 0xff
            if (v == 0) { n += 8; continue }
            return n + Integer.numberOfLeadingZeros(v) - 24
        }
        return n
    }

    fun powSolves(challenge: String, nonce: String): Boolean {
        val c = parsePow(challenge) ?: return false
        if (!NONCE.matches(nonce)) return false
        return leadingZeroBits(VoiciJs.sha256(VoiciJs.utf8("$challenge|$nonce"))) >= c.bits
    }

    // ── the anonymous request (the answering phone checks it; the app never places one) ──

    fun anonConv(pageId: String, browserPub: String): String = WebEnvelopes.sha256Hex("$TAG_ANON_CONV|$pageId|$browserPub").take(32)

    private class AnonFields(val o: JsonObject, val pageId: String, val conv: String, val callId: String, val browserPub: String, val xpub: String, val sdp: String,
                             val at: Long, val challenge: String, val nonce: String, val media: String?, val sig: String) {
        fun bytes(): ByteArray = canonicalAnon(pageId, conv, callId, browserPub, xpub, sdp, at, challenge, nonce, media)
    }

    fun canonicalAnon(pageId: String, conv: String, callId: String, browserPub: String, xpub: String, sdp: String, at: Long, challenge: String, nonce: String, media: String?): ByteArray {
        require(PAGE_ID.matches(pageId) && hex(conv, 16) && hex(callId, 16) && isP256Pub(browserPub) && hex(xpub, com.flagshipserver.app.core.pq.PqHybrid.HYBRID_SEAL_PUBLIC_KEY_LEN) &&
            at >= 0 && parsePow(challenge) != null && NONCE.matches(nonce) && (media == null || media in VoiciCalls.MEDIA_VALUES)) { TAG_ANON }
        val parts = mutableListOf<Any>(TAG_ANON, pageId, conv, callId, browserPub, xpub, VoiciCalls.sdpHash(sdp), at, WebEnvelopes.sha256Hex(challenge), nonce)
        if (media != null) parts += media
        return join(*parts.toTypedArray())
    }

    private fun anonFields(v: JsonElement?): AnonFields? {
        val o = VoiciJs.obj(v) ?: return null
        if (!(VoiciJs.exactKeys(o, ANON_KEYS) || VoiciJs.exactKeys(o, ANON_KEYS + "media")) || !VoiciJs.isNumEq(o["v"], 1) || str(o["kind"]) != "voici-call-request-anon") return null
        val sig = str(o["sig"]).takeIf { hex(it, 64) } ?: return null
        val pow = VoiciJs.obj(o["pow"])?.takeIf { VoiciJs.exactKeys(it, listOf("challenge", "nonce")) } ?: return null
        val media = if (o.containsKey("media")) (str(o["media"]) ?: return null) else null
        val f = AnonFields(o, str(o["pageId"]) ?: return null, str(o["conv"]) ?: return null, str(o["callId"]) ?: return null, str(o["browserPub"]) ?: return null,
            str(o["callerXwingPub"]) ?: return null, str(o["offerSdp"]) ?: return null, VoiciJs.time(o["issuedAt"]) ?: return null,
            str(pow["challenge"]) ?: return null, str(pow["nonce"]) ?: return null, media, sig)
        return try { f.bytes(); f } catch (_: IllegalArgumentException) { null }
    }

    fun isAnon(request: JsonElement?): Boolean = str(VoiciJs.obj(request)?.get("kind")) == "voici-call-request-anon"

    /** The canonical bytes of an anonymous request (its transcript for the frame keys and the answer's hash). */
    fun anonBytes(request: JsonElement?): ByteArray? = anonFields(request)?.bytes()

    /**
     * The answering phone's check, cheapest first (as voiciCallModes.ts): shape, page, calls on, an "anyone" page,
     * blocked, conv, SDP, X-Wing key, the work, B's signature, freshness. `.com` checked the challenge's MAC and spent it.
     */
    fun checkAnon(input: JsonElement?, pageId: String, acceptsCalls: Boolean, callsFrom: String, now: Long, blocked: Set<String>? = null, skipFresh: Boolean = false): VoiciOutcome<VoiciCallRequest> {
        if (input != null && VoiciJs.utf8(input.toString()).size > VoiciCalls.MAX_REQUEST_BYTES) return no("too-large")
        val f = anonFields(input) ?: return no("malformed")
        if (f.pageId != pageId) return no("wrong-audience")
        if (!acceptsCalls) return no("calls-off")
        if (callsFrom != FROM_ANYONE) return no("not-allowed")
        if (blocked?.contains(f.conv) == true) return no("blocked")
        if (f.conv != anonConv(f.pageId, f.browserPub)) return no("wrong-conv")
        if (VoiciCalls.checkSdp(f.sdp, f.media ?: VoiciCalls.MEDIA_AUDIO) != null) return no("bad-sdp")
        try { com.flagshipserver.app.core.pq.PqHybrid.parseHybridSealPublicKey(WebEnvelopes.hexToBytes(f.xpub)) } catch (_: Exception) { return no("bad-key") }
        if (parsePow(f.challenge)?.pageId != f.pageId || !powSolves(f.challenge, f.nonce)) return no("bad-pow")
        if (!WebEnvelopes.p256VerifyP1363(f.sig, f.bytes(), f.browserPub)) return no("bad-signature")
        if (!skipFresh && Math.abs(f.at - now) > VoiciCalls.SKEW_MS) return no("stale")
        // An anonymous caller has no pseudonym: `from` is the browser key, so a block or a name works on the conv.
        return VoiciOutcome.Ok(VoiciCallRequest(f.pageId, f.conv, f.callId, f.browserPub, f.xpub, f.sdp, f.at, f.browserPub, f.o, f.media ?: VoiciCalls.MEDIA_AUDIO))
    }

    // ── the ring-back channel ──

    fun canonicalRingBack(pageId: String, conv: String, op: String, issuedAt: Long): ByteArray {
        require(PAGE_ID.matches(pageId) && hex(conv, 32) && (op == "attach" || op == "stop") && issuedAt >= 0) { TAG_RING_BACK }
        return join(TAG_RING_BACK, pageId, conv, op, issuedAt)
    }

    /** The caller's app: the order signed by its pseudonym P for that page. */
    fun signRingBackPseudonym(pageId: String, conv: String, op: String, issuedAt: Long, pseudonymSeed: ByteArray): JsonObject {
        val sig = VoiciJs.hex(VoiciJs.edSign(pseudonymSeed, canonicalRingBack(pageId, conv, op, issuedAt)))
        return JsonObject(
            linkedMapOf(
                "order" to JsonObject(linkedMapOf("pageId" to JsonPrimitive(pageId), "conv" to JsonPrimitive(conv), "op" to JsonPrimitive(op), "issuedAt" to JsonPrimitive(issuedAt))),
                "signer" to JsonPrimitive("pseudonym"),
                "from" to JsonPrimitive(VoiciJs.hex(VoiciJs.edPub(pseudonymSeed))),
                "sig" to JsonPrimitive(sig),
            ),
        )
    }

    /** The message cred's checks (attestation, delegation to B, thread statement) for a browser-signed order; B or a refusal. */
    private fun browserSigner(c: JsonObject?, from: String, pageId: String, origin: String, caKeys: Collection<String>, now: Long, revoked: Set<String>?): Pair<String?, String?> {
        if (c == null || !VoiciJs.exactKeys(c, CRED_KEYS)) return null to "malformed"
        val att = MessagesAttestations.checkMessagesKeyAttestation(c["attestation"], caKeys, now, from).valueOrNull() ?: return null to "bad-attestation"
        val del = WebDelegations.checkWebDelegation(c["delegation"], str(c["delegationSig"]), WebDelegations.Want("voici-messages", origin, pageId, from, now, att.expiresAt)).valueOrNull()
            ?: return null to "bad-delegation"
        if (revoked?.contains(del.delegatePub) == true) return null to "revoked"
        val ts = VoiciMessages.parseVoiciThreadStatement(c["threadStmt"])
        val tsig = str(c["threadSig"])
        if (ts == null || ts.pageId != pageId || ts.pseudonymPub != from || tsig == null || !WebEnvelopes.ed25519VerifyHex(tsig, VoiciMessages.canonicalVoiciThreadStatement(ts), from)) return null to "bad-thread"
        return del.delegatePub to null
    }

    fun checkRingBack(input: JsonElement?, pageId: String, origin: String, caKeys: Collection<String>, now: Long, revoked: Set<String>? = null): VoiciOutcome<String> {
        val o = VoiciJs.obj(input) ?: return no("malformed")
        val from = str(o["from"]).takeIf { hex(it, 32) } ?: return no("malformed")
        val browser = str(o["signer"]) == "browser"
        if (!(if (browser) VoiciJs.exactKeys(o, listOf("order", "signer", "from", "cred", "sig")) else str(o["signer"]) == "pseudonym" && VoiciJs.exactKeys(o, listOf("order", "signer", "from", "sig")))) return no("malformed")
        val ord = VoiciJs.obj(o["order"])?.takeIf { VoiciJs.exactKeys(it, listOf("pageId", "conv", "op", "issuedAt")) } ?: return no("malformed")
        val op = str(ord["op"]) ?: return no("malformed")
        val oPage = str(ord["pageId"]) ?: return no("malformed")
        val conv = str(ord["conv"]) ?: return no("malformed")
        val at = VoiciJs.time(ord["issuedAt"]) ?: return no("malformed")
        val bytes = try { canonicalRingBack(oPage, conv, op, at) } catch (_: IllegalArgumentException) { return no("malformed") }
        val sig = str(o["sig"]) ?: return no("malformed")
        if (oPage != pageId) return no("wrong-audience")
        if (conv != VoiciMessages.voiciConv(pageId, from)) return no("wrong-conv")
        if (Math.abs(at - now) > VoiciCalls.SKEW_MS) return no("stale")
        if (!browser) return if (hex(sig, 64) && WebEnvelopes.ed25519VerifyHex(sig, bytes, from)) VoiciOutcome.Ok(op) else no("bad-signature")
        val (b, refusal) = browserSigner(VoiciJs.obj(o["cred"]), from, pageId, origin, caKeys, now, revoked)
        if (refusal != null) return no(refusal)
        return if (hex(sig, 64) && WebEnvelopes.p256VerifyP1363(sig, bytes, b!!)) VoiciOutcome.Ok(op) else no("bad-signature")
    }

    // ── delete = forget ──

    fun canonicalConvDelete(pageId: String, conv: String, side: String, issuedAt: Long): ByteArray {
        require(PAGE_ID.matches(pageId) && hex(conv, 32) && (side == "owner" || side == "caller") && issuedAt >= 0) { TAG_CONV_DELETE }
        return join(TAG_CONV_DELETE, pageId, conv, side, issuedAt)
    }

    private fun delJson(pageId: String, conv: String, side: String, issuedAt: Long) =
        JsonObject(linkedMapOf("pageId" to JsonPrimitive(pageId), "conv" to JsonPrimitive(conv), "side" to JsonPrimitive(side), "issuedAt" to JsonPrimitive(issuedAt)))

    /** The page owner's delete, by the page's owner messages key. */
    fun signConvDeleteOwner(pageId: String, conv: String, issuedAt: Long, ownerSignSeed: ByteArray): JsonObject = JsonObject(
        linkedMapOf(
            "del" to delJson(pageId, conv, "owner", issuedAt),
            "signer" to JsonPrimitive("owner"),
            "sig" to JsonPrimitive(VoiciJs.hex(VoiciJs.edSign(ownerSignSeed, canonicalConvDelete(pageId, conv, "owner", issuedAt)))),
        ),
    )

    /** The caller's app's delete, by its pseudonym P for the page. */
    fun signConvDeletePseudonym(pageId: String, conv: String, issuedAt: Long, pseudonymSeed: ByteArray): JsonObject = JsonObject(
        linkedMapOf(
            "del" to delJson(pageId, conv, "caller", issuedAt),
            "signer" to JsonPrimitive("pseudonym"),
            "from" to JsonPrimitive(VoiciJs.hex(VoiciJs.edPub(pseudonymSeed))),
            "sig" to JsonPrimitive(VoiciJs.hex(VoiciJs.edSign(pseudonymSeed, canonicalConvDelete(pageId, conv, "caller", issuedAt)))),
        ),
    )

    fun checkConvDelete(input: JsonElement?, pageId: String, ownerSignPub: String, origin: String, caKeys: Collection<String>, now: Long, revoked: Set<String>? = null): VoiciOutcome<String> {
        val o = VoiciJs.obj(input) ?: return no("malformed")
        val sig = str(o["sig"]) ?: return no("malformed")
        val signer = str(o["signer"])
        val keys = when (signer) {
            "owner" -> listOf("del", "signer", "sig")
            "pseudonym" -> listOf("del", "signer", "from", "sig")
            "browser" -> listOf("del", "signer", "from", "cred", "sig")
            else -> return no("malformed")
        }
        if (!VoiciJs.exactKeys(o, keys)) return no("malformed")
        val d = VoiciJs.obj(o["del"])?.takeIf { VoiciJs.exactKeys(it, listOf("pageId", "conv", "side", "issuedAt")) } ?: return no("malformed")
        val dPage = str(d["pageId"]) ?: return no("malformed")
        val conv = str(d["conv"]) ?: return no("malformed")
        val side = str(d["side"]) ?: return no("malformed")
        val at = VoiciJs.time(d["issuedAt"]) ?: return no("malformed")
        val bytes = try { canonicalConvDelete(dPage, conv, side, at) } catch (_: IllegalArgumentException) { return no("malformed") }
        if (dPage != pageId) return no("wrong-audience")
        if ((signer == "owner") != (side == "owner")) return no("wrong-side")
        if (Math.abs(at - now) > VoiciCalls.SKEW_MS) return no("stale")
        if (signer == "owner") return if (hex(sig, 64) && WebEnvelopes.ed25519VerifyHex(sig, bytes, ownerSignPub)) VoiciOutcome.Ok(conv) else no("bad-signature")
        val from = str(o["from"]).takeIf { hex(it, 32) } ?: return no("malformed")
        if (conv != VoiciMessages.voiciConv(pageId, from)) return no("wrong-conv")
        if (signer == "pseudonym") return if (hex(sig, 64) && WebEnvelopes.ed25519VerifyHex(sig, bytes, from)) VoiciOutcome.Ok(conv) else no("bad-signature")
        val (b, refusal) = browserSigner(VoiciJs.obj(o["cred"]), from, pageId, origin, caKeys, now, revoked)
        if (refusal != null) return no(refusal)
        return if (hex(sig, 64) && WebEnvelopes.p256VerifyP1363(sig, bytes, b!!)) VoiciOutcome.Ok(conv) else no("bad-signature")
    }

    // ── blocking an anonymous caller ──

    const val TAG_ANON_BLOCK = "flagship/voici-anon-block/v1"

    fun canonicalAnonBlock(pageId: String, conv: String, op: String, issuedAt: Long): ByteArray {
        require(PAGE_ID.matches(pageId) && hex(conv, 16) && (op == "block" || op == "unblock") && issuedAt >= 0) { TAG_ANON_BLOCK }
        return join(TAG_ANON_BLOCK, pageId, conv, op, issuedAt)
    }

    /** The owner's order {block:{pageId, conv, op, issuedAt}, signature} by the page's owner messages key. */
    fun signAnonBlock(pageId: String, conv: String, op: String, issuedAt: Long, ownerSignSeed: ByteArray): JsonObject = JsonObject(
        linkedMapOf(
            "block" to JsonObject(linkedMapOf("pageId" to JsonPrimitive(pageId), "conv" to JsonPrimitive(conv), "op" to JsonPrimitive(op), "issuedAt" to JsonPrimitive(issuedAt))),
            "signature" to JsonPrimitive(VoiciJs.hex(VoiciJs.edSign(ownerSignSeed, canonicalAnonBlock(pageId, conv, op, issuedAt)))),
        ),
    )

    fun verifyAnonBlock(block: JsonElement?, signature: String?, ownerSignPub: String): Boolean {
        val o = VoiciJs.obj(block)?.takeIf { VoiciJs.exactKeys(it, listOf("pageId", "conv", "op", "issuedAt")) } ?: return false
        val bytes = try {
            canonicalAnonBlock(str(o["pageId"]) ?: return false, str(o["conv"]) ?: return false, str(o["op"]) ?: return false, VoiciJs.time(o["issuedAt"]) ?: return false)
        } catch (_: IllegalArgumentException) { return false }
        return hex(signature, 64) && WebEnvelopes.ed25519VerifyHex(signature!!, bytes, ownerSignPub)
    }

    // ── reveal who I am ──

    fun revealNameHash(displayName: String?): String = displayName?.let { WebEnvelopes.sha256Hex(it) } ?: "-"

    fun canonicalReveal(conv: String, username: String, displayName: String?, issuedAt: Long): ByteArray {
        require(hex(conv, 32) && USERNAME.matches(username) && issuedAt >= 0) { TAG_REVEAL }
        require(displayName == null || VoiciText.checkVoiciText(VoiciTextField.displayName, displayName) == null) { TAG_REVEAL }
        return join(TAG_REVEAL, conv, username, revealNameHash(displayName), issuedAt)
    }

    /** The caller's app signs with its own page's key (deriveVoiciOwnerSignKey of its account). */
    fun signReveal(conv: String, username: String, displayName: String?, issuedAt: Long, pageSignSeed: ByteArray): JsonObject = JsonObject(
        linkedMapOf(
            "v" to JsonPrimitive(1), "kind" to JsonPrimitive("voici-reveal"), "conv" to JsonPrimitive(conv), "username" to JsonPrimitive(username),
            "displayName" to (displayName?.let { JsonPrimitive(it) } ?: JsonNull), "issuedAt" to JsonPrimitive(issuedAt),
            "sig" to JsonPrimitive(VoiciJs.hex(VoiciJs.edSign(pageSignSeed, canonicalReveal(conv, username, displayName, issuedAt)))),
        ),
    )

    fun unreveal(conv: String, issuedAt: Long): JsonObject =
        JsonObject(linkedMapOf("v" to JsonPrimitive(1), "kind" to JsonPrimitive("voici-unreveal"), "conv" to JsonPrimitive(conv), "issuedAt" to JsonPrimitive(issuedAt)))

    data class Reveal(val conv: String, val username: String, val displayName: String?, val issuedAt: Long)
    sealed interface RevealControl {
        data class Shown(val reveal: Reveal, val sig: String) : RevealControl
        data class Hidden(val conv: String, val issuedAt: Long) : RevealControl
    }

    /** Strict shape of a reveal or an unreveal; null otherwise. */
    fun parseRevealControl(v: JsonElement?): RevealControl? {
        val o = VoiciJs.obj(v) ?: return null
        if (!VoiciJs.isNumEq(o["v"], 1)) return null
        return when (str(o["kind"])) {
            "voici-unreveal" -> {
                if (!VoiciJs.exactKeys(o, listOf("v", "kind", "conv", "issuedAt"))) return null
                val conv = str(o["conv"]).takeIf { hex(it, 32) } ?: return null
                RevealControl.Hidden(conv, VoiciJs.time(o["issuedAt"]) ?: return null)
            }
            "voici-reveal" -> {
                if (!VoiciJs.exactKeys(o, listOf("v", "kind", "conv", "username", "displayName", "issuedAt", "sig"))) return null
                val sig = str(o["sig"]).takeIf { hex(it, 64) } ?: return null
                val dn = o["displayName"]
                val name = if (dn is JsonNull) null else (str(dn) ?: return null)
                val r = Reveal(str(o["conv"]) ?: return null, str(o["username"]) ?: return null, name, VoiciJs.time(o["issuedAt"]) ?: return null)
                try { canonicalReveal(r.conv, r.username, r.displayName, r.issuedAt) } catch (_: IllegalArgumentException) { return null }
                RevealControl.Shown(r, sig)
            }
            else -> null
        }
    }

    /** The owner's app: a reveal for [conv], signed by the page key `.com` serves for its username. */
    fun checkReveal(v: JsonElement?, conv: String, pageSignPub: String): VoiciOutcome<Reveal> {
        val c = parseRevealControl(v) as? RevealControl.Shown ?: return no("malformed")
        if (c.reveal.conv != conv) return no("wrong-conv")
        val bytes = canonicalReveal(c.reveal.conv, c.reveal.username, c.reveal.displayName, c.reveal.issuedAt)
        return if (WebEnvelopes.ed25519VerifyHex(c.sig, bytes, pageSignPub)) VoiciOutcome.Ok(c.reveal) else no("bad-signature")
    }
}
