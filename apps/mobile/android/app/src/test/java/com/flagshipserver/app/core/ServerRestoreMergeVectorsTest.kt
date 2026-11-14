// Pins ServerRestoreMerge to packages/protocol/test-vectors/server-restore-merge. Mirrors the iOS
// ServerRestoreMergeVectorTests and the webapp's webappRestoreMerge test.
package com.flagshipserver.app.core

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.Assert.assertEquals
import org.junit.Assert.fail
import org.junit.Test
import java.io.File

class ServerRestoreMergeVectorsTest {
    private val v: JsonObject by lazy {
        val rel = "packages/protocol/test-vectors/server-restore-merge/vectors.json"
        var dir: File? = File(System.getProperty("user.dir") ?: ".").absoluteFile
        var hops = 0
        while (dir != null && hops < 14) {
            val f = File(dir, rel)
            if (f.isFile) return@lazy Json.parseToJsonElement(f.readText()).jsonObject
            dir = dir.parentFile
            hops += 1
        }
        fail("could not locate $rel")
        error("unreachable")
    }

    private fun JsonObject.s(k: String) = this[k]?.jsonPrimitive?.contentOrNull
    private fun JsonObject.l(k: String) = this[k]!!.jsonPrimitive.long

    private fun line(o: JsonObject) = ServerRestoreMerge.PlanLine(
        archivedServiceId = o.s("archivedServiceId")!!,
        action = o.s("action")!!,
        targetServiceId = o.s("targetServiceId"),
        sameApp = o["sameApp"]?.jsonPrimitive?.booleanOrNull ?: false,
        guardCode = o.s("guardCode"),
        guardSchema = o.s("guardSchema"),
        guardGen = o["guardGen"]?.jsonPrimitive?.intOrNull,
    )

    @Test
    fun canonicalBytesAndPlanDigest() {
        val stage = v["stage"]!!.jsonObject
        val so = stage["order"]!!.jsonObject
        val sb = ServerRestoreMerge.stageBytes(ServerRestoreMerge.StageOrder(so.s("serverDomain")!!, so.s("archiveId")!!, so.l("bytes"), so.s("sha256")!!, so.s("source")!!, so.l("issuedAt")))
        assertEquals(stage.s("canonical"), sb.toString(Charsets.UTF_8))

        val plan = v["plan"]!!.jsonObject
        val lines = plan["lines"]!!.jsonArray.map { line(it.jsonObject) }
        assertEquals(plan.s("planSha256"), ServerRestoreMerge.planSha256(lines))
        assertEquals(plan.s("planSha256"), ServerRestoreMerge.planSha256(lines.reversed()))

        val merge = v["merge"]!!.jsonObject
        val mo = merge["order"]!!.jsonObject
        val mb = ServerRestoreMerge.mergeBytes(ServerRestoreMerge.MergeOrder(mo.s("serverDomain")!!, mo.s("restoreId")!!, mo.s("archiveId")!!, mo.s("sha256")!!, mo.s("planSha256")!!, mo.l("issuedAt"), mo.l("expiresAt")))
        assertEquals(merge.s("canonical"), mb.toString(Charsets.UTF_8))

        for (u in v["undo"]!!.jsonArray) {
            val o = u.jsonObject["order"]!!.jsonObject
            val b = ServerRestoreMerge.undoBytes(ServerRestoreMerge.UndoOrder(o.s("serverDomain")!!, o.s("restoreId")!!, o.s("serviceId")!!, o.s("action")!!, o.l("issuedAt")))
            assertEquals(u.jsonObject.s("canonical"), b.toString(Charsets.UTF_8))
        }
    }

    @Test
    fun refusesTheLinesTheBoxRefuses() {
        for (c in v["invalidLines"]!!.jsonArray) {
            val name = c.jsonObject.s("name")
            try {
                ServerRestoreMerge.lineString(line(c.jsonObject["line"]!!.jsonObject))
                fail("accepted: $name")
            } catch (_: IllegalArgumentException) {
            }
        }
    }
}
