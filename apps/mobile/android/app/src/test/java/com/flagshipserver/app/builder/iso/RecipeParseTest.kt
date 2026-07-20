package com.flagshipserver.app.builder.iso

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class RecipeParseTest {
    private fun flattened(serial: String = "srv-abc123", expiresAt: Long? = null): String {
        val exp = expiresAt?.let { ",\"expiresAt\":$it" } ?: ""
        return """
          {
            "serverDomain":"home.alice.flagship.services",
            "serverName":"Home",
            "username":"alice",
            "blobSignatureHex":"deadbeef",
            "authCode":{"serial":"$serial","expiresAt":${expiresAt ?: 0}$exp}
          }
        """.trimIndent()
    }

    @Test
    fun parsesFlattenedRecipe() {
        val r = RecipeParse.parse(flattened())
        assertEquals("srv-abc123", r.serial)
        assertEquals("home.alice.flagship.services", r.serverDomain)
        assertEquals("Home", r.serverName)
        assertEquals("alice", r.username)
        assertEquals("deadbeef", r.blobSignatureHex)
    }

    @Test
    fun parsesEnvelopeForm() {
        val raw = """
          {
            "blob":{
              "serverDomain":"box.bob.flagship.services",
              "serverName":"Box",
              "username":"bob",
              "authCode":{"serial":"srv-xyz"}
            },
            "blobSignature":"cafe"
          }
        """.trimIndent()
        val r = RecipeParse.parse(raw)
        assertEquals("srv-xyz", r.serial)
        assertEquals("box.bob.flagship.services", r.serverDomain)
        assertEquals("bob", r.username)
        assertEquals("cafe", r.blobSignatureHex)
    }

    @Test
    fun expiryReflected() {
        val past = System.currentTimeMillis() - 60_000
        val future = System.currentTimeMillis() + 600_000
        assertTrue(RecipeParse.parse(flattened(expiresAt = past)).expired)
        assertFalse(RecipeParse.parse(flattened(expiresAt = future)).expired)
    }

    @Test
    fun missingSignatureRejected() {
        val raw = """{"serverDomain":"a.b.c","username":"u","authCode":{"serial":"s"}}"""
        assertThrows(RecipeParseException::class.java) { RecipeParse.parse(raw) }
    }

    @Test
    fun missingAuthCodeRejected() {
        val raw = """{"serverDomain":"a.b.c","username":"u","blobSignatureHex":"ab"}"""
        assertThrows(RecipeParseException::class.java) { RecipeParse.parse(raw) }
    }

    @Test
    fun emptyAndGarbageRejected() {
        assertThrows(RecipeParseException::class.java) { RecipeParse.parse("") }
        assertThrows(RecipeParseException::class.java) { RecipeParse.parse("not json") }
    }
}
