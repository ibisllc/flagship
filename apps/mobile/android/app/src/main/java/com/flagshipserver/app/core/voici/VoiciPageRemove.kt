// The owner takes their voi.ci page down (docs/voici-and-messages.md §3.3 "Remove my page"). Kotlin twin of
// packages/protocol/src/voiciPageRemove.ts, pinned by packages/protocol/test-vectors/voici-page-remove/vectors.json.
//
//   flagship/voici-page-remove/v1|<username lowercase>|<pageId>|<seq>|<issuedAt ms>
//
// Ed25519 by the key that signs the page index (admin root; the IRK only when the account pins none). seq climbs the
// publish ladder (stored seq + 1), so neither an old public index nor the removal can be replayed.

package com.flagshipserver.app.core.voici

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

data class VoiciPageRemove(
    val username: String,
    val pageId: String,
    val seq: Long,
    val issuedAt: Long,
    /** "admin-root" or "irk". */
    val signerKind: String,
    val signerPub: String,
    val signature: String,
) {
    /** The signed envelope, the body of `POST /api/voici/pages/<u>/remove`. */
    fun toJson(): JsonObject = JsonObject(
        linkedMapOf(
            "kind" to JsonPrimitive("VoiciPageRemove"),
            "version" to JsonPrimitive(1),
            "username" to JsonPrimitive(username),
            "pageId" to JsonPrimitive(pageId),
            "seq" to JsonPrimitive(seq),
            "issuedAt" to JsonPrimitive(issuedAt),
            "signerKind" to JsonPrimitive(signerKind),
            "signerPub" to JsonPrimitive(signerPub),
            "signature" to JsonPrimitive(signature),
        ),
    )

    companion object {
        const val TAG = "flagship/voici-page-remove/v1"
        private val USERNAME = Regex("^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$")
        private val PAGE_ID = Regex("^[0-9a-f]{32}$")
        private val KEYS = listOf("kind", "version", "username", "pageId", "seq", "issuedAt", "signerKind", "signerPub", "signature")

        fun canonical(username: String, pageId: String, seq: Long, issuedAt: Long): ByteArray {
            fun bad(f: String): Nothing = throw IllegalArgumentException("$TAG: bad $f")
            if (!USERNAME.matches(username)) bad("username")
            if (!PAGE_ID.matches(pageId)) bad("pageId")
            if (seq !in 1..VoiciJs.MAX_SAFE || issuedAt !in 0..VoiciJs.MAX_SAFE) bad("seq/issuedAt")
            return VoiciJs.utf8(listOf(TAG, username, pageId, seq.toString(), issuedAt.toString()).joinToString("|"))
        }

        /** Signs with the sensitive key's seed; signerPub is its public key. */
        fun sign(username: String, pageId: String, seq: Long, issuedAt: Long, signerKind: String, signerSeed: ByteArray): VoiciPageRemove {
            if (signerKind != "admin-root" && signerKind != "irk") throw IllegalArgumentException("$TAG: bad signerKind")
            val bytes = canonical(username, pageId, seq, issuedAt)
            return VoiciPageRemove(username, pageId, seq, issuedAt, signerKind, VoiciJs.hex(VoiciJs.edPub(signerSeed)), VoiciJs.hex(VoiciJs.edSign(signerSeed, bytes)))
        }

        /** Strict shape of an untrusted removal; no signature check. */
        fun parse(input: Any?): VoiciPageRemove? {
            val v: JsonElement? = when (input) {
                is String -> if (input.length > 4096) return null else VoiciJs.parseJson(input) ?: return null
                is JsonElement -> input
                else -> return null
            }
            val o = VoiciJs.obj(v) ?: return null
            if (!VoiciJs.exactKeys(o, KEYS) || VoiciJs.str(o["kind"]) != "VoiciPageRemove" || !VoiciJs.isNumEq(o["version"], 1)) return null
            val kind = VoiciJs.str(o["signerKind"])?.takeIf { it == "admin-root" || it == "irk" } ?: return null
            if (!WebEnvelopes.isLowerHex(o["signerPub"], 32) || !WebEnvelopes.isLowerHex(o["signature"], 64)) return null
            val r = VoiciPageRemove(
                username = VoiciJs.str(o["username"]) ?: return null,
                pageId = VoiciJs.str(o["pageId"]) ?: return null,
                seq = VoiciJs.time(o["seq"]) ?: return null,
                issuedAt = VoiciJs.time(o["issuedAt"]) ?: return null,
                signerKind = kind,
                signerPub = VoiciJs.str(o["signerPub"])!!,
                signature = VoiciJs.str(o["signature"])!!,
            )
            return try {
                canonical(r.username, r.pageId, r.seq, r.issuedAt)
                r
            } catch (_: IllegalArgumentException) {
                null
            }
        }

        /** `.com`'s check (the app runs it against the shared vectors): malformed, wrong-signer, bad-signature, wrong-page, stale, seq-conflict. */
        fun check(input: Any?, username: String, sensitiveKind: String, sensitivePub: String, storedSeq: Long, storedPageId: String?, now: Long): VoiciOutcome<VoiciPageRemove> {
            val r = parse(input)
            if (r == null || r.username != username) return VoiciOutcome.Refused("malformed")
            if (r.signerKind != sensitiveKind || r.signerPub != sensitivePub.lowercase()) return VoiciOutcome.Refused("wrong-signer")
            if (!WebEnvelopes.ed25519VerifyHex(r.signature, canonical(r.username, r.pageId, r.seq, r.issuedAt), r.signerPub)) return VoiciOutcome.Refused("bad-signature")
            if (storedPageId == null || r.pageId != storedPageId) return VoiciOutcome.Refused("wrong-page")
            if (Math.abs(r.issuedAt - now) > VoiciPage.VOICI_INDEX_SKEW_MS) return VoiciOutcome.Refused("stale")
            if (r.seq != storedSeq + 1) return VoiciOutcome.Refused("seq-conflict")
            return VoiciOutcome.Ok(r)
        }
    }
}
