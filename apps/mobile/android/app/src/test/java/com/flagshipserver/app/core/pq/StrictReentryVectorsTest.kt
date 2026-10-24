package com.flagshipserver.app.core.pq

import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import kotlinx.serialization.json.longOrNull
import org.junit.Assert.assertEquals
import org.junit.Assert.fail
import org.junit.Test

/** Pins the Kotlin port to packages/protocol/test-vectors/strict-reentry/vectors.json. */
class StrictReentryVectorsTest {
    private fun binding(e: kotlinx.serialization.json.JsonElement?): StrictReentry.Binding? {
        if (e == null || e is JsonNull) return null
        val o = e.jsonObject
        return StrictReentry.Binding(o["role"]!!.jsonPrimitive.content, o["subjectId"]!!.jsonPrimitive.content,
            o["ed25519PubHex"]!!.jsonPrimitive.content, o["mldsaPubHex"]!!.jsonPrimitive.content)
    }

    private fun inputs(o: JsonObject): StrictReentry.Inputs {
        val scope = o["scope"]!!.jsonObject
        return StrictReentry.Inputs(
            account = o["account"]!!.jsonPrimitive.content,
            scope = AssurancePolicy.Scope(scope["kind"]!!.jsonPrimitive.content, scope["id"]!!.jsonPrimitive.content),
            leftStrictAt = o["leftStrictAt"]!!.jsonPrimitive.long,
            devices = o["devices"]!!.jsonArray.mapNotNull(::binding),
            deviceCount = o["deviceCount"]!!.jsonPrimitive.int,
            adminRoot = binding(o["adminRoot"]),
            server = binding(o["server"])!!,
            recoveryChecked = o["recoveryChecked"]!!.jsonPrimitive.boolean,
            recoveryCheckedAt = (o["recoveryCheckedAt"] as? kotlinx.serialization.json.JsonPrimitive)?.longOrNull,
            nonceHex = o["nonceHex"]!!.jsonPrimitive.content,
            checkedAt = o["checkedAt"]!!.jsonPrimitive.long,
        )
    }

    @Test
    fun matchesTheSharedVectors() {
        val v = PqVectors.load("packages/protocol/test-vectors/strict-reentry/vectors.json")
        assertEquals(StrictReentry.TAG, v["tag"]!!.jsonPrimitive.content)
        for (c in v["cases"]!!.jsonArray.map { it.jsonObject }) {
            val i = inputs(c["inputs"]!!.jsonObject)
            assertEquals(c["texts"]!!.jsonArray.map { it.jsonPrimitive.content }, StrictReentry.texts(i))
            val e = StrictReentry.evidence(i)
            val want = c["evidence"]!!.jsonObject
            assertEquals(want["verifierChecksDigest"]!!.jsonPrimitive.content, e.verifierChecksDigest)
            assertEquals(want["enrollmentDigest"]!!.jsonPrimitive.content, e.enrollmentDigest)
            assertEquals(want["rekeyReceiptDigest"]!!.jsonPrimitive.content, e.rekeyReceiptDigest)
            assertEquals(want["recoveryTestDigest"]!!.jsonPrimitive.content, e.recoveryTestDigest)
        }
        for (r in v["refusals"]!!.jsonArray.map { it.jsonObject }) {
            try {
                StrictReentry.evidence(inputs(r["inputs"]!!.jsonObject))
                fail("expected a refusal: ${r["name"]}")
            } catch (e: StrictReentry.Refusal) {
                assertEquals(r["code"]!!.jsonPrimitive.content, e.code)
            }
        }
    }
}
