package com.flagshipserver.app.core

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.fail
import org.junit.Test
import java.io.File

class EnrollmentTest {
    private fun vectors(): JsonObject {
        val rel = "packages/protocol/test-vectors/enrollment/vectors.json"
        var dir: File? = File(System.getProperty("user.dir")!!).absoluteFile
        while (dir != null) {
            val f = File(dir, rel)
            if (f.isFile) return Json.parseToJsonElement(f.readText()).jsonObject
            dir = dir.parentFile
        }
        fail("vectors.json not found"); throw IllegalStateException()
    }

    private fun unhex(h: String) = ByteArray(h.length / 2) { h.substring(it * 2, it * 2 + 2).toInt(16).toByte() }
    private fun JsonObject.s(k: String) = this[k]!!.jsonPrimitive.content

    @Test
    fun proofsAndCodesMatchTheSharedVector() {
        val v = vectors()
        val secret = unhex(v.s("secretHex"))
        val proofs = v["proofs"]!!.jsonArray
        for (p in proofs) {
            val st = p.jsonObject["statement"]!!.jsonObject
            assertEquals(p.jsonObject.s("proofHex"), Enrollment.proofHex(secret, st.s("serverDomain"), st.s("stkPubHex"), st.s("authCodeSerial")))
        }
        val first = proofs[0].jsonObject.s("proofHex")
        for (c in v["invalid"]!!.jsonArray) {
            val st = c.jsonObject["statement"]!!.jsonObject
            assertFalse(c.jsonObject.s("name"), Enrollment.verify(secret, st.s("serverDomain"), st.s("stkPubHex"), st.s("authCodeSerial"), first))
        }
        for (c in v["codes"]!!.jsonArray) assertEquals(c.jsonObject.s("code"), Enrollment.serverCode(c.jsonObject.s("stkPubHex")))
        assertEquals(32, Enrollment.newSecret().size)
        val studioKey = unhex(v.s("studioConfirmKeyHex"))
        for (e in v["seen"]!!.jsonArray) {
            val o = e.jsonObject
            assertEquals(o.s("macHex"), Enrollment.serverSeenMacHex(studioKey, o.s("serverDomain"), o.s("stkPubHex")))
            assertFalse(Enrollment.verifyServerSeen(studioKey, o.s("serverDomain"), "ef".repeat(32), o.s("macHex")))
        }
    }
}
