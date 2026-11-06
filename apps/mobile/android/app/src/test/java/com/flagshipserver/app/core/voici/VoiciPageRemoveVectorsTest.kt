// Replays packages/protocol/test-vectors/voici-page-remove/vectors.json (tools/voici-page-remove-vectors.ts) against
// the Kotlin port. Mirrors packages/protocol/tests/voiciPageRemove.test.ts and iOS VoiciPageRemoveVectorTests.

package com.flagshipserver.app.core.voici

import com.flagshipserver.app.core.voici.VoiciVectorsTest.Companion.h
import com.flagshipserver.app.core.voici.VoiciVectorsTest.Companion.l
import com.flagshipserver.app.core.voici.VoiciVectorsTest.Companion.o
import com.flagshipserver.app.core.voici.VoiciVectorsTest.Companion.s
import com.flagshipserver.app.core.voici.VoiciVectorsTest.Companion.sOrNull
import com.flagshipserver.app.core.voici.VoiciVectorsTest.Companion.vectorsFile
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Test

class VoiciPageRemoveVectorsTest {
    private val V: JsonObject by lazy {
        Json.parseToJsonElement(vectorsFile("packages/protocol/test-vectors/voici-page-remove/vectors.json").readText()).jsonObject
    }

    @Test fun canonicalBytes() {
        val f = V.o("fields")
        assertEquals(V.s("tag"), VoiciPageRemove.TAG)
        assertEquals(V.s("canonical"), String(VoiciPageRemove.canonical(f.s("username"), f.s("pageId"), f.l("seq"), f.l("issuedAt"))))
    }

    @Test fun signsLikeTheVectors() {
        val f = V.o("fields")
        for ((kind, seed, signed) in listOf(Triple("admin-root", "adminRootSeed", "signed"), Triple("irk", "irkSeed", "signedIrk"))) {
            val r = VoiciPageRemove.sign(f.s("username"), f.s("pageId"), f.l("seq"), f.l("issuedAt"), kind, h(V.o("keys").s(seed)))
            val want = VoiciPageRemove.parse(V.o(signed))!!
            assertEquals(kind, want.copy(signature = r.signature), r)
            assertEquals(r, VoiciPageRemove.parse(r.toJson()))
            assertEquals("ok", VoiciPageRemove.check(r.toJson(), r.username, kind, r.signerPub, r.seq - 1, r.pageId, r.issuedAt).code)
        }
    }

    @Test fun everyCase() {
        for (c in V["cases"]!!.jsonArray.map { it.jsonObject }) {
            val ctx = c.o("ctx")
            val got = VoiciPageRemove.check(c["remove"], ctx.s("username"), ctx.s("sensitiveKind"), ctx.s("sensitivePub"), ctx.l("storedSeq"), ctx.sOrNull("storedPageId"), ctx.l("now"))
            assertEquals(c.s("name"), c.s("expected"), got.code)
        }
    }
}
