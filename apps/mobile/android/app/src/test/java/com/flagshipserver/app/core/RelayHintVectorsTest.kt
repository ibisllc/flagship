// Runs packages/protocol/test-vectors/relay-hint/vectors.json, read from disk so
// a drift fails here: the Kotlin port of the relay hint must give the same
// canonical bytes, the same refusals and the same address order as the
// TypeScript reference (docs/relay-hints.md).

package com.flagshipserver.app.core

import kotlinx.serialization.json.Json
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
import org.junit.Test

class RelayHintVectorsTest {
    private val root: JsonObject by lazy {
        Json.parseToJsonElement(SecurityNoticeVectorsTest.repoFile("packages/protocol/test-vectors/relay-hint/vectors.json").readText()).jsonObject
    }
    private val authority: String by lazy { root["keys"]!!.jsonObject["authorityPubHex"]!!.jsonPrimitive.content }
    private fun JsonObject.s(k: String) = this[k]!!.jsonPrimitive.content
    private fun JsonObject.l(k: String) = this[k]!!.jsonPrimitive.long

    private fun store(o: JsonObject): RelayHintStore {
        val h = o["hint"]
        return RelayHintStore(o.l("highestSeq"), if (h == null || h is JsonNull) null else RelayHintProtocol.parse(h))
    }

    @Test fun everyPositiveParsesReproducesItsCanonicalBytesAndVerifies() {
        val list = root["positive"]!!.jsonArray
        assertTrue(list.size >= 2)
        for (e in list) {
            val v = e.jsonObject
            val h = RelayHintProtocol.parse(v["hint"])
            assertNotNull(v.s("name"), h)
            assertEquals(v.s("name"), v.s("canonical"), String(RelayHintProtocol.canonical(h!!.raw, h.signedBy), Charsets.UTF_8))
            assertNull(v.s("name"), RelayHintProtocol.verify(h, listOf(authority)))
        }
    }

    @Test fun everyRejectIsRefusedForItsReason() {
        val list = root["reject"]!!.jsonArray
        assertTrue(list.size >= 3)
        for (e in list) {
            val v = e.jsonObject
            val h = RelayHintProtocol.parse(v["hint"])
            val got = if (h == null) "malformed" else RelayHintProtocol.verify(h, listOf(authority))
            assertEquals(v.s("name"), v.s("expect"), got)
        }
    }

    @Test fun everyUnsignableBodyNamesTheRuleItBreaks() {
        val list = root["unsignable"]!!.jsonArray
        assertTrue(list.size >= 15)
        for (e in list) {
            val v = e.jsonObject
            val code = try {
                RelayHintProtocol.canonical(v["body"]!!.jsonObject, authority)
                "NONE"
            } catch (x: RelayHintException) {
                x.code
            }
            assertEquals(v.s("name"), v.s("code"), code)
        }
    }

    @Test fun foldingCandidatesIntoTheStoreFollowsTheTable() {
        for (e in root["accept"]!!.jsonArray) {
            val v = e.jsonObject
            val got = RelayHintProtocol.accept(store(v["from"]!!.jsonObject), v["candidate"], listOf(authority))
            val expectRefused = v["refused"].let { if (it == null || it is JsonNull) null else it.jsonPrimitive.content }
            assertEquals(v.s("name"), expectRefused, got.refused)
            assertEquals(v.s("name"), v.l("highestSeq"), got.store.highestSeq)
        }
    }

    @Test fun theOrderOfAddressesToTryFollowsTheTable() {
        for (e in root["addresses"]!!.jsonArray) {
            val v = e.jsonObject
            val keys = v["authority"]!!.jsonArray.map { it.jsonPrimitive.content }
            val seed = v["seed"]!!.jsonArray.map { it.jsonPrimitive.content }
            val want = v["expect"]!!.jsonArray.map { it.jsonPrimitive.content }
            assertEquals(v.s("name"), want, RelayHintProtocol.addresses(store(v["store"]!!.jsonObject), keys, seed, v.l("now")))
        }
    }
}
