// Runs packages/protocol/test-vectors/offline-secrets/vectors.json (SEC-RECIPE-001).

package com.flagshipserver.app.core

import com.google.crypto.tink.subtle.Ed25519Sign
import com.google.crypto.tink.subtle.Ed25519Verify
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test
import java.io.File

class OfflineSecretsVectorsTest {
    private fun vectors() = run {
        val rel = "packages/protocol/test-vectors/offline-secrets/vectors.json"
        var dir: File? = File(System.getProperty("user.dir")!!).absoluteFile
        var found: File? = null
        var hops = 0
        while (dir != null && hops < 14 && found == null) {
            val f = File(dir, rel)
            if (f.isFile) found = f
            dir = dir.parentFile
            hops += 1
        }
        Json.parseToJsonElement(requireNotNull(found) { "could not locate $rel" }.readText()).jsonObject
    }

    @Test
    fun canonicalBytesAndSignatureMatchTheVector() {
        val v = vectors()
        val sibling = v["cases"]!!.jsonArray[0].jsonObject["sibling"]!!.jsonObject
        val swkHex = v["cases"]!!.jsonArray[0].jsonObject["swkHex"]!!.jsonPrimitive.content
        val sha = OfflineSecretsCommitment.commitmentTo(swkHex)
        assertEquals(sibling["swkSha256Hex"]!!.jsonPrimitive.content, sha)
        val issuedAt = sibling["issuedAt"]!!.jsonPrimitive.long
        val canon = OfflineSecretsCommitment.canonicalBytes(
            sibling["serverDomain"]!!.jsonPrimitive.content, sibling["serial"]!!.jsonPrimitive.content, sha, issuedAt,
        )
        assertEquals(v["canonicalOfGood"]!!.jsonPrimitive.content, String(canon, Charsets.UTF_8))
        val seed = HexUtil.decode(v["userSeedHex"]!!.jsonPrimitive.content)!!
        val pub = HexUtil.decode(v["userPubHex"]!!.jsonPrimitive.content)!!
        val signed = OfflineSecretsCommitment.sign(
            sibling["serverDomain"]!!.jsonPrimitive.content, sibling["serial"]!!.jsonPrimitive.content, swkHex, issuedAt,
        ) { Ed25519Sign(seed).sign(it) }
        Ed25519Verify(pub).verify(HexUtil.decode(signed.signatureHex)!!, canon)
        Ed25519Verify(pub).verify(HexUtil.decode(sibling["signatureHex"]!!.jsonPrimitive.content)!!, canon)
    }

    @Test
    fun malformedFieldsAreRefused() {
        assertThrows(IllegalArgumentException::class.java) { OfflineSecretsCommitment.commitmentTo("zz") }
        assertThrows(IllegalArgumentException::class.java) {
            OfflineSecretsCommitment.canonicalBytes("a|b", "s", "0".repeat(64), 1)
        }
    }
}
