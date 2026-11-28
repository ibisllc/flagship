// packages/protocol/test-vectors/ed25519-strict: the app-side verify (CheckedEd25519Verify: the key check, then Tink)
// is strict (cofactorless, canonical R and S): it refuses the mixed-order R that ZIP-215 accepts and verifies the
// honest signature.

package com.flagshipserver.app.core

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.File

class Ed25519StrictVectorsTest {
    private fun vectorsFile(): File {
        val rel = "packages/protocol/test-vectors/ed25519-strict/vectors.json"
        var dir: File? = File(System.getProperty("user.dir") ?: ".").absoluteFile
        var hops = 0
        while (dir != null && hops < 14) {
            val f = File(dir, rel)
            if (f.isFile) return f
            dir = dir.parentFile
            hops += 1
        }
        fail("could not locate $rel")
        error("unreachable")
    }

    @Test fun mixedOrderRIsRefusedAndTheHonestSignatureVerifies() {
        val v = Json.parseToJsonElement(vectorsFile().readText()).jsonObject
        fun field(k: String) = HexUtil.decode(v[k]!!.jsonPrimitive.content)!!
        val verifier = CheckedEd25519Verify(field("publicKeyHex"))
        val msg = field("messageHex")
        assertFalse(runCatching { verifier.verify(field("mixedOrderRSignatureHex"), msg) }.isSuccess)
        assertTrue(runCatching { verifier.verify(field("honestSignatureHex"), msg) }.isSuccess)
    }
}
