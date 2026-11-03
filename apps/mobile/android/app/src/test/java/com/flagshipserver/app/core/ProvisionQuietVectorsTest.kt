package com.flagshipserver.app.core

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.Assert.assertEquals
import org.junit.Assert.fail
import org.junit.Test
import java.io.File

class ProvisionQuietVectorsTest {
    private fun vectors(): JsonObject {
        val rel = "packages/protocol/test-vectors/provision-quiet/vectors.json"
        var dir: File? = File(System.getProperty("user.dir")!!).absoluteFile
        while (dir != null) {
            val f = File(dir, rel)
            if (f.isFile) return Json.parseToJsonElement(f.readText()).jsonObject
            dir = dir.parentFile
        }
        fail("vectors.json not found"); throw IllegalStateException()
    }

    @Test fun everyCaseMatches() {
        val v = vectors()
        assertEquals(v["installerQuietAfterMs"]!!.jsonPrimitive.long, ProvisionQuiet.INSTALLER_QUIET_AFTER_MS)
        assertEquals(v["stuckAfterMs"]!!.jsonPrimitive.long, ProvisionQuiet.STUCK_AFTER_MS)
        assertEquals(v["stuckPhases"]!!.jsonArray.map { it.jsonPrimitive.content }.toSet(), ProvisionQuiet.stuckPhases)
        for (c in v["cases"]!!.jsonArray) {
            val o = c.jsonObject
            val got = ProvisionQuiet.of(o["phase"]!!.jsonPrimitive.content, o["updatedAt"]!!.jsonPrimitive.long, o["nowMs"]!!.jsonPrimitive.long)
            assertEquals(o["name"]!!.jsonPrimitive.content, o["quiet"]!!.jsonPrimitive.content, got.wire)
        }
    }

    @Test fun englishCopyMatchesTheVectors() {
        val copy = vectors()["copy"]!!.jsonObject
        assertEquals(copy["installerFinished"]!!.jsonPrimitive.content, ProvisionQuiet.INSTALLER_FINISHED.detail)
        assertEquals(copy["stuck"]!!.jsonPrimitive.content, ProvisionQuiet.STUCK.detail)
        assertEquals(copy["stuckAdvice"]!!.jsonPrimitive.content, ProvisionQuiet.stuckAdvice())
    }

    @Test fun ladderShowsTheQuietDetailOnTheCurrentRow() {
        val copy = vectors()["copy"]!!.jsonObject
        val t0 = 1_800_000_000_000L
        val staleInstall = ProvisionQuiet.of("installing", t0, t0 + 6 * 60_000L)
        val installing = ProvisionProgress.stepStates("installing", "Installing the bootloader (2 min)", null, staleInstall)
        val cur = installing.single { it.state == ProvisionProgress.StepState.ACTIVE }
        assertEquals(ProvisionProgress.StepKey.INSTALLING, cur.key)
        assertEquals(copy["installerFinished"]!!.jsonPrimitive.content, cur.detail)

        val stuck = ProvisionQuiet.of("downloading", t0, t0 + 25 * 60_000L)
        val downloading = ProvisionProgress.stepStates("downloading", null, null, stuck)
        val row = downloading.single { it.state == ProvisionProgress.StepState.ACTIVE }
        assertEquals(ProvisionProgress.StepKey.INSTALLING, row.key)
        assertEquals(copy["stuck"]!!.jsonPrimitive.content, row.detail)
        assertEquals(0, downloading.count { it.state == ProvisionProgress.StepState.FAILED })

        val fresh = ProvisionProgress.stepStates("installing", null, null, ProvisionQuiet.of("installing", t0, t0 + 60_000L))
        assertEquals(ProvisionProgress.phaseTitles["installing"], fresh.single { it.state == ProvisionProgress.StepState.ACTIVE }.detail)
    }
}
