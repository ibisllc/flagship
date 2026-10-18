// Runs packages/protocol/test-vectors/security-notice/vectors.json, read from
// disk so a drift fails here: the Kotlin port of the security notice must give
// the same canonical bytes, the same refusals (in the same order) and the same
// decisions as the TypeScript reference and the webapp (docs/security-notices.md).

package com.flagshipserver.app.core

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.File

class SecurityNoticeVectorsTest {

    companion object {
        /** Walk up from the test's working directory to a repo-relative path. */
        fun repoFile(rel: String): File {
            val starts = ArrayList<File>()
            System.getProperty("user.dir")?.let { starts.add(File(it)) }
            runCatching { SecurityNoticeVectorsTest::class.java.protectionDomain?.codeSource?.location?.toURI()?.let { starts.add(File(it)) } }
            for (start in starts) {
                var dir: File? = start.absoluteFile
                var hops = 0
                while (dir != null && hops < 14) {
                    val f = File(dir, rel)
                    if (f.exists()) return f
                    dir = dir.parentFile
                    hops += 1
                }
            }
            fail("could not locate $rel")
            error("unreachable")
        }
    }

    private val root: JsonObject by lazy {
        Json.parseToJsonElement(repoFile("packages/protocol/test-vectors/security-notice/vectors.json").readText()).jsonObject
    }
    private val authority: String by lazy { root["keys"]!!.jsonObject["authorityPubHex"]!!.jsonPrimitive.content }
    private fun JsonObject.s(k: String) = this[k]!!.jsonPrimitive.content
    private fun JsonObject.l(k: String) = this[k]!!.jsonPrimitive.long

    @Test fun everyPositiveParsesReproducesItsCanonicalBytesAndVerifies() {
        val list = root["positive"]!!.jsonArray
        assertTrue(list.size >= 4)
        for (e in list) {
            val v = e.jsonObject
            val n = SecurityNoticeProtocol.parse(v["notice"])
            assertNotNull(v.s("name"), n)
            assertEquals(v.s("name"), v.s("canonical"), String(SecurityNoticeProtocol.canonical(n!!.raw, n.signedBy), Charsets.UTF_8))
            assertNull(v.s("name"), SecurityNoticeProtocol.verify(n, listOf(authority)))
        }
    }

    @Test fun everyRejectIsRefusedForItsReason() {
        val list = root["reject"]!!.jsonArray
        assertTrue(list.size >= 8)
        for (e in list) {
            val v = e.jsonObject
            val n = SecurityNoticeProtocol.parse(v["notice"])
            val got = if (n == null) "malformed" else SecurityNoticeProtocol.verify(n, listOf(authority)) ?: "accepted"
            assertEquals(v.s("name"), v.s("expect"), got)
        }
    }

    @Test fun everyUnsignableBodyThrowsTheFirstBrokenRule() {
        val list = root["unsignable"]!!.jsonArray
        assertTrue(list.size >= 15)
        for (e in list) {
            val v = e.jsonObject
            val code = try {
                SecurityNoticeProtocol.canonical(v["body"]!!.jsonObject, authority)
                "signable"
            } catch (x: SecurityNoticeException) {
                x.code
            }
            assertEquals(v.s("name"), v.s("code"), code)
        }
    }

    @Test fun everyOutcomeMatches() {
        val list = root["outcomes"]!!.jsonArray
        assertTrue(list.size >= 17)
        for (e in list) {
            val v = e.jsonObject
            val n = SecurityNoticeProtocol.parse(v["notice"])!!
            val c = v["client"]!!.jsonObject
            val client = NoticeClient(c.s("platform"), c.l("build"), c.l("protocol"))
            val got = SecurityNoticeProtocol.outcome(n, client, v.l("now"))
            val want = v["expect"]!!.jsonObject
            when (want.s("action")) {
                "none" -> assertEquals(v.s("name"), NoticeOutcome.None(want.s("why")), got)
                "banner" -> {
                    assertTrue(v.s("name"), got is NoticeOutcome.Banner)
                    assertEquals(v.s("name"), want.s("style"), (got as NoticeOutcome.Banner).style)
                }
                "lock" -> assertTrue(v.s("name"), got is NoticeOutcome.Lock)
                else -> fail("unknown action in ${v.s("name")}")
            }
        }
    }

    @Test fun everyAcceptFoldsAsTheReferenceDoes() {
        val list = root["accept"]!!.jsonArray
        assertTrue(list.size >= 8)
        for (e in list) {
            val v = e.jsonObject
            val st = v["store"]!!.jsonObject
            val stored = st["notice"]?.takeIf { it !is JsonNull }?.let { SecurityNoticeProtocol.parse(it) }
            val keys = v["authorityKeys"]!!.jsonArray.map { it.jsonPrimitive.content }
            val got = SecurityNoticeProtocol.accept(NoticeStore(st.l("highestSeq"), stored), v["candidate"], keys)
            val want = v["expect"]!!.jsonObject
            assertEquals(v.s("name"), want.l("highestSeq"), got.store.highestSeq)
            assertEquals(v.s("name"), want["seq"]?.takeIf { it !is JsonNull }?.jsonPrimitive?.long, got.store.notice?.seq)
            assertEquals(v.s("name"), want["refused"]?.takeIf { it !is JsonNull }?.jsonPrimitive?.content, got.refused)
        }
    }

    @Test fun protocolLevelEqualsTheTypeScriptConstant() {
        val ts = repoFile("packages/protocol/src/securityNotice.ts").readText()
        val m = Regex("export const CLIENT_PROTOCOL_LEVEL = (\\d+);").find(ts)
        assertNotNull("CLIENT_PROTOCOL_LEVEL not found in securityNotice.ts", m)
        assertEquals(m!!.groupValues[1].toLong(), SecurityNoticeProtocol.CLIENT_PROTOCOL_LEVEL)
    }

    @Test fun theKotlinRuleConstantsEqualTheTypeScriptOnes() {
        val ts = repoFile("packages/protocol/src/securityNotice.ts").readText()
        assertTrue(ts.contains("export const TAG_SECURITY_NOTICE = \"${SecurityNoticeProtocol.TAG}\";"))
        assertTrue(ts.contains("SECURITY_NOTICE_MAX_MESSAGE = ${SecurityNoticeProtocol.MAX_MESSAGE};"))
        assertTrue(ts.contains("SECURITY_NOTICE_MAX_REASON = ${SecurityNoticeProtocol.MAX_REASON};"))
        assertTrue(ts.contains("SECURITY_NOTICE_MAX_WINDOW_MS = 30 * 24 * 3600_000;"))
        assertEquals(30L * 24 * 3600_000, SecurityNoticeProtocol.MAX_WINDOW_MS)
    }

    @Test fun theMandateLogOfAResponseParses() {
        val bless = repoFile("packages/protocol/test-vectors/security-notice/vectors.json")
        assertTrue(bless.isFile)
        val mandates: JsonElement = JsonArray(emptyList())
        assertEquals(emptyList<Mandate>(), SecurityNoticeProtocol.parseMandates(mandates))
        assertNull(SecurityNoticeProtocol.parseMandates(JsonNull))
    }
}
