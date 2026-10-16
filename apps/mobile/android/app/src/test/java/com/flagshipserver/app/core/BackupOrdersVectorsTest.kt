// Pins the backup policy and the scheduled-backup keys deposit to
// packages/protocol/test-vectors/backup-policy and server-archive-keys, read
// from disk so a drift fails here. Mirrors ArchiveDownloadApprovalTest.

package com.flagshipserver.app.core

import com.google.crypto.tink.subtle.Ed25519Sign
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.File

class BackupOrdersVectorsTest {
    private fun vectors(rel: String): JsonObject {
        val candidates = ArrayList<File>()
        System.getProperty("user.dir")?.let { candidates.add(File(it)) }
        runCatching { javaClass.protectionDomain?.codeSource?.location?.toURI()?.let { candidates.add(File(it)) } }
        for (start in candidates) {
            var dir: File? = start.absoluteFile
            var hops = 0
            while (dir != null && hops < 14) {
                val f = File(dir, rel)
                if (f.isFile) return Json.parseToJsonElement(f.readText()).jsonObject
                dir = dir.parentFile
                hops += 1
            }
        }
        fail("could not locate $rel")
        error("unreachable")
    }

    private fun JsonObject.s(k: String): String = this[k]!!.jsonPrimitive.content

    private fun signer(root: JsonObject): Ed25519Sign {
        val seed = ServerKeys.deriveProtocolIrkSeed(HexUtil.decode(root.s("umkSeedHex"))!!)
        val kp = Ed25519Sign.KeyPair.newKeyPairFromSeed(seed)
        assertEquals(root.s("pub"), HexUtil.encode(kp.publicKey))
        return Ed25519Sign(kp.privateKey)
    }

    @Test fun backupPolicyMatchesTheSharedVectors() {
        val root = vectors("packages/protocol/test-vectors/backup-policy/vectors.json")
        val sign = signer(root)
        for (c in root["cases"]!!.jsonArray.map { it.jsonObject }) {
            val o = BackupPolicyOrder(c.s("serverDomain"), c.s("policy"), c["phoneReserveBytes"]!!.jsonPrimitive.long, c["issuedAt"]!!.jsonPrimitive.long)
            assertTrue(o.isValid)
            assertEquals(c.s("canonical"), String(o.canonicalBytes(), Charsets.UTF_8))
            assertEquals(c.s("signature"), HexUtil.encode(sign.sign(o.canonicalBytes())))
        }
        val invalid = root["invalid"]!!.jsonArray.map { it.jsonObject }
        assertTrue(invalid.isNotEmpty())
        for (bad in invalid) {
            val o = BackupPolicyOrder(bad.s("serverDomain"), bad.s("policy"), bad["phoneReserveBytes"]!!.jsonPrimitive.long, bad["issuedAt"]!!.jsonPrimitive.long)
            assertFalse("$bad", o.isValid)
            try {
                o.canonicalBytes()
                fail("canonical bytes for an invalid order: $bad")
            } catch (_: IllegalStateException) {
            }
        }
    }

    @Test fun makeLowercasesAndKeepsTheReserveOnlyForPhone() {
        assertEquals(BackupPolicyOrder("home.harry.flagship.services", "peer", 0, 5), BackupPolicyOrder.make("Home.Harry.flagship.services", "peer", 99, 5))
        assertEquals(7L, BackupPolicyOrder.make("h", "phone", 7, 5).phoneReserveBytes)
    }

    @Test fun archiveKeysMatchTheSharedVectors() {
        val root = vectors("packages/protocol/test-vectors/server-archive-keys/vectors.json")
        val sign = signer(root)
        val umk = HexUtil.decode(root.s("umkSeedHex"))!!
        for (c in root["cases"]!!.jsonArray.map { it.jsonObject }) {
            val keys = c["keys"]!!.jsonArray.map { k ->
                val o = k.jsonObject
                assertEquals(o.s("kekHex"), HexUtil.encode(ServerArchive.deriveKey(umk, o.s("archiveId"))!!))
                ArchiveKey(o.s("archiveId"), o.s("kekHex"))
            }
            assertEquals(c.s("digest"), ArchiveKeys.digest(keys))
            val d = ArchiveKeys.deposit(c.s("serverDomain"), keys, c["issuedAt"]!!.jsonPrimitive.long)
            assertEquals(c.s("canonical"), String(d.canonicalBytes(), Charsets.UTF_8))
            assertEquals(c.s("signature"), HexUtil.encode(sign.sign(d.canonicalBytes())))
            // Minting with the same ids gives the same keys.
            val ids = keys.map { HexUtil.decode(it.archiveId)!! }.iterator()
            assertEquals(keys, ArchiveKeys.mint(umk, keys.size) { ids.next() })
        }
        val invalid = root["invalid"]!!.jsonArray.map { it.jsonObject }
        assertTrue(invalid.isNotEmpty())
        for (bad in invalid) {
            val d = ArchiveKeysDeposit(bad.s("serverDomain"), bad["count"]!!.jsonPrimitive.int, bad.s("digest"), bad["issuedAt"]!!.jsonPrimitive.long)
            assertFalse("$bad", d.isValid)
        }
    }

    @Test fun mintedIdsAreFreshLowercaseHex() {
        val keys = ArchiveKeys.mint(ByteArray(32) { 1 }, 3)
        assertEquals(3, keys.map { it.archiveId }.toSet().size)
        keys.forEach {
            assertTrue(Regex("^[0-9a-f]{32}$").matches(it.archiveId))
            assertTrue(Regex("^[0-9a-f]{64}$").matches(it.kekHex))
        }
    }

    @Test fun theBackupPolicyRidesBesideThePairingOrder() {
        val o = BackupPolicyOrder.make("home.harry.flagship.services", "phone", 34_359_738_368, 1_700_000_000_000)
        val json = ServerBackupFormat.attachBackupPolicy("{\"request\":{},\"signature\":\"ab\"}", o, "cd")
        val p = Json.parseToJsonElement(json).jsonObject["backupPolicy"]!!.jsonObject
        assertEquals("cd", p.s("signatureHex"))
        val order = p["order"]!!.jsonObject
        assertEquals("phone", order.s("policy"))
        assertEquals(34_359_738_368, order["phoneReserveBytes"]!!.jsonPrimitive.long)
        assertEquals("home.harry.flagship.services", order.s("serverDomain"))
    }
}
