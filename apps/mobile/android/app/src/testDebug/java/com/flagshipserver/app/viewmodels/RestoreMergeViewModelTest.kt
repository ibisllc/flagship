// Restore a backup into a running server against the mock box (docs/restore-into-server.md §7).
// Mirrors the iOS RestoreMergeViewModelTests.

package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.api.MockScreensClient
import com.flagshipserver.app.api.SavedBackup
import com.flagshipserver.app.core.HexUtil
import com.flagshipserver.app.core.RestoreMergeText
import com.flagshipserver.app.core.ServerBackupFormat
import com.flagshipserver.app.core.ServerRestoreMerge
import com.google.crypto.tink.subtle.Ed25519Sign
import com.google.crypto.tink.subtle.Ed25519Verify
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.File
import java.nio.file.Files

class RestoreMergeViewModelTest {
    private val fqdn = "home.demo.flagship.services"
    private val kp = Ed25519Sign.KeyPair.newKeyPair()

    private val v: JsonObject by lazy {
        val rel = "packages/protocol/test-vectors/server-backup/vectors.json"
        var dir: File? = File(System.getProperty("user.dir") ?: ".").absoluteFile
        repeat(14) {
            val f = File(dir, rel)
            if (f.isFile) return@lazy Json.parseToJsonElement(f.readText()).jsonObject
            dir = dir?.parentFile
        }
        fail("could not locate $rel")
        throw IllegalStateException()
    }
    private fun s(k: String) = v[k]!!.jsonPrimitive.content

    private class World(val c: MockScreensClient, val m: RestoreMergeViewModel, val archiveId: String)

    private fun world(admin: Boolean = true): World {
        val c = MockScreensClient(simulatedLatencyMs = 0)
        val id = s("archiveId")
        c.savedBackupsList.clear()
        c.savedBackupsList += SavedBackup(archiveId = id, createdAt = 1_793_700_000_000, bytes = 1, sha256 = "00".repeat(32), backupFileName = "home.flagship-backup", dataFileName = "home.flagship-data")
        c.restoreMergeSavedFiles[id] = s("file").toByteArray()
        val kek = HexUtil.decode(s("accountKekHex"))!!
        val m = RestoreMergeViewModel(
            serverFqdn = fqdn,
            client = c,
            isAdmin = admin,
            sign = { _, bytes -> Ed25519Sign(kp.privateKey).sign(bytes) },
            accountKek = { kek },
            now = { 1_794_000_000_000 },
            pollMs = 1,
        )
        return World(c, m, id)
    }

    private fun verify(sigHex: String, bytes: ByteArray) = Ed25519Verify(kp.publicKey).verify(HexUtil.decode(sigHex)!!, bytes)

    @Test fun opensASavedBackupUnderASignedStageAndPreselectsTheSafeDefaults() = runBlocking {
        val w = world()
        w.m.start(RestoreMergeViewModel.Source.Saved(w.archiveId))
        assertEquals(RestoreMergeViewModel.Phase.Choosing, w.m.phase)
        val stage = w.c.restoreMergeStages.single()
        assertEquals("saved", stage.order.source)
        assertEquals(fqdn, stage.order.serverDomain)
        verify(stage.signatureHex, ServerRestoreMerge.stageBytes(ServerRestoreMerge.StageOrder(stage.order.serverDomain, stage.order.archiveId, stage.order.bytes, stage.order.sha256, stage.order.source, stage.order.issuedAt)))
        assertEquals(1, w.c.restoreMergeCommits.size)
        assertEquals("keep", w.m.choices["demo--notes"]?.action)
        assertEquals("install", w.m.choices["demo--todo"]?.action)
        assertEquals("skip", w.m.choices["demo--chess"]?.action)
        assertEquals("copy", w.m.choices["sam--blog"]?.action)
        assertEquals(listOf("blog"), w.m.apps(RestoreMergeViewModel.Group.DIFFERENT).map { it.name })
    }

    @Test fun theSignedPlanIsExactlyTheChoicesWithTheGuards() = runBlocking {
        val w = world()
        w.m.start(RestoreMergeViewModel.Source.Saved(w.archiveId))
        val notes = w.m.preview!!.apps.first { it.archivedServiceId == "demo--notes" }
        w.m.choose(notes, "replace")
        w.m.choose(notes, "install")
        assertEquals("an action the box refused is never chosen", "replace", w.m.choices["demo--notes"]?.action)
        w.m.restore()
        assertEquals(RestoreMergeViewModel.Phase.Done, w.m.phase)
        val plan = w.c.restoreMergePlans.single()
        val replace = plan.lines.first { it.archivedServiceId == "demo--notes" }
        assertEquals(notes.guards?.guardCode, replace.guardCode)
        assertEquals(0, replace.guardGen)
        assertEquals("demo--blog-restored", plan.lines.first { it.archivedServiceId == "sam--blog" }.targetServiceId)
        val sha = ServerRestoreMerge.planSha256(plan.lines.map { ServerRestoreMerge.PlanLine(it.archivedServiceId, it.action, it.targetServiceId, it.sameApp, it.guardCode, it.guardSchema, it.guardGen) })
        assertEquals(sha, plan.order.planSha256)
        val o = plan.order
        verify(plan.signatureHex, ServerRestoreMerge.mergeBytes(ServerRestoreMerge.MergeOrder(o.serverDomain, o.restoreId, o.archiveId, o.sha256, o.planSha256, o.issuedAt, o.expiresAt)))
        assertEquals(listOf("demo--notes"), w.m.undoPoints.map { it.serviceId })
    }

    @Test fun restoreStaysOffWithOnlyKeepAndSkipOrABadCopyName() = runBlocking {
        val w = world()
        w.m.start(RestoreMergeViewModel.Source.Saved(w.archiveId))
        w.m.preview!!.apps.forEach { w.m.choose(it, if ("keep" in it.allowed) "keep" else "skip") }
        assertFalse(w.m.canRestore)
        val blog = w.m.preview!!.apps.first { it.name == "blog" }
        w.m.choose(blog, "copy")
        w.m.setCopyName(blog, "Bad Name")
        assertFalse(w.m.canRestore)
        w.m.setCopyName(blog, "blog-2")
        assertTrue(w.m.canRestore)
    }

    @Test fun theBoxRefusalIsShownAndUndoIsSigned() = runBlocking {
        val w = world()
        w.m.start(RestoreMergeViewModel.Source.Saved(w.archiveId))
        w.c.restoreMergeNextRefusal = "plan-guard-mismatch" to "An app changed since you chose. Look at the choices again."
        w.m.restore()
        assertEquals("An app changed since you chose. Look at the choices again.", w.m.actionError)
        val notes = w.m.preview!!.apps.first { it.archivedServiceId == "demo--notes" }
        w.m.choose(notes, "replace")
        w.m.restore()
        val p = w.m.undoPoints.first()
        w.m.undo(p, discard = false)
        val u = w.c.restoreMergeUndos.single()
        assertEquals("undo", u.order.action)
        verify(u.signatureHex, ServerRestoreMerge.undoBytes(ServerRestoreMerge.UndoOrder(u.order.serverDomain, u.order.restoreId, u.order.serviceId, u.order.action, u.order.issuedAt)))
        assertTrue(w.m.undoPoints.isEmpty())
    }

    @Test fun aBackupFileIsSentInPartsFromWhereTheBoxHasGotTo() = runBlocking {
        val w = world()
        val dataBytes = ByteArray(RestoreMergeViewModel.CHUNK_BYTES + 5_000) { (it % 251).toByte() }
        val sha = java.security.MessageDigest.getInstance("SHA-256").digest(dataBytes).joinToString("") { "%02x".format(it) }
        val id = "ab".repeat(16)
        val contentKey = ByteArray(32) { 3 }
        val kek = HexUtil.decode(s("accountKekHex"))!!
        val body = """{"createdAt":1793700000000,"server":{"name":"home","domain":"$fqdn","bootUnlockMode":"auto","diskEncryption":"luks"},""" +
            """"apps":[],"left":[],"includes":[],"excludes":[],"data":{"fileName":"home.flagship-data","bytes":${dataBytes.size},"sha256":"$sha","frameBytes":1024}}"""
        val slot = ServerBackupFormat.wrapAccountSlot(id, contentKey, kek, ByteArray(12) { 1 })
        val meta = ServerBackupFormat.serialize(ServerBackupFormat.sealFile(id, contentKey, listOf(slot), body.toByteArray(), ByteArray(12) { 2 })).toByteArray()
        val bundle = Files.createTempFile("home", ".flagship").toFile()
        try {
            val head = java.nio.ByteBuffer.allocate(16).put("FLGSHBK1".toByteArray()).putLong(meta.size.toLong()).array()
            bundle.writeBytes(head + meta + dataBytes)
            w.m.start(RestoreMergeViewModel.Source.FileSource(LocalPickedFile(bundle)))
            assertEquals(RestoreMergeViewModel.Phase.Choosing, w.m.phase)
            val stage = w.c.restoreMergeStages.single().order
            assertEquals("upload", stage.source)
            assertEquals(dataBytes.size.toLong(), stage.bytes)
            assertEquals(sha, stage.sha256)
            assertEquals(HexUtil.encode(contentKey), w.c.restoreMergeCommits.single())
        } finally {
            bundle.delete()
        }
    }

    @Test fun aBackupFileCutShortIsRefusedBeforeAnythingIsSent() = runBlocking {
        val w = world()
        val bundle = Files.createTempFile("home", ".flagship").toFile()
        try {
            val meta = s("file").toByteArray()
            val head = java.nio.ByteBuffer.allocate(16).put("FLGSHBK1".toByteArray()).putLong(meta.size.toLong()).array()
            bundle.writeBytes(head + meta + ByteArray(7))
            w.m.start(RestoreMergeViewModel.Source.FileSource(LocalPickedFile(bundle)))
            assertTrue(w.m.phase is RestoreMergeViewModel.Phase.Failed)
            assertTrue(w.c.restoreMergeStages.isEmpty())
        } finally {
            bundle.delete()
        }
    }

    @Test fun cancellingBeforeThePlanDropsTheStaging() = runBlocking {
        val w = world()
        w.m.start(RestoreMergeViewModel.Source.Saved(w.archiveId))
        w.m.cancel()
        assertEquals(1, w.c.restoreMergeCancels)
        assertEquals(RestoreMergeViewModel.Phase.Idle, w.m.phase)
    }

    @Test fun theWordsForEachAction() {
        val a = MockScreensClient.RestoreMergeDemo.apps()[0]
        assertEquals("The backup is older: 1.2.0 vs 1.4.0", RestoreMergeText.comparison(a))
        assertEquals("It is being changed right now. Try again when that is done.", RestoreMergeText.refusal("busy"))
        assertEquals(listOf("Jobs saved in the backup may run again.", "Files the app keeps are read as the backup left them."), RestoreMergeText.notes(a, "replace"))
    }

    @Test fun aNonAdminDeviceCannotStart() = runBlocking {
        val w = world(admin = false)
        w.m.start(RestoreMergeViewModel.Source.Saved(w.archiveId))
        assertEquals(RestoreMergeViewModel.Phase.Failed("Only an admin device of this account can restore a backup."), w.m.phase)
        assertTrue(w.c.restoreMergeStages.isEmpty())
    }
}
