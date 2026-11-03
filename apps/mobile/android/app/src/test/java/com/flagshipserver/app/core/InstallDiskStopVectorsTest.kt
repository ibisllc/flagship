package com.flagshipserver.app.core

import com.flagshipserver.app.builder.AssetPreseedSource
import com.flagshipserver.app.builder.TargetDisk
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.File

/** test-vectors/install-disk-stop.json: the burn option `targetDisk` and the installer's disk stops. */
class InstallDiskStopVectorsTest {
    private val v: JsonObject by lazy { Json.parseToJsonElement(vectorsFile().readText()).jsonObject }

    @Test
    fun targetDiskPatternMatchesTheGenerator() {
        assertEquals(v["targetDiskPattern"]!!.jsonPrimitive.content, TargetDisk.PATTERN.pattern)
        val td = v["targetDisk"]!!.jsonObject
        for (ok in td["valid"]!!.jsonArray.map { it.jsonPrimitive.content }) {
            assertTrue(ok, TargetDisk.isValid(ok))
            assertTrue(ok, TargetDisk.isValid("  $ok \n"))
            assertEquals(ok, TargetDisk.normalized(" $ok "))
        }
        for (bad in td["invalid"]!!.jsonArray.map { it.jsonPrimitive.content }) assertFalse(bad, TargetDisk.isValid(bad))
        assertTrue(TargetDisk.isValid("   "))
        assertNull(TargetDisk.normalized("   "))
    }

    @Test
    fun burnOptionsCarryTheTargetDiskOnlyWhenSet() {
        val without = Json.parseToJsonElement(AssetPreseedSource.burnOptsJson("https://boot.example", null)).jsonObject
        assertEquals(setOf("bootHost"), without.keys)
        val with = Json.parseToJsonElement(AssetPreseedSource.burnOptsJson("https://boot.example", "serial:S64ANS0T123456")).jsonObject
        assertEquals("serial:S64ANS0T123456", with["targetDisk"]!!.jsonPrimitive.content)
        assertEquals("https://boot.example", with["bootHost"]!!.jsonPrimitive.content)
    }

    @Test
    fun stopsBecomeTheAppsSentenceAndTheReburnAdvice() {
        for (case in v["stops"]!!.jsonArray.map { it.jsonObject }) {
            val detail = case["detail"]!!.jsonPrimitive.content
            val kind = case["kind"]!!.let { if (it is JsonNull) null else it.jsonPrimitive.content }
            val stop = InstallDiskStop.parse(detail)
            assertEquals(detail, kind, stop?.kind)
            when (stop) {
                null -> assertFalse(detail, InstallDiskStop.isStopText(ProvisionProgress.failureDetail(detail)))
                is InstallDiskStop.Several -> {
                    assertEquals(case["count"]!!.jsonPrimitive.content, stop.count)
                    assertEquals(case["sizes"]!!.jsonPrimitive.content, stop.sizes)
                }
                is InstallDiskStop.Missing -> assertEquals(case["pin"]!!.jsonPrimitive.content, stop.pin)
                is InstallDiskStop.Ambiguous -> assertEquals(case["pin"]!!.jsonPrimitive.content, stop.pin)
                InstallDiskStop.NoDisk -> {}
            }
            if (stop != null) {
                val shown = ProvisionProgress.failureDetail(detail)!!
                assertTrue(shown, shown.endsWith(" " + InstallDiskStop.advice))
                assertFalse("the installer's English is replaced: $shown", shown.contains("this machine"))
                assertTrue(InstallDiskStop.isStopText(shown))
            }
        }
        assertEquals(
            "This computer has 2 disks the installer could erase (500 GB, 2000 GB), so it stopped. Nothing was erased. " + InstallDiskStop.advice,
            ProvisionProgress.failureDetail("This machine has 2 disks that could be erased (500 GB, 2000 GB). Nothing was erased. Name the disk to install on and make the installer again."),
        )
    }

    @Test
    fun otherFailuresKeepTheBoxsWords() {
        assertEquals("Setup stopped while Expanding the disk to 68 GB", ProvisionProgress.failureDetail("Setup stopped while Expanding the disk to 68 GB (line 66)"))
        assertEquals("Disk full", ProvisionProgress.failureDetail("Disk full"))
    }

    @Test
    fun aDiskStopSuggestsMakingTheInstallerAgainNotCancelling() {
        val cancel = "Cancel this order."
        val stop = ProvisionProgress.failureDetail("The disk this installer was made for (serial:NOPE) is not in this machine. Nothing was erased.")
        val text = InstallDiskStop.setupStoppedExplanation("This server didn't finish installing", stop, cancel)
        assertTrue(text, text.startsWith("This server didn't finish installing. The disk this installer was made for (serial:NOPE) isn't in this computer."))
        assertFalse(text, text.contains(cancel))
        assertEquals(
            "This server didn't finish installing. Disk full. Cancel this order.",
            InstallDiskStop.setupStoppedExplanation("This server didn't finish installing", "Disk full", cancel),
        )
        assertEquals(
            "This server didn't finish installing. Cancel this order.",
            InstallDiskStop.setupStoppedExplanation("This server didn't finish installing", null, cancel),
        )
    }

    private fun vectorsFile(): File {
        val rel = "test-vectors/install-disk-stop.json"
        var dir: File? = File(System.getProperty("user.dir")).absoluteFile
        repeat(12) {
            val f = dir?.let { File(it, rel) }
            if (f != null && f.isFile) return f
            dir = dir?.parentFile
        }
        fail("could not locate $rel")
        error("unreachable")
    }
}
