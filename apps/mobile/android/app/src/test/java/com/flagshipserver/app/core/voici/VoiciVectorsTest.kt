// Replays packages/protocol/test-vectors/voici/vectors.json (tools/voici-vectors.ts) against the Kotlin port: text
// rules, links, sites, names, namespace keys, JPEG checks, pieces, the index and its refusals, piece upload, the merge.
// Mirrors packages/protocol/tests/voiciVectors.test.ts.

package com.flagshipserver.app.core.voici

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.File

class VoiciVectorsTest {
    companion object {
        fun vectorsFile(rel: String): File {
            var dir: File? = File(System.getProperty("user.dir") ?: ".").absoluteFile
            var hops = 0
            while (dir != null && hops < 14) {
                val f = File(dir, rel)
                if (f.isFile) return f
                dir = dir.parentFile
                hops += 1
            }
            fail("could not locate $rel")
            error("unreachable")
        }

        fun JsonObject.s(k: String) = this[k]!!.jsonPrimitive.content
        fun JsonObject.l(k: String) = this[k]!!.jsonPrimitive.long
        fun JsonObject.o(k: String) = this[k]!!.jsonObject
        fun JsonObject.a(k: String) = this[k]!!.jsonArray.map { it }
        fun JsonObject.sOrNull(k: String) = this[k]?.let { if (it is JsonNull) null else it.jsonPrimitive.content }
        fun JsonObject.lOrNull(k: String) = this[k]?.let { if (it is JsonNull) null else it.jsonPrimitive.long }
        fun h(s: String) = WebEnvelopes.hexToBytes(s)
        fun H(b: ByteArray) = VoiciJs.hex(b)
    }

    private val V: JsonObject by lazy { Json.parseToJsonElement(vectorsFile("packages/protocol/test-vectors/voici/vectors.json").readText()).jsonObject }

    @Test fun textRules() {
        val t = V.o("text")
        for (c in t.a("check").map { it.jsonObject }) {
            val got = VoiciText.checkVoiciText(VoiciTextField.valueOf(c.s("field")), c.s("input")) ?: "ok"
            assertEquals(c.s("input"), c.s("expected"), got)
        }
        for (c in t.a("prepare").map { it.jsonObject }) {
            val r = VoiciText.prepareVoiciText(VoiciTextField.valueOf(c.s("field")), c.s("input"))
            val got = when (r) {
                is VoiciOutcome.Ok -> JsonObject(mapOf("ok" to JsonPrimitive(true), "text" to JsonPrimitive(r.value)))
                is VoiciOutcome.Refused -> JsonObject(mapOf("ok" to JsonPrimitive(false), "code" to JsonPrimitive(r.reason)))
            }
            assertEquals(c["expected"], got)
        }
        assertEquals(t.a("check").size, 25)
    }

    @Test fun linkUrlsMatchesAndSites() {
        for (c in V.a("linkUrls").map { it.jsonObject }) {
            assertEquals(c.s("url"), c.sOrNull("expected"), VoiciText.checkVoiciLinkUrl(c.s("url"), c["allowMailto"]!!.jsonPrimitive.boolean))
        }
        for (c in V.a("linkMatches").map { it.jsonObject }) {
            val got = JsonArray(VoiciText.findVoiciLinks(c.s("text")).map { m -> JsonObject(mapOf("start" to JsonPrimitive(m.start), "end" to JsonPrimitive(m.end), "url" to JsonPrimitive(m.url), "host" to JsonPrimitive(m.host))) })
            assertEquals(c.s("text"), c["matches"], got)
        }
        val table = JsonArray(VoiciText.VOICI_LINK_SITES.map { s -> JsonObject(mapOf("id" to JsonPrimitive(s.id), "hosts" to JsonArray(s.hosts.map { JsonPrimitive(it) }), "label" to JsonPrimitive(s.label))) })
        assertEquals(V.o("linkSites")["table"], table)
        for (c in V.o("linkSites").a("cases").map { it.jsonObject }) assertEquals(c.s("url"), c.sOrNull("site"), VoiciText.voiciLinkSite(c.s("url")))
    }

    @Test fun namesKeysAndJpegs() {
        for (c in V.a("pseudonymNames").map { it.jsonObject }) {
            assertEquals(c.s("code"), VoiciText.voiciPseudonymCode(c.s("pub")))
            assertEquals(c.s("name"), VoiciText.voiciPseudonymName(c.s("pub")))
        }
        for (c in V.a("namespaceKeys").map { it.jsonObject }) assertEquals(c.s("key"), VoiciPage.voiciNamespaceKey(c.s("name")))
        for (c in V.a("jpegs").map { it.jsonObject }) {
            assertEquals(c.s("name"), c["isJpeg"]!!.jsonPrimitive.boolean, VoiciPage.isVoiciJpeg(h(c.s("hex"))))
            assertEquals(c.s("name"), c["hasMetadata"]!!.jsonPrimitive.boolean, VoiciPage.voiciJpegHasMetadata(h(c.s("hex"))))
        }
    }

    @Test fun piecesParseOrAreRefused() {
        val p = V.o("pieces")
        assertEquals(p.s("profileText"), WebEnvelopes.canonicalJson(p["profile"]))
        assertEquals(p["profile"], VoiciPage.parseVoiciProfile(p["profile"])!!.toJson())
        for (c in p.a("profileCases").map { it.jsonObject }) {
            assertEquals(c.s("name"), c["expected"]!!.jsonPrimitive.boolean, VoiciPage.parseVoiciProfilePiece(VoiciJs.utf8(c.s("text"))) != null)
        }
        for (c in p.a("chunkCases").map { it.jsonObject }) {
            assertEquals(c.s("name"), c["expected"]!!.jsonPrimitive.boolean, VoiciPage.parseVoiciChunkPiece(VoiciJs.utf8(c.s("text")), c["n"]!!.jsonPrimitive.int) != null)
        }
    }

    private fun bodyOf(o: JsonObject) = VoiciPageIndexBody(
        o.s("username"), o.s("pageId"), o.l("seq"), o.l("issuedAt"), o["acceptsMessages"]!!.jsonPrimitive.int, o.l("inboxEpoch"),
        o.s("inboxPub"), o.s("ownerSignPub"),
        o.a("pieces").map { it.jsonObject }.map { VoiciPieceRef(it.s("role"), it.s("sha256"), it.l("size")) },
        o.s("signerKind"),
    )

    @Test fun theIndex() {
        val ix = V.o("index")
        val signed = VoiciPage.parseVoiciPageIndex(ix["signed"])!!
        assertEquals(ix.s("canonical"), String(VoiciPage.canonicalVoiciPageIndex(signed.body), Charsets.UTF_8))
        assertEquals(ix["signed"], VoiciPage.signVoiciPageIndex(bodyOf(ix.o("body")), h(V.o("keys").s("adminRootSeed"))).toJson())
        val pieces = V.o("pieces")
        val profile = VoiciPage.parseVoiciProfile(pieces["profile"])!!
        val chunks = pieces.a("chunkTexts").mapIndexed { n, t -> VoiciPage.parseVoiciChunkPiece(VoiciJs.utf8(t.jsonPrimitive.content), n) }
        assertTrue(VoiciPage.voiciPieceRefsOk(signed.body, profile, chunks))
        assertFalse(VoiciPage.voiciPieceRefsOk(signed.body, profile.copy(avatar = null), chunks))
        var n = 0
        for (c in ix.a("checks").map { it.jsonObject }) {
            val ctx = c.o("ctx")
            val r = VoiciPage.checkVoiciPageIndex(c["index"], ctx.s("username"), ctx.s("sensitiveKind"), ctx.s("sensitivePub"), ctx.lOrNull("highestSeenSeq"), ctx.sOrNull("pageId"))
            assertEquals(c.s("name"), c.s("expected"), r.code)
            n++
        }
        assertEquals(22, n)
        for (c in ix.a("publishChecks").map { it.jsonObject }) {
            val ctx = c.o("ctx")
            val r = VoiciPage.checkVoiciPublish(c["index"], ctx.s("username"), ctx.s("sensitiveKind"), ctx.s("sensitivePub"), ctx.l("storedSeq"), ctx.sOrNull("storedPageId"), ctx.l("now"))
            assertEquals(c.s("name"), c.s("expected"), r.code)
        }
        assertEquals(ix["signed"], VoiciPage.parseVoiciPageIndex(ix["signed"].toString())!!.toJson())
        assertNull(VoiciPage.parseVoiciPageIndex("x".repeat(VoiciPage.VOICI_INDEX_MAX_BYTES + 1)))
    }

    @Test fun pieceUploadAndMerge() {
        val u = V.o("pieceUpload")
        fun up(o: JsonObject) = VoiciPieceUpload(o.s("username"), o.s("pageId"), o.s("sha256"), o.l("size"), o.l("issuedAt"))
        val cases = u.a("cases").map { it.jsonObject }
        assertEquals(u.s("canonical"), String(VoiciPage.canonicalVoiciPieceUpload(up(cases[0].o("upload"))), Charsets.UTF_8))
        assertEquals(cases[0].s("signature"), VoiciPage.signVoiciPieceUpload(up(cases[0].o("upload")), h(V.o("keys").s("adminRootSeed"))))
        for (c in cases) assertEquals(c.s("name"), c["expected"]!!.jsonPrimitive.boolean, VoiciPage.verifyVoiciPieceUpload(up(c.o("upload")), c.s("signature"), u.s("signerPub")))

        val ch = V.o("chunking")
        val posts = V.o("pieces").a("chunkTexts").flatMapIndexed { n, t -> VoiciPage.parseVoiciChunkPiece(VoiciJs.utf8(t.jsonPrimitive.content), n)!!.posts }
        assertEquals(ch["chunks"], JsonArray(VoiciPage.chunkVoiciPosts(posts.reversed()).map { c -> JsonArray(c.map { JsonPrimitive(it.id) }) }))

        for (c in V.a("merge").map { it.jsonObject }) {
            val st = stateOf(c.o("published"))
            val ops = c.a("ops").map { VoiciMessages.parseVoiciDraftOp(it)!! }
            assertEquals(c.s("name"), c["expected"], VoiciPage.mergeVoiciPage(st, ops).toJson())
        }
    }

    private fun stateOf(o: JsonObject) = VoiciPageState(
        VoiciPage.parseVoiciProfile(o["profile"])!!,
        o["acceptsMessages"]!!.jsonPrimitive.int,
        o.a("chunks").map { c -> c.jsonArray.map { VoiciPage.parseVoiciPost(it)!! } },
        o.l("issuedAt"),
    )
}
