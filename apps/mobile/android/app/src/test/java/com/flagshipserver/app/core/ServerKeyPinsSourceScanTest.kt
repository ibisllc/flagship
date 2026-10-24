package com.flagshipserver.app.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/** docs/first-contact.md: a real box's key is random, so nothing in the app may derive one, and
 *  the approval path never takes `.com`'s listing as the key. */
class ServerKeyPinsSourceScanTest {
    private val root: File by lazy {
        var dir = File(".").absoluteFile
        while (!File(dir, "app/src/main/java/com/flagshipserver/app").exists()) dir = dir.parentFile
        dir
    }

    private fun sources(): List<File> = listOf("app/src/main", "app/src/debug", "wear/src/main", "companion/src/main")
        .map { File(root, it) }.filter { it.exists() }
        .flatMap { d -> d.walkTopDown().filter { it.isFile && it.extension == "kt" }.toList() }

    @Test fun noAppCodeDerivesAServerKey() {
        val files = sources()
        assertTrue(files.size > 100)
        val hits = files.filter { f -> f.readText().let { "deriveStk" in it || "flagship.stk.v1" in it } }
        assertEquals("derives a server key: ${hits.map { it.name }}", emptyList<File>(), hits)
    }

    @Test fun theApprovalPathTrustsOnlyThePin() {
        val src = File(root, "app/src/main/java/com/flagshipserver/app")
        val coordinator = File(src, "core/SecretRequestCoordinator.kt").readText()
        assertFalse(coordinator.contains("fetchPods("))
        assertFalse(coordinator.contains("identityPubKey"))
        assertTrue(coordinator.contains("firstContact.judge("))
        for (f in listOf("core/CertPinRegistry.kt", "core/RelayTrustAggregator.kt", "core/SwkDepositCoordinator.kt", "core/WatchBootKey.kt")) {
            val text = File(src, f).readText()
            assertTrue("$f reads the pin", text.contains("pinnedStk"))
            assertFalse("$f decodes `.com`'s key", Regex("""HexUtil\.decode\([a-z.]*identityPubKey""").containsMatchIn(text))
        }
    }
}
