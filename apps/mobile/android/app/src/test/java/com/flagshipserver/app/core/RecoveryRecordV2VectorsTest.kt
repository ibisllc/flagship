// Runs packages/protocol/test-vectors/recovery-record/vectors.json (N03).

package com.flagshipserver.app.core

import com.google.crypto.tink.subtle.Ed25519Sign
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class RecoveryRecordV2VectorsTest {
    private val json = Json { ignoreUnknownKeys = true }

    private fun vectors() = run {
        val rel = "packages/protocol/test-vectors/recovery-record/vectors.json"
        var dir: File? = File(System.getProperty("user.dir")!!).absoluteFile
        var found: File? = null
        var hops = 0
        while (dir != null && hops < 14 && found == null) {
            val f = File(dir, rel)
            if (f.isFile) found = f
            dir = dir.parentFile
            hops += 1
        }
        json.parseToJsonElement(requireNotNull(found) { "could not locate $rel" }.readText()).jsonObject
    }

    private val h64 = "e".repeat(64)

    @Test
    fun canonicalBytesDigestAndSignatureMatchTheSharedVector() {
        val v = vectors()
        val rec = json.decodeFromJsonElement(RecoveryRecordV2.serializer(), v["record"]!!)
        assertEquals(v["canonical"]!!.jsonPrimitive.content, String(rec.canonicalBytes(), Charsets.UTF_8))
        assertEquals(v["digestHex"]!!.jsonPrimitive.content, rec.digestHex())
        val seed = HexUtil.decode(v["userSeedHex"]!!.jsonPrimitive.content)!!
        val pub = HexUtil.decode(v["userPubHex"]!!.jsonPrimitive.content)!!
        assertTrue(rec.verify(v["signatureHex"]!!.jsonPrimitive.content, pub))
        assertTrue(rec.verify(HexUtil.encode(Ed25519Sign(seed).sign(rec.canonicalBytes())), pub))
    }

    @Test
    fun everyOneFieldChangeBreaksTheSignature() {
        val v = vectors()
        val rec = json.decodeFromJsonElement(RecoveryRecordV2.serializer(), v["record"]!!)
        val sig = v["signatureHex"]!!.jsonPrimitive.content
        val pub = HexUtil.decode(v["userPubHex"]!!.jsonPrimitive.content)!!
        val changed = listOf(
            rec.copy(op = "delete"), rec.copy(username = "bob"), rec.copy(credentialIdHex = "c0ffee00c0ffee01"),
            rec.copy(wrappedUmkDigestHex = "5".repeat(64)), rec.copy(adminRoot = RecoveryEscrowChange.replace("6".repeat(64))),
            rec.copy(acmeKey = RecoveryEscrowChange.replace("7".repeat(64))), rec.copy(fetchTokenHashHex = "8".repeat(64)),
            rec.copy(prfSaltHashHex = "9".repeat(64)), rec.copy(generation = 2), rec.copy(nonceHex = "10".repeat(16)),
            rec.copy(priorDigestHex = "legacy"), rec.copy(issuedAt = rec.issuedAt + 1),
        )
        for (c in changed) assertFalse(c.verify(sig, pub))
    }

    @Test
    fun unknownVersionsAndMalformedFieldsCannotBeSigned() {
        val rec = json.decodeFromJsonElement(RecoveryRecordV2.serializer(), vectors()["record"]!!)
        for (bad in listOf(
            rec.copy(kdfVersion = 2), rec.copy(algVersion = 9), rec.copy(policy = "anything"), rec.copy(generation = 0),
            rec.copy(nonceHex = "00"), rec.copy(priorDigestHex = "later"), rec.copy(generation = 2, priorDigestHex = "genesis"),
            rec.copy(username = "a|b"), rec.copy(issuedAt = -1), rec.copy(adminRoot = RecoveryEscrowChange.keep("xyz")),
        )) {
            assertThrows(IllegalArgumentException::class.java) { bad.canonicalBytes() }
        }
    }

    @Test
    fun chainBuilderSaysKeepReplaceOrNoneExplicitly() {
        val umk = java.util.Base64.getEncoder().encodeToString(byteArrayOf(1, 2, 3))
        val first = RecoveryRecordChain.next("Alice", h64, null, null, "c0ffee00c0ffee00", umk, null, null, h64, h64, 1)
        assertEquals(1, first.generation); assertEquals("genesis", first.priorDigestHex)
        assertEquals(RecoveryEscrowChange.none, first.adminRoot); assertEquals(RecoveryEscrowChange.none, first.acmeKey)
        val state = RecoveryRecordState("c0ffee00c0ffee00", h64, false, 1, first.digestHex(), h64)
        val second = RecoveryRecordChain.next("Alice", h64, null, state, "c0ffee00c0ffee00", umk, null, null, h64, h64, 2)
        assertEquals(2, second.generation); assertEquals(first.digestHex(), second.priorDigestHex)
        assertEquals(RecoveryEscrowChange.keep(h64), second.adminRoot)
        val legacy = RecoveryRecordState("c0ffee00c0ffee00", h64, true)
        val admin = java.util.Base64.getEncoder().encodeToString(byteArrayOf(9))
        val upgrade = RecoveryRecordChain.next("Alice", h64, null, legacy, "c0ffee00c0ffee00", umk, admin, null, h64, h64, 3)
        assertEquals(1, upgrade.generation); assertEquals("legacy", upgrade.priorDigestHex)
        assertEquals("replace", upgrade.adminRoot.change)
    }

    @Test
    fun ciphertextMismatchIsFoundBeforeAnythingIsUnwrapped() {
        val b64 = { b: ByteArray -> java.util.Base64.getEncoder().encodeToString(b) }
        val umk = b64(byteArrayOf(1, 2, 3)); val admin = b64(byteArrayOf(4, 5))
        val claim = RecoveryRecordChain.next("a", h64, null, null, "c0ffee00c0ffee00", umk, admin, null, h64, h64, 1)
        assertNull(claim.ciphertextMismatch(umk, admin, null))
        assertEquals("wrappedUmk", claim.ciphertextMismatch(b64(byteArrayOf(9)), admin, null))
        assertEquals("wrappedAdminRoot", claim.ciphertextMismatch(umk, b64(byteArrayOf(9)), null))
        assertEquals("wrappedAdminRoot", claim.ciphertextMismatch(umk, null, null))
        assertEquals("wrappedAcmeAccountKey", claim.ciphertextMismatch(umk, admin, b64(byteArrayOf(7))))
        assertNotNull(claim)
    }
}
