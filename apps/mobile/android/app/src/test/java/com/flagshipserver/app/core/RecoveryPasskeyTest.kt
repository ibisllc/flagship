package com.flagshipserver.app.core

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.fail
import org.junit.Test
import java.io.File

class RecoveryPasskeyTest {
    private fun vectors(): JsonObject {
        val rel = "packages/protocol/test-vectors/recovery-passkey/vectors.json"
        var dir: File? = File(System.getProperty("user.dir")!!).absoluteFile
        while (dir != null) {
            val f = File(dir, rel)
            if (f.isFile) return Json.parseToJsonElement(f.readText()).jsonObject
            dir = dir.parentFile
        }
        fail("vectors.json not found"); throw IllegalStateException()
    }

    private fun JsonObject.s(k: String) = this[k]!!.jsonPrimitive.content

    @Test
    fun buildsTheFieldsComChecksFromCredentialManagerJson() {
        val v = vectors()
        val challenge = v.s("challenge")
        for (e in v["entries"]!!.jsonArray) {
            val entry = e.jsonObject
            val a = entry["assertion"]!!.jsonObject
            val registration = buildJsonObject { put("response", buildJsonObject { put("attestationObject", entry.s("attestationObject")) }) }.toString()
            assertEquals(entry.s("attestationObject"), RecoveryPasskey.attestationField(registration))
            val auth = buildJsonObject {
                put("id", a.s("credentialId")); put("rawId", a.s("credentialId"))
                put("response", buildJsonObject {
                    put("authenticatorData", a.s("authenticatorData")); put("clientDataJSON", a.s("clientDataJSON")); put("signature", a.s("signature"))
                })
            }.toString()
            val field = RecoveryPasskey.fetchPasskeyField(challenge, auth)
            assertEquals(challenge, field.s("challenge"))
            val got = field["assertion"]!!.jsonObject
            for (k in listOf("credentialId", "authenticatorData", "clientDataJSON", "signature")) assertEquals(k, a.s(k), got.s(k))
        }
    }
}
