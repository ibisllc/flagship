package com.flagshipserver.app.core

import com.flagshipserver.app.api.LocalAiAppGrantWire
import com.flagshipserver.app.api.LocalAiTrainOrderWire
import com.google.crypto.tink.subtle.Ed25519Sign
import com.google.crypto.tink.subtle.Ed25519Verify
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.File

/** Local AI orders against packages/protocol/test-vectors/local-ai/vectors.json. */
class LocalAiOrdersTest {
    private fun vectors(): JsonObject {
        val rel = "packages/protocol/test-vectors/local-ai/vectors.json"
        var dir: File? = File(System.getProperty("user.dir")!!).absoluteFile
        while (dir != null) {
            val f = File(dir, rel)
            if (f.isFile) return Json.parseToJsonElement(f.readText()).jsonObject
            dir = dir.parentFile
        }
        fail("vectors.json not found"); throw IllegalStateException()
    }

    private fun unhex(h: String) = ByteArray(h.length / 2) { h.substring(it * 2, it * 2 + 2).toInt(16).toByte() }
    private fun s(o: JsonObject, k: String) = o[k]!!.jsonPrimitive.content

    private fun grant(o: JsonObject) = LocalAiAppGrantWire(
        s(o, "serverDomain"), s(o, "serviceId"), o["requestsPerDay"]!!.jsonPrimitive.long, o["tokensPerDay"]!!.jsonPrimitive.long,
        o["maxTokensPerRequest"]!!.jsonPrimitive.long, o["issuedAt"]!!.jsonPrimitive.long,
    )

    private fun train(o: JsonObject): LocalAiTrainOrderWire {
        val e = o["epochs"]!!.jsonPrimitive.content.toDouble()
        require(e == Math.floor(e)) { "epochs" }
        return LocalAiTrainOrderWire(s(o, "serverDomain"), s(o, "serviceId"), s(o, "jobId"), s(o, "baseModel"), e.toInt(), o["issuedAt"]!!.jsonPrimitive.long)
    }

    @Test
    fun canonicalBytesAndSignaturesMatchTheSharedVectors() {
        val v = vectors()
        val verifier = Ed25519Verify(unhex(s(v, "pubHex")))
        val signer = Ed25519Sign(unhex(s(v, "seedHex")))
        for (e in v["grants"]!!.jsonArray) {
            val bytes = LocalAiOrders.grantBytes(grant(e.jsonObject["grant"]!!.jsonObject))
            assertEquals(s(e.jsonObject, "canonical"), String(bytes, Charsets.UTF_8))
            verifier.verify(unhex(s(e.jsonObject, "signatureHex")), bytes)
            // Ed25519 is deterministic: this app's signer makes the same signature.
            assertEquals(s(e.jsonObject, "signatureHex"), LocalAiOrders.signGrant(grant(e.jsonObject["grant"]!!.jsonObject), signer).signature)
        }
        for (e in v["trains"]!!.jsonArray) {
            val bytes = LocalAiOrders.trainBytes(train(e.jsonObject["order"]!!.jsonObject))
            assertEquals(s(e.jsonObject, "canonical"), String(bytes, Charsets.UTF_8))
            verifier.verify(unhex(s(e.jsonObject, "signatureHex")), bytes)
            assertEquals(s(e.jsonObject, "signatureHex"), LocalAiOrders.signTrain(train(e.jsonObject["order"]!!.jsonObject), signer).signature)
        }
    }

    @Test
    fun malformedOrdersAreRefused() {
        val v = vectors()
        for (e in v["refusedGrants"]!!.jsonArray) {
            try {
                LocalAiOrders.grantBytes(grant(e.jsonObject["grant"]!!.jsonObject))
                fail(s(e.jsonObject, "name"))
            } catch (_: IllegalArgumentException) {
            } catch (_: NumberFormatException) {
            }
        }
        for (e in v["refusedTrains"]!!.jsonArray) {
            try {
                LocalAiOrders.trainBytes(train(e.jsonObject["order"]!!.jsonObject))
                fail(s(e.jsonObject, "name"))
            } catch (_: IllegalArgumentException) {
            }
        }
    }

    @Test
    fun jobIdsAreSixteenLowercaseHex() {
        repeat(20) { assertTrue(Regex("^[0-9a-f]{16}$").matches(LocalAiOrders.newJobId())) }
    }
}
