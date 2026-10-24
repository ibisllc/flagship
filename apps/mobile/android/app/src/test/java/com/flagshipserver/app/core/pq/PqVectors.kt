package com.flagshipserver.app.core.pq

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.fail
import java.io.File

/** Finds a shared vector file under packages/protocol/test-vectors/ above the test's directory. */
internal object PqVectors {
    fun load(rel: String): JsonObject {
        var dir: File? = File(System.getProperty("user.dir")!!).absoluteFile
        var hops = 0
        while (dir != null && hops < 14) {
            val f = File(dir, rel)
            if (f.isFile) return Json.parseToJsonElement(f.readText()).jsonObject
            dir = dir.parentFile; hops++
        }
        fail("could not locate $rel"); error("unreachable")
    }

    fun h(s: String): ByteArray = PqHex.decode(s) ?: error("bad hex in vectors")
    fun x(b: ByteArray): String = PqHex.encode(b)
}
