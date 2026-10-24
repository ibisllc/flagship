package com.flagshipserver.app.core

import com.flagshipserver.app.core.pq.PqVectors
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.int
import kotlinx.serialization.json.long
import org.junit.Assert.assertEquals
import org.junit.Test
import java.io.File

/** The phone's CA lease PQ gate against packages/protocol/test-vectors/ca-lease-pq/vectors.json. */
class CaLeasePqVectorsTest {
    private val v = PqVectors.load("packages/protocol/test-vectors/ca-lease-pq/vectors.json")

    private fun lease(o: kotlinx.serialization.json.JsonObject) = CaEndorsement(
        kind = o["kind"]!!.jsonPrimitive.content, version = o["version"]!!.jsonPrimitive.int,
        endorsementId = o["endorsementId"]!!.jsonPrimitive.content, track = o["track"]!!.jsonPrimitive.content,
        caPubkey = o["caPubkey"]!!.jsonPrimitive.content, scope = o["scope"]!!.jsonPrimitive.content,
        notBefore = o["notBefore"]!!.jsonPrimitive.content, notAfter = o["notAfter"]!!.jsonPrimitive.content,
        issuedAt = o["issuedAt"]!!.jsonPrimitive.content, signedBy = o["signedBy"]!!.jsonPrimitive.content,
        signatures = o["signatures"]!!.jsonArray.map { val s = it.jsonObject; MaintainersSignature(s["pubkey"]!!.jsonPrimitive.content, s["sig"]!!.jsonPrimitive.content) },
    )

    @Test fun everyCase() {
        val leases = v["leases"]!!.jsonArray.map { lease(it.jsonObject) }
        assertEquals(v["v1Digests"]!!.jsonArray.map { it.jsonPrimitive.content }, leases.map { CaLeasePq.v1Digest(it) })
        val now = v["now"]!!.jsonPrimitive.long
        for (c in v["cases"]!!.jsonArray.map { it.jsonObject }) {
            val p = c["pin"]!!.jsonObject
            val pin = CaLeasePq.Pin(p["keyIds"]!!.jsonArray.map { it.jsonPrimitive.content }, p["legacyLeases"]!!.jsonArray.map { it.jsonPrimitive.content })
            val got = CaLeasePq.gate(leases, c["bindings"]!!.jsonArray.toList(), c["endorsements"]!!.jsonArray.toList(), pin, now).map { it.endorsementId }
            assertEquals(c["name"]!!.jsonPrimitive.content, c["accepted"]!!.jsonArray.map { it.jsonPrimitive.content }, got)
        }
    }

    @Test fun theBakedPinMatchesTheProtocolPin() {
        var dir: File? = File(System.getProperty("user.dir")!!).absoluteFile
        var src: String? = null
        while (dir != null && src == null) {
            val f = File(dir, "packages/protocol/src/caLeasePq.ts")
            if (f.isFile) src = f.readText()
            dir = dir.parentFile
        }
        fun ids(field: String) = Regex("$field: Object\\.freeze\\(\\[([^\\]]*)\\]\\)").find(src!!)!!.groupValues[1].split("\"").filterIndexed { i, _ -> i % 2 == 1 }
        assertEquals(ids("keyIds"), CaLeasePq.PIN.keyIds)
        assertEquals(ids("legacyLeases"), CaLeasePq.PIN.legacyLeases)
    }
}
