// The recipe the phone hands to the preseed engine and to Studio is encoded
// with the default Json (encodeDefaults=false). Pins that the fields with
// defaults are still written, as the webapp's onWireBlob does: the engine's
// parseInstallBlob rejects a blob without `version` ("InstallBlob fields
// incomplete/malformed"), which broke Burn to USB and recipe delivery.

package com.flagshipserver.app.core

import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class InstallBlobWireJsonTest {

    private fun bundle() = InstallBlobBundle(
        blob = WireBlob(
            serverDomain = "home.alice.flagship.services",
            username = "alice",
            serverName = "home",
            phoneDelegatedPubKey = "00".repeat(32),
            authCode = WireAuthCode(
                serial = "ABC",
                username = "alice",
                serverName = "home",
                serverDomain = "home.alice.flagship.services",
                delegatedPubKey = "11".repeat(32),
                userPubKey = "22".repeat(32),
                issuedAt = 1L,
                expiresAt = 2L,
            ),
            authCodeUserSignature = "33".repeat(64),
            rckPubKey = "44".repeat(32),
        ),
        blobSignature = "55".repeat(64),
    )

    @Test fun defaultsAreWritten_whenEncodedWithTheDefaultJson() {
        val json = Json.encodeToString(InstallBlobBundle.serializer(), bundle())
        val blob = Json.parseToJsonElement(json).jsonObject["blob"]!!.jsonObject
        assertEquals(2, blob["version"]!!.jsonPrimitive.int)
        assertTrue(blob["registrationUrl"]!!.jsonPrimitive.content.startsWith("https://"))
        assertEquals("main", blob["installerGitRef"]!!.jsonPrimitive.content)
        val code = blob["authCode"]!!.jsonObject as JsonObject
        assertEquals(1, code["version"]!!.jsonPrimitive.int)
    }

    @Test fun absentOptionalSiblingsStayOut() {
        val root = Json.parseToJsonElement(
            Json.encodeToString(InstallBlobBundle.serializer(), bundle()),
        ).jsonObject
        assertTrue("pairingOrder" !in root)
        assertTrue("swkHex" !in root)
        assertTrue("debugGrant" !in root)
        assertTrue("bootUnlockMode" !in root["blob"]!!.jsonObject)
    }
}
