// Runs packages/protocol/test-vectors/peer-backup/vectors.json (the device's
// side of docs/peer-backup.md): the PBK a device makes for any of its servers
// and the opening of the lost server's sealed record, read from disk so a
// drift fails here. The box-side parts of the file (bricks, merkle, filler,
// tokens) are the daemon's and are covered by its own tests.

package com.flagshipserver.app.core

import com.flagshipserver.app.api.PeerBackupHolder
import com.flagshipserver.app.api.PeerBackupHosting
import com.flagshipserver.app.api.PeerBackupRepairStatus
import com.flagshipserver.app.api.PeerBackupStats
import com.flagshipserver.app.api.PeerBackupStatusResponse
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.File

class PeerBackupVectorsTest {

    private fun vectorsFile(): File {
        val rel = "packages/protocol/test-vectors/peer-backup/vectors.json"
        val candidates = ArrayList<File>()
        System.getProperty("user.dir")?.let { candidates.add(File(it)) }
        runCatching { javaClass.protectionDomain?.codeSource?.location?.toURI()?.let { candidates.add(File(it)) } }
        for (start in candidates) {
            var dir: File? = start.absoluteFile
            var hops = 0
            while (dir != null && hops < 14) {
                val f = File(dir, rel)
                if (f.isFile) return f
                dir = dir.parentFile
                hops += 1
            }
        }
        fail("could not locate $rel")
        error("unreachable")
    }

    private val v: JsonObject by lazy { Json.parseToJsonElement(vectorsFile().readText()).jsonObject }
    private fun s(k: String) = v[k]!!.jsonPrimitive.content
    private val seed: ByteArray get() = HexUtil.decode(s("umkSeedHex"))!!
    private val sealed: PeerBackup.SealedRoot by lazy {
        val o = v["root"]!!.jsonObject["sealed"]!!.jsonObject
        PeerBackup.SealedRoot(o["nonceHex"]!!.jsonPrimitive.content, o["ciphertextHex"]!!.jsonPrimitive.content)
    }

    @Test fun derivesTheSwkAndPbkOfTheVector() {
        assertEquals(s("swkHex"), HexUtil.encode(ServerKeys.deriveSwk(seed, s("serverId"))))
        assertEquals(s("pbkHex"), PeerBackup.derivePbkHex(seed, s("serverId")))
    }

    @Test fun addressesAreNormalisedAndGarbageIsRefused() {
        assertEquals(s("pbkHex"), PeerBackup.derivePbkHex(seed, "  ${s("serverId").uppercase()} "))
        assertThrows(PeerBackup.PeerBackupException::class.java) { PeerBackup.derivePbkHex(seed, "a|b") }
        assertThrows(PeerBackup.PeerBackupException::class.java) { PeerBackup.derivePbkHex(seed, "") }
    }

    @Test fun opensTheSealedRootAndRefusesAnotherServerOrKey() {
        val root = PeerBackup.openSealedRoot(sealed, s("pbkHex"), s("serverId"))
        assertEquals("3", root["generation"]!!.jsonPrimitive.content)
        assertEquals("00112233445566778899aabbccddeeff", root["archive"]!!.jsonObject["archiveId"]!!.jsonPrimitive.content)
        val other = assertThrows(PeerBackup.PeerBackupException::class.java) {
            PeerBackup.openSealedRoot(sealed, s("pbkHex"), "other.harry.flagship.services")
        }
        assertTrue(other.message!!, other.message!!.contains("doesn't open"))
        assertThrows(PeerBackup.PeerBackupException::class.java) {
            PeerBackup.openSealedRoot(sealed, "00".repeat(32), s("serverId"))
        }
    }

    @Test fun summarisesARecordLikeTheBoxDoes() {
        val sum = PeerBackup.summaryOfRoot(PeerBackup.openSealedRoot(sealed, s("pbkHex"), s("serverId")))
        assertEquals(s("serverId"), sum.serverId)
        assertEquals(3L, sum.generation)
        assertEquals(2L, sum.revision)
        assertEquals(1, sum.holders)
        assertEquals(1, sum.needed)
        assertEquals(1_799_776_000_000L, sum.keepUntil)
        assertEquals(1000L, sum.archive.bytes)
        assertEquals("00112233445566778899aabbccddeeff", sum.archive.archiveId)
    }

    // ── The status page's words (same sentences as the webapp) ─────

    private fun status(holders: List<PeerBackupHolder>? = null, hosting: PeerBackupHosting? = null) = PeerBackupStatusResponse(
        participating = true,
        peersBackingYouUp = emptyList(),
        peersYouBackUp = emptyList(),
        shards = emptyList(),
        repair = PeerBackupRepairStatus("idle", null, 0, 0),
        stats = PeerBackupStats(0, 0, 0, 0, 0),
        v = 2,
        holderList = holders,
        hosting = hosting,
    )

    @Test fun holderRowsReadLikeTheWebapp() {
        val rows = PeerBackup.holderRows(
            status(listOf(PeerBackupHolder("Server 1", "ok", 1_000, 12), PeerBackupHolder("Server 2", "failing", null, 1))),
            formatTime = { "T$it" },
        )
        assertEquals("Answering · last proof T1000 · 12 pieces", rows[0].line)
        assertEquals("Not answering · no proof yet · 1 piece", rows[1].line)
    }

    @Test fun restoreByAndHostingLines() {
        assertEquals("", PeerBackup.restoreByLine(null))
        assertEquals("The pieces of this backup are no longer kept.", PeerBackup.restoreByLine(5, now = 10))
        assertEquals("Restore by D (2 days left).", PeerBackup.restoreByLine(2 * 86_400_000L - 1, now = 0, formatDate = { "D" }))
        assertEquals(emptyList<String>(), PeerBackup.hostingLines(status()))
        val gb = 1024L * 1024 * 1024
        val lines = PeerBackup.hostingLines(status(hosting = PeerBackupHosting(poolBytes = 4 * gb, realBytes = gb, fillerBytes = 3 * gb, provenBytes = gb, leaving = true)))
        assertEquals("Pool: 4.0 GB, of which 1.0 GB holds other servers' pieces and 3.0 GB is proof filler.", lines[0])
        assertEquals("Proven so far: 1.0 GB.", lines[1])
        assertEquals("This server is leaving peer backups.", lines[2])
    }

    @Test fun stateWords() {
        assertEquals("Protected", PeerBackup.stateTitle("protected"))
        assertEquals("Peer backup starts once enough other servers can hold it.", PeerBackup.stateNote("waiting-for-peers"))
    }
}
