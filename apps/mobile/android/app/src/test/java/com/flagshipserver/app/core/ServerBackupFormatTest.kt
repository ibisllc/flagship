// Pins ServerBackupFormat to packages/protocol/test-vectors/server-backup and
// server-restore, read from disk so a drift fails here. Mirrors the iOS
// ServerBackupFormatTests and ServerBackupPasscodeTests.

package com.flagshipserver.app.core

import com.flagshipserver.app.api.ServerBackupKdf
import com.google.crypto.tink.subtle.Ed25519Sign
import com.google.crypto.tink.subtle.Ed25519Verify
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.int
import kotlinx.serialization.json.long
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.File
import java.security.MessageDigest

class ServerBackupFormatTest {
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

    private val b: JsonObject by lazy { vectors("packages/protocol/test-vectors/server-backup/vectors.json") }
    private val r: JsonObject by lazy { vectors("packages/protocol/test-vectors/server-restore/vectors.json") }
    private fun JsonObject.s(k: String): String = this[k]!!.jsonPrimitive.content
    private fun JsonObject.hex(k: String): ByteArray = HexUtil.decode(s(k))!!
    private fun kdf(e: JsonElement?): ServerBackupKdf {
        val k = e!!.jsonObject
        return ServerBackupKdf(m = k["m"]!!.jsonPrimitive.int, t = k["t"]!!.jsonPrimitive.int, p = k["p"]!!.jsonPrimitive.int, saltHex = k.s("saltHex"))
    }
    private fun file(text: String) = ServerBackupFormat.parse(text.toByteArray())
    private fun kindOf(block: () -> Unit): ServerBackupFormat.FormatException.Kind? = try {
        block()
        null
    } catch (e: ServerBackupFormat.FormatException) {
        e.kind
    }

    @Test fun recreatesTheSlotsAndTheWholeFileByteForByte() {
        val id = b.s("archiveId")
        val key = b.hex("contentKeyHex")
        val accountKek = b.hex("accountKekHex")
        assertEquals(b.s("accountKekHex"), HexUtil.encode(ServerArchive.deriveKey(b.hex("umkSeedHex"), id)!!))
        val slots = b["slots"]!!.jsonObject
        val n = b["slotNonces"]!!.jsonObject
        val passSlot = ServerBackupFormat.parseSlot(slots["passcode"])!!
        val acctSlot = ServerBackupFormat.parseSlot(slots["account"])!!
        val passKek = ServerBackupFormat.passcodeKek(b.s("passcode"), passSlot.kdf!!)
        assertEquals(b.s("passcodeKekHex"), HexUtil.encode(passKek))
        assertEquals(passSlot, ServerBackupFormat.wrapPasscodeSlot(id, key, passKek, passSlot.kdf!!, n.hex("passcodeNonceHex")))
        assertEquals(acctSlot, ServerBackupFormat.wrapAccountSlot(id, key, accountKek, n.hex("accountNonceHex")))

        val text = b.s("file")
        val f = file(text)
        assertEquals(listOf(passSlot, acctSlot), f.slots)
        assertEquals(text, ServerBackupFormat.serialize(f))
        val bodyJson = Json.encodeToString(JsonElement.serializer(), b["body"]!!).toByteArray()
        val resealed = ServerBackupFormat.sealFile(id, key, listOf(passSlot, acctSlot), bodyJson, n.hex("bodyNonceHex"))
        assertEquals(text, ServerBackupFormat.serialize(resealed))
    }

    @Test fun opensTheFileBothWays() {
        val f = file(b.s("file"))
        val viaAccount = ServerBackupFormat.openWithAccountKey(f, b.hex("accountKekHex"))!!
        assertEquals("account", viaAccount.via)
        assertEquals(b.s("contentKeyHex"), HexUtil.encode(viaAccount.contentKey))
        val viaPass = ServerBackupFormat.openWithPasscode(f, b.s("passcode"))
        assertEquals("passcode", viaPass.via)
        assertArrayEquals(viaAccount.contentKey, viaPass.contentKey)
        assertEquals(viaAccount.body, viaPass.body)
        val body = viaPass.body
        assertEquals("home", body.server.name)
        assertEquals("home.harry.flagship.services", body.server.domain)
        assertEquals("approve", body.server.bootUnlockMode)
        assertEquals("luks", body.server.diskEncryption)
        assertEquals(listOf("Notes", "Chess Club"), body.apps.map { it.name })
        assertEquals(1, body.left.size)
        assertEquals(123_456_789L, body.data.bytes)
        assertEquals("ab".repeat(32), body.data.sha256)
        assertEquals(1_048_576, body.data.frameBytes)
        assertEquals(b["body"]!!.jsonObject["createdAt"]!!.jsonPrimitive.long, body.createdAt)

        // Another account's key opens nothing; a wrong passcode is refused.
        val other = ServerArchive.deriveKey(b.hex("wrongUmkSeedHex"), b.s("archiveId"))!!
        assertNull(ServerBackupFormat.openWithAccountKey(f, other))
        assertEquals(ServerBackupFormat.FormatException.Kind.WRONG_PASSCODE, kindOf { ServerBackupFormat.openWithPasscode(f, b.s("wrongPasscode")) })
        assertEquals(ServerBackupFormat.FormatException.Kind.WRONG_PASSCODE, kindOf { ServerBackupFormat.openWithPasscodeKey(f, ByteArray(32)) })
        val accountOnly = f.copy(slots = f.slots.filter { it.kind == "account" })
        assertEquals(ServerBackupFormat.FormatException.Kind.NO_PASSCODE, kindOf { ServerBackupFormat.openWithPasscode(accountOnly, b.s("passcode")) })
    }

    @Test fun refusesTamperedFiles() {
        val accountKek = b.hex("accountKekHex")
        val passKek = b.hex("passcodeKekHex")
        val cases = b["tampered"]!!.jsonArray.map { it.jsonObject }
        assertEquals(4, cases.size)
        for (t in cases) {
            val why = t.s("why")
            val f = file(t.s("file"))
            assertNotNull(why, kindOf { ServerBackupFormat.openWithPasscodeKey(f, passKek) })
            val acct = try {
                ServerBackupFormat.openWithAccountKey(f, accountKek)
            } catch (_: ServerBackupFormat.FormatException) {
                null
            }
            if (why == "passcode params changed") {
                assertEquals(why, "account", acct?.via)
            } else {
                assertNull(why, acct)
            }
        }
    }

    @Test fun refusesMalformedFiles() {
        val cases = b["malformed"]!!.jsonArray.map { it.jsonObject }
        assertEquals(8, cases.size)
        for (m in cases) {
            val why = m.s("why")
            val kind = kindOf { file(m.s("file")) }
            assertNotNull(why, kind)
            if (m.s("code") == "version") {
                assertTrue(why, kind == ServerBackupFormat.FormatException.Kind.NEWER_VERSION || kind == ServerBackupFormat.FormatException.Kind.OLDER_VERSION)
            } else {
                assertTrue(why, kind == ServerBackupFormat.FormatException.Kind.NOT_A_BACKUP || kind == ServerBackupFormat.FormatException.Kind.DAMAGED)
            }
        }
        assertEquals(ServerBackupFormat.FormatException.Kind.NEWER_VERSION, kindOf { file(cases.first { it.s("why") == "newer version" }.s("file")) })
        assertEquals(ServerBackupFormat.FormatException.Kind.OLDER_VERSION, kindOf { file(cases.first { it.s("why") == "old version" }.s("file")) })
        assertEquals("This backup is from a newer version of Flagship. Update the app and try again.", ServerBackupFormat.FormatException.Kind.NEWER_VERSION.message)
    }

    @Test fun passcodeRulesGeneratorAndNormalization() {
        val rules = b["passcodeRules"]!!.jsonObject
        for (p in rules["ok"]!!.jsonArray.map { it.jsonPrimitive.content }) assertNull(p, ServerBackupFormat.passcodeProblem(p))
        for (p in rules["weak"]!!.jsonArray.map { it.jsonPrimitive.content }) assertNotNull(p, ServerBackupFormat.passcodeProblem(p))
        assertEquals(b.s("alphabet"), ServerBackupFormat.PASSCODE_ALPHABET)
        val g = b["generatedPasscode"]!!.jsonObject
        var bytes = g.hex("rngBytesHex")
        val made = ServerBackupFormat.generatePasscode { n ->
            val out = bytes.copyOfRange(0, n)
            bytes = bytes.copyOfRange(n, bytes.size)
            out
        }
        assertEquals(g.s("passcode"), made)
        val random = ServerBackupFormat.generatePasscode()
        assertTrue(random, Regex("^[${ServerBackupFormat.PASSCODE_ALPHABET}]{4}(-[${ServerBackupFormat.PASSCODE_ALPHABET}]{4}){4}$").matches(random))
        assertEquals("Café", ServerBackupFormat.normalizePasscode("  Café \n"))

        val small = kdf(b["slots"]!!.jsonObject["passcode"]!!.jsonObject["kdf"])
        for (n in b["normalize"]!!.jsonArray.map { it.jsonObject }) {
            assertEquals(n.s("kekHex"), HexUtil.encode(ServerBackupFormat.passcodeKek(n.s("input"), small)))
        }
        assertEquals(
            ServerBackupFormat.FormatException.Kind.DAMAGED,
            kindOf { ServerBackupFormat.passcodeKek("x", small.copy(m = 4)) },
        )
    }

    @Test fun theDefaultCostKekMatches() {
        val d = b["defaultParamsKdf"]!!.jsonObject
        val k = kdf(d["kdf"])
        assertEquals(ServerBackupFormat.DEFAULT_ARGON_M, k.m)
        assertEquals(ServerBackupFormat.DEFAULT_ARGON_T, k.t)
        assertEquals(ServerBackupFormat.DEFAULT_ARGON_P, k.p)
        assertEquals(d.s("kekHex"), HexUtil.encode(ServerBackupFormat.passcodeKek(d.s("passcode"), k)))
    }

    @Test fun theRestoreOrderMatchesTheVectorsAndRidesBesideThePairingOrder() {
        val seed = ServerKeys.deriveProtocolIrkSeed(r.hex("umkSeedHex"))
        val kp = Ed25519Sign.KeyPair.newKeyPairFromSeed(seed)
        assertEquals(r.s("pub"), HexUtil.encode(kp.publicKey))
        val signer = Ed25519Sign(kp.privateKey)
        for (c in r["cases"]!!.jsonArray.map { it.jsonObject }) {
            val o = c["order"]!!.jsonObject
            val order = ServerBackupFormat.RestoreOrder(
                serverDomain = o.s("serverDomain"),
                archiveId = o.s("archiveId"),
                bytes = o["bytes"]!!.jsonPrimitive.long,
                sha256 = o.s("sha256"),
                issuedAt = o["issuedAt"]!!.jsonPrimitive.long,
            )
            val canonical = order.canonicalBytes()
            assertEquals(c.s("canonical"), String(canonical, Charsets.UTF_8))
            assertEquals(c.s("signature"), HexUtil.encode(signer.sign(canonical)))
            Ed25519Verify(kp.publicKey).verify(c.hex("signature"), canonical)
            val json = ServerBackupFormat.attachRestore("{\"request\":{},\"signature\":\"ab\"}", order, c.s("signature"))
            val parsed = Json.parseToJsonElement(json).jsonObject
            val restore = parsed["restore"]!!.jsonObject
            assertEquals(c.s("signature"), restore.s("signatureHex"))
            assertEquals(o, restore["order"])
            assertEquals("ab", parsed.s("signature"))
        }
        for (bad in r["invalid"]!!.jsonArray.map { it.jsonObject }) {
            val order = ServerBackupFormat.RestoreOrder(
                serverDomain = bad.s("serverDomain"),
                archiveId = bad.s("archiveId"),
                bytes = bad["bytes"]!!.jsonPrimitive.long,
                sha256 = bad.s("sha256"),
                issuedAt = bad["issuedAt"]!!.jsonPrimitive.long,
            )
            assertNotNull(bad.toString(), kindOf { order.canonicalBytes() })
        }
    }

    @Test fun checksTheDataFileBySizeAndHash() = runBlocking {
        val raw = ServerBackupFormat.DATA_MAGIC.toByteArray() + ByteArray(5_000) { 3 }
        val sha = HexUtil.encode(MessageDigest.getInstance("SHA-256").digest(raw))
        val info = ServerBackupFormat.DataInfo("home.flagship-data", raw.size.toLong(), sha, 1 shl 20)
        val open = { ByteArrayInputStream(raw) }
        val seen = mutableListOf<Long>()
        ServerBackupFormat.checkDataFile(raw.size.toLong(), open, info, sliceBytes = 1_000) { seen += it }
        assertEquals(raw.size.toLong(), seen.last())
        assertEquals(6, seen.size)

        assertEquals(ServerBackupFormat.PickedKind.DATA, ServerBackupFormat.classify(raw.copyOf(64), raw.size.toLong()))
        assertEquals(ServerBackupFormat.PickedKind.BACKUP, ServerBackupFormat.classify("{\"magic\"".toByteArray(), 100))
        assertNull(ServerBackupFormat.classify("{\"magic\"".toByteArray(), ServerBackupFormat.BACKUP_FILE_MAX_BYTES + 1L))
        assertNull(ServerBackupFormat.classify("hello".toByteArray(), 5))

        suspend fun failure(size: Long, info: ServerBackupFormat.DataInfo, bytes: ByteArray = raw): ServerBackupFormat.DataCheckException? = try {
            ServerBackupFormat.checkDataFile(size, { ByteArrayInputStream(bytes) }, info, sliceBytes = 1_000)
            null
        } catch (e: ServerBackupFormat.DataCheckException) {
            e
        }
        val mismatch = failure(raw.size.toLong(), info.copy(sha256 = "00".repeat(32)))!!
        assertEquals(ServerBackupFormat.DataCheckException.Kind.MISMATCH, mismatch.kind)
        assertEquals("The data file doesn't match the backup file: it was changed or is damaged.", mismatch.message)
        val wrongSize = failure(raw.size.toLong(), info.copy(bytes = raw.size + 1L))!!
        assertEquals(ServerBackupFormat.DataCheckException.Kind.WRONG_SIZE, wrongSize.kind)
        assertEquals("That data file isn't this backup's (it should be home.flagship-data).", wrongSize.message)
        val notData = ByteArray(raw.size) { 1 }
        assertEquals(ServerBackupFormat.DataCheckException.Kind.NOT_DATA, failure(raw.size.toLong(), info, notData)!!.kind)
        val cut = raw.copyOf(raw.size - 10)
        assertEquals(ServerBackupFormat.DataCheckException.Kind.UNREADABLE, failure(raw.size.toLong(), info, cut)!!.kind)
    }
}
