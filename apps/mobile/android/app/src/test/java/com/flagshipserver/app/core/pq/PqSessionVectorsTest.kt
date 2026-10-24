package com.flagshipserver.app.core.pq

import com.flagshipserver.app.core.pq.PqVectors.h
import com.flagshipserver.app.core.pq.PqVectors.x
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.Assert.assertEquals
import org.junit.Test

// The Kotlin half of packages/protocol/test-vectors/pq-session/vectors.json.
class PqSessionVectorsTest {
    private val v = PqVectors.load("packages/protocol/test-vectors/pq-session/vectors.json")
    private val now = v["now"]!!.jsonPrimitive.long
    private fun JsonObject.s(k: String) = this[k]!!.jsonPrimitive.content

    private class Party(val name: String, val role: String, val subject: String, val secret: ByteArray, val binding: PqTrust.VerifiedBinding) {
        val sign = PqSession.Signer { p, m -> PqHybrid.hybridSign(secret, p, m, deterministic = true) }
    }

    private val parties = v["parties"]!!.jsonArray.map { it.jsonObject }.associate { p ->
        val b = p["binding"]!!.jsonObject
        val vb = PqTrust.verifyPqKeyBinding(b, PqTrust.Expectation(p.s("role"), p.s("subject"), b.s("ed25519PubHex"), now = now))
        assertEquals(p.s("keyIdHex"), vb.keyIdHex)
        p.s("name") to Party(p.s("name"), p.s("role"), p.s("subject"), h(p.s("edSeedHex")) + h(p.s("mldsaSeedHex")), vb)
    }
    private val box = parties[v.s("responder")]!!
    private val trusted = v["responderTrusts"]!!.jsonArray.map { parties[it.jsonPrimitive.content]!! }
    private val lookup = { role: String, subject: String, kid: String -> trusted.firstOrNull { it.role == role && it.subject == subject && it.binding.keyIdHex == kid }?.binding }
    private val r = v["randomness"]!!.jsonObject

    private fun start(t: JsonObject): PqSession.Initiator {
        val ini = parties[t.s("initiator")]!!
        return PqSession.Initiator(box.binding, ini.role, ini.binding, now, h(r.s("ephemeralSeedHex")), h(r.s("helloNonceHex")))
    }

    private fun accept(hello: kotlinx.serialization.json.JsonElement?) =
        PqSession.accept(hello, box.binding, lookup, now + 100, box.sign, h(r.s("encapsulationHex")), h(r.s("acceptNonceHex")))

    private fun code(f: () -> Unit): String = try {
        f(); "ok"
    } catch (e: PqSessionException) {
        e.code
    }

    @Test
    fun transcriptsReproduceByteForByte() {
        for (t in v["transcripts"]!!.jsonArray.map { it.jsonObject }) {
            val ini = parties[t.s("initiator")]!!
            val st = start(t)
            assertEquals(t["hello"], st.hello.toJson())
            assertEquals(t.s("helloBytesHex"), x(st.hello.bytes()))
            val (a, pending) = accept(t["hello"])
            assertEquals(t["accept"], a)
            val (f, ichan) = st.finish(t["accept"], now + 200, ini.sign)
            assertEquals(t["finish"], f)
            val rchan = pending.complete(t["finish"], now + 300)
            val k = t["keys"]!!.jsonObject
            assertEquals(k.s("sessionIdHex"), ichan.sessionIdHex)
            assertEquals(k.s("sessionIdHex"), rchan.sessionIdHex)
            val recs = t["records"]!!.jsonArray.map { it.jsonObject }
            for (rec in recs) {
                val dir = rec["dir"]!!.jsonPrimitive.int
                val key = h(k.s(if (dir == 1) "initiatorToResponderHex" else "responderToInitiatorHex"))
                assertEquals(rec.s("recordHex"), x(PqSession.sealRecord(key, h(k.s("sessionIdHex")), dir, rec["seq"]!!.jsonPrimitive.long, h(rec.s("plaintextHex")))))
            }
            assertEquals(recs[1].s("plaintextHex"), x(rchan.openRequest(h(recs[1].s("recordHex")), now + 400).second))
            assertEquals(recs[0].s("plaintextHex"), x(rchan.openRequest(h(recs[0].s("recordHex")), now + 400).second))
            assertEquals(recs[2].s("plaintextHex"), x(ichan.openResponse(1, h(recs[2].s("recordHex")))))
        }
    }

    @Test
    fun invalidCasesCarryTheSameCodes() {
        val t0 = v["transcripts"]!!.jsonArray[0].jsonObject
        val phone = parties["phone"]!!
        val inv = v["invalid"]!!.jsonObject
        for (c in inv["hello"]!!.jsonArray.map { it.jsonObject }) {
            assertEquals("hello ${c.s("name")}", c.s("expect"), code { accept(c["hello"]) })
        }
        for (c in inv["accept"]!!.jsonArray.map { it.jsonObject }) {
            assertEquals("accept ${c.s("name")}", c.s("expect"), code { start(t0).finish(c["accept"], now + 200, phone.sign) })
        }
        for (c in inv["finish"]!!.jsonArray.map { it.jsonObject }) {
            val (_, pending) = accept(t0["hello"])
            assertEquals("finish ${c.s("name")}", c.s("expect"), code { pending.complete(c["finish"], now + 300) })
        }
        for (c in inv["records"]!!.jsonArray.map { it.jsonObject }) {
            val (_, pending) = accept(t0["hello"])
            val (_, ichan) = start(t0).finish(t0["accept"], now + 200, phone.sign)
            val rchan = pending.complete(t0["finish"], now + 300)
            val got = if (c.s("side") == "responder") {
                code { for (rec in c["sequence"]!!.jsonArray) rchan.openRequest(h(rec.jsonPrimitive.content), now + 400) }
            } else {
                code { ichan.openResponse(c["expectSeq"]!!.jsonPrimitive.long, h(c.s("record"))) }
            }
            assertEquals("record ${c.s("name")}", c.s("expect"), got)
        }
    }
}
