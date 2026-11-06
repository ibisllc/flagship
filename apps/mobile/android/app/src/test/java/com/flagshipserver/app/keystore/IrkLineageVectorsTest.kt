// Runs packages/protocol/test-vectors/irk-lineage/vectors.json (tools/irk-lineage-vectors.mjs):
// every client's IRK derivation, the registered key found from the UMK, and the key this app
// rotates to on a key-file import.

package com.flagshipserver.app.keystore

import com.flagshipserver.app.core.HexUtil
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.fail
import org.junit.Test
import java.io.File

class IrkLineageVectorsTest {

    private fun vectors(): JsonObject {
        val rel = "packages/protocol/test-vectors/irk-lineage/vectors.json"
        var dir: File? = File(System.getProperty("user.dir") ?: ".").absoluteFile
        var hops = 0
        while (dir != null && hops < 14) {
            val f = File(dir, rel)
            if (f.isFile) return Json.parseToJsonElement(f.readText()).jsonObject
            dir = dir.parentFile
            hops += 1
        }
        fail("could not locate $rel")
        error("unreachable")
    }

    private fun scheme(s: String) = IrkLineage.Scheme.valueOf(s.uppercase())

    @Test
    fun everySchemeMatchesTheVectors() {
        val v = vectors()
        val umk = HexUtil.decode(v["umkSeedHex"]!!.jsonPrimitive.content)!!
        for (k in v["keys"]!!.jsonArray) {
            val o = k.jsonObject
            val key = IrkLineage.key(umk, scheme(o["scheme"]!!.jsonPrimitive.content), o["version"]!!.jsonPrimitive.int)
            assertEquals(o["seedHex"]!!.jsonPrimitive.content, HexUtil.encode(key.seed))
            assertEquals(o["pubHex"]!!.jsonPrimitive.content, key.pubHex)
        }
    }

    @Test
    fun findsTheRegisteredKeyAndRotatesPastIt() {
        val v = vectors()
        val umk = HexUtil.decode(v["umkSeedHex"]!!.jsonPrimitive.content)!!
        for (c in v["imports"]!!.jsonArray) {
            val o = c.jsonObject
            val name = o["name"]!!.jsonPrimitive.content
            val found = IrkLineage.findRegistered(umk, o["registeredPubHex"]!!.jsonPrimitive.content)
            assertNotNull(name, found)
            val reg = o["registered"]!!.jsonObject
            assertEquals(name, scheme(reg["scheme"]!!.jsonPrimitive.content), found!!.scheme)
            assertEquals(name, reg["version"]!!.jsonPrimitive.int, found.version)
            val next = o["importer"]!!.jsonObject["android"]!!.jsonObject
            val newVersion = IrkLineage.nextVersion(found)
            assertEquals(name, next["newVersion"]!!.jsonPrimitive.int, newVersion)
            assertEquals(name, next["newPubHex"]!!.jsonPrimitive.content, IrkLineage.key(umk, IrkLineage.OWN, newVersion).pubHex)
        }
        for (c in v["noMatch"]!!.jsonArray) {
            assertNull(IrkLineage.findRegistered(umk, c.jsonObject["registeredPubHex"]!!.jsonPrimitive.content))
        }
    }
}
