// Kotlin parity for the sealed directory/profile-key delivery. Loads THE shared
// test-vectors/directory-key-delivery.json from disk (same walk-up pattern as
// CanonicalBytesVectorsTest) and asserts the OPEN direction byte-for-byte with
// the TS + web + Swift twins: each fixed sealed grant verifies under the pinned
// admin-root pub and unseals with the pinned recipient seed to the pinned key.
// Plus a negative matrix — every case must fail closed (null).

package com.flagshipserver.app.core

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.longOrNull
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.File

class AccountDirectoryKeyGrantTest {

    private val json = Json { ignoreUnknownKeys = true }

    private data class Vector(
        val name: String,
        val accountId: String,
        val recipientDeviceId: String,
        val keyKind: AccountDirectoryKeyGrant.KeyKind,
        val sealedKeyHex: String,
        val issuedAt: Long,
        val expiresAt: Long,
        val signerPubHex: String,
        val signature: ByteArray,
        val expectedKeyHex: String,
    )

    private class Loaded(
        val recipientSeed: ByteArray,
        val adminRootPub: ByteArray,
        val vectors: List<Vector>,
    )

    private fun vectorsFile(): File {
        val rel = "test-vectors/directory-key-delivery.json"
        val candidates = ArrayList<File>()
        System.getProperty("user.dir")?.let { candidates.add(File(it)) }
        try {
            val loc = javaClass.protectionDomain?.codeSource?.location
            if (loc != null) candidates.add(File(loc.toURI()))
        } catch (_: Throwable) {
            // user.dir walk is the primary path
        }
        for (start in candidates) {
            var dir: File? = start.absoluteFile
            var hops = 0
            while (dir != null && hops < 12) {
                val f = File(dir, rel)
                if (f.isFile) return f
                dir = dir.parentFile
                hops += 1
            }
        }
        fail("could not locate $rel from " + candidates.joinToString { it.absolutePath })
        error("unreachable")
    }

    private fun JsonObject.str(key: String): String = (this[key] as JsonPrimitive).content
    private fun JsonObject.long(key: String): Long =
        (this[key] as JsonPrimitive).longOrNull ?: error("field $key not a long")

    private fun load(): Loaded {
        val root = json.parseToJsonElement(vectorsFile().readText()).jsonObject
        val vectors = root["vectors"]!!.jsonArray.map { el ->
            val v = el.jsonObject
            val g = v["grant"]!!.jsonObject
            Vector(
                name = v.str("name"),
                accountId = g.str("accountId"),
                recipientDeviceId = g.str("recipientDeviceId"),
                keyKind = AccountDirectoryKeyGrant.KeyKind.fromWire(g.str("keyKind"))!!,
                sealedKeyHex = g.str("sealedKeyHex"),
                issuedAt = g.long("issuedAt"),
                expiresAt = g.long("expiresAt"),
                signerPubHex = g.str("signerPubHex"),
                signature = HexUtil.decode(v.str("signatureHex"))!!,
                expectedKeyHex = v.str("expectedKeyHex"),
            )
        }
        return Loaded(
            recipientSeed = HexUtil.decode(root.str("recipientSeedHex"))!!,
            adminRootPub = HexUtil.decode(root.str("adminRootPubHex"))!!,
            vectors = vectors,
        )
    }

    private fun openVector(
        loaded: Loaded,
        v: Vector = loaded.vectors[0],
        adminRootPub: ByteArray = loaded.adminRootPub,
        expectedAccountId: String = v.accountId,
        expectedRecipientDeviceId: String = v.recipientDeviceId,
        recipientDeviceSeed: ByteArray = loaded.recipientSeed,
        sealedKeyHex: String = v.sealedKeyHex,
        now: Long? = null,
    ): ByteArray? = AccountDirectoryKeyGrant.open(
        accountId = v.accountId,
        recipientDeviceId = v.recipientDeviceId,
        keyKind = v.keyKind,
        sealedKeyHex = sealedKeyHex,
        issuedAt = v.issuedAt,
        expiresAt = v.expiresAt,
        signerPubHex = v.signerPubHex,
        signature = v.signature,
        adminRootPub = adminRootPub,
        expectedAccountId = expectedAccountId,
        expectedRecipientDeviceId = expectedRecipientDeviceId,
        recipientDeviceSeed = recipientDeviceSeed,
        now = now,
    )

    @Test
    fun opensSharedGoldenVectorsToTheExactKey() {
        val loaded = load()
        assertTrue(loaded.vectors.isNotEmpty())
        for (v in loaded.vectors) {
            val key = openVector(loaded, v)
            assertNotNull("vector ${v.name} must open", key)
            assertEquals("vector ${v.name} key mismatch", v.expectedKeyHex, HexUtil.encode(key!!))
        }
    }

    @Test
    fun canonicalBytesMatchTheWireLayout() {
        val v = load().vectors[0]
        val bytes = AccountDirectoryKeyGrant.canonicalBytes(
            v.accountId, v.recipientDeviceId, v.keyKind, v.sealedKeyHex, v.issuedAt, v.expiresAt, v.signerPubHex,
        )
        val expected = listOf(
            "flagship/account-directory-key-grant/v1",
            v.accountId.lowercase(),
            v.recipientDeviceId,
            v.keyKind.wire,
            v.sealedKeyHex,
            v.issuedAt.toString(),
            v.expiresAt.toString(),
            v.signerPubHex,
        ).joinToString("|")
        assertEquals(expected, String(bytes, Charsets.UTF_8))
    }

    @Test
    fun rejectsWrongRecipientSeed() {
        val loaded = load()
        assertNull(openVector(loaded, recipientDeviceSeed = ByteArray(32) { 13 }))
    }

    @Test
    fun rejectsMismatchedDeviceId() {
        val loaded = load()
        assertNull(openVector(loaded, expectedRecipientDeviceId = "ffeeddccbbaa99887766554433221100"))
    }

    @Test
    fun rejectsMismatchedAccount() {
        val loaded = load()
        assertNull(openVector(loaded, expectedAccountId = "someone-else"))
    }

    @Test
    fun rejectsForgedAdminRoot() {
        val loaded = load()
        assertNull(openVector(loaded, adminRootPub = ByteArray(32) { 0x99.toByte() }))
    }

    @Test
    fun rejectsTamperedSealedKey() {
        val loaded = load()
        val hex = loaded.vectors[0].sealedKeyHex
        val flipped = hex.dropLast(1) + if (hex.last() == '0') '1' else '0'
        assertNull(openVector(loaded, sealedKeyHex = flipped))
    }

    @Test
    fun rejectsExpiredGrant() {
        val loaded = load()
        assertNull(openVector(loaded, now = loaded.vectors[0].expiresAt + 1))
    }
}
