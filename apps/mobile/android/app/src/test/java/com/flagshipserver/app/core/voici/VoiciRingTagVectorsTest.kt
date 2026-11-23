// Names on a locked phone: the Kotlin ring tag key and tag, the locked-name key and the attach body's ringTagKey
// against packages/protocol/test-vectors/voici/ring-tag.json (tools/voici-ring-tag-vectors.ts).

package com.flagshipserver.app.core.voici

import com.flagshipserver.app.core.voici.VoiciVectorsTest.Companion.h
import com.flagshipserver.app.core.voici.VoiciVectorsTest.Companion.vectorsFile
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class VoiciRingTagVectorsTest {
    private val V: JsonObject by lazy { Json.parseToJsonElement(vectorsFile("packages/protocol/test-vectors/voici/ring-tag.json").readText()).jsonObject }
    private fun s(o: JsonObject, k: String) = o[k]!!.jsonPrimitive.content

    @Test fun tagKeyTagsAndLockedNames() {
        assertEquals(s(V, "tagRingTag"), VoiciRings.TAG_RING_TAG)
        assertEquals(s(V, "tagLockedName"), VoiciRings.TAG_LOCKED_NAME)
        val key = VoiciRings.deriveRingTagKey(h(s(V, "messagesSecret")), s(V, "pageId"))
        val other = VoiciRings.deriveRingTagKey(h(s(V, "messagesSecret")), s(V, "otherPageId"))
        assertEquals(s(V, "tagKey"), VoiciJs.hex(key))
        assertEquals(s(V, "otherTagKey"), VoiciJs.hex(other))
        for (t in V["tags"]!!.jsonArray.map { it.jsonObject }) {
            assertEquals(s(t, "tag"), VoiciRings.ringTag(key, s(t, "ringId")))
            assertTrue(VoiciRings.ringTagMatches(key, s(t, "ringId"), s(t, "tag")))
            assertFalse(VoiciRings.ringTagMatches(key, s(t, "ringId"), s(t, "otherPageTag")))
            assertFalse(VoiciRings.ringTagMatches(other, s(t, "ringId"), s(t, "tag")))
        }
        assertNull(VoiciRings.ringTag(key, "nope"))
        for (n in V["lockedNames"]!!.jsonArray.map { it.jsonObject }) assertEquals(s(n, "key"), VoiciRings.lockedNameKey(s(n, "pseudonymPub")))
    }

    @Test fun attachBodies() {
        for (c in V["bodies"]!!.jsonArray.map { it.jsonObject }) {
            val got = VoiciCallModes.parseRingBackBody(c["input"]!!.jsonObject)
            val want = c["expect"]!!.let { if (it is JsonNull) null else it.jsonPrimitive.content }
            assertEquals(s(c, "name"), want, got?.let { it.second ?: "none" })
            if (got != null) assertFalse(got.first.containsKey("ringTagKey"))
        }
        val seed = ByteArray(32) { 0x3c }
        val conv = VoiciMessages.voiciConv(s(V, "pageId"), VoiciJs.hex(VoiciJs.edPub(seed)))
        val attach = VoiciCallModes.signRingBackPseudonym(s(V, "pageId"), conv, "attach", 5, seed, ByteArray(32) { 0x5a })
        assertEquals("5a".repeat(32), attach["ringTagKey"]!!.jsonPrimitive.content)
        assertNull(VoiciCallModes.signRingBackPseudonym(s(V, "pageId"), conv, "stop", 5, seed, ByteArray(32) { 0x5a })["ringTagKey"])
    }
}
