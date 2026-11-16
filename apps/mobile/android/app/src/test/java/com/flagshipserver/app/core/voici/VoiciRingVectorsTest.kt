// Ringing a caller back: the Kotlin ring and hint against packages/protocol/test-vectors/voici-call-modes/vectors.json
// (`ring`, tools/voici-call-modes-vectors.ts).

package com.flagshipserver.app.core.voici

import com.flagshipserver.app.core.voici.VoiciVectorsTest.Companion.h
import com.flagshipserver.app.core.voici.VoiciVectorsTest.Companion.vectorsFile
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.Assert.assertEquals
import org.junit.Test

class VoiciRingVectorsTest {
    private val R: JsonObject by lazy { Json.parseToJsonElement(vectorsFile("packages/protocol/test-vectors/voici-call-modes/vectors.json").readText()).jsonObject["ring"]!!.jsonObject }
    private fun s(o: JsonObject, k: String) = o[k]!!.jsonPrimitive.content
    private fun ring(o: JsonObject) = VoiciRing(s(o, "pageId"), s(o, "conv"), s(o, "ringId"), s(o, "hint"), s(o, "media"), o["issuedAt"]!!.jsonPrimitive.long)

    @Test fun ringAndHint() {
        val order = R["order"]!!.jsonObject
        val r = ring(order)
        assertEquals(s(R, "canonical"), String(VoiciRings.canonicalRing(r), Charsets.UTF_8))
        val p = R["hintPlain"]!!.jsonObject
        val sealed = VoiciRings.sealHint(h(s(R, "threadPub")), s(p, "pageId"), s(p, "username"), s(p, "conv"), s(p, "ringId"), s(p, "media"), p["issuedAt"]!!.jsonPrimitive.long, h(s(R, "hintEseed")))
        assertEquals(r.hint, WebEnvelopes.b64Encode(sealed))
        for (c in R["checks"]!!.jsonArray.map { it.jsonObject }) {
            assertEquals(s(c, "name"), c["expect"]!!.jsonPrimitive.boolean, VoiciRings.verifyRing(ring(c["ring"]!!.jsonObject), s(c, "signature"), s(R, "ownerSignPub")))
        }
        assertEquals(r.toJson(), order)
    }
}
