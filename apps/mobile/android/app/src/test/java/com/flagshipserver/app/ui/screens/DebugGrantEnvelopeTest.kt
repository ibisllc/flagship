package com.flagshipserver.app.ui.screens

import com.flagshipserver.app.core.DebugAccess
import com.flagshipserver.app.core.HexUtil
import com.flagshipserver.app.core.InstallBlobBundle
import com.flagshipserver.app.core.WireAuthCode
import com.flagshipserver.app.core.WireBlob
import com.google.crypto.tink.subtle.Ed25519Sign
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The Advanced "Debug-friendly server" toggle bakes an owner-IRK-signed
 * debug-access grant into the recipe as the UNSIGNED `debugGrant` sibling.
 * Mirror of the iOS CreateServerViewModel debug-grant tests: the grant verifies
 * under the owner IRK (byte-identical canonical) when ON, and the recipe carries
 * no `debugGrant` when OFF.
 */
class DebugGrantEnvelopeTest {
    // pub for seed 0x07*32 (the same TS-derived pub used in DebugAccessTest).
    private val irkPub =
        HexUtil.decode("ea4a6c63e29c520abef5507b132ec5f9954776aebebe7b92421eea691446d22c")!!

    @Test fun debugToggleOn_embedsGrantThatVerifiesUnderOwnerIrk() {
        val irk = Ed25519Sign(ByteArray(32) { 7 }) // pub == irkPub
        val serverDomain = "home.harry.flagship.services"
        val envelope = debugGrantEnvelope(serverDomain, irk, now = 1700L)

        val obj = Json.parseToJsonElement(envelope).jsonObject
        val g = obj["grant"]!!.jsonObject
        val grant = DebugAccess.Grant(
            serverDomain = g["serverDomain"]!!.jsonPrimitive.content,
            sshAuthorizedKey = g["sshAuthorizedKey"]!!.jsonPrimitive.content,
            issuedAt = g["issuedAt"]!!.jsonPrimitive.content.toLong(),
        )
        // Console-only grant (empty sshAuthorizedKey), signed at mint.
        assertEquals(serverDomain, grant.serverDomain)
        assertEquals("", grant.sshAuthorizedKey)
        assertEquals(1700L, grant.issuedAt)
        // Byte-identical canonical bytes (no box STK).
        assertEquals(
            "flagship/debug-access/v1|home.harry.flagship.services||1700",
            String(DebugAccess.canonicalBytes(grant)),
        )
        // The embedded signature verifies under the owner IRK pub.
        assertTrue(
            DebugAccess.verify(grant, obj["signatureHex"]!!.jsonPrimitive.content, irkPub),
        )
    }

    @Test fun toggleOff_recipeHasNoDebugGrant() {
        // A bundle without a debug grant omits the sibling from the wire JSON
        // (encodeDefaults=false), so a non-debug recipe is byte-identical.
        val json = Json.encodeToString(InstallBlobBundle.serializer(), sampleBundle(debugGrant = null))
        assertFalse("a non-debug recipe must omit debugGrant", json.contains("debugGrant"))
    }

    @Test fun toggleOn_recipeCarriesDebugGrant() {
        val irk = Ed25519Sign(ByteArray(32) { 7 })
        val envelope = debugGrantEnvelope("home.harry.flagship.services", irk, now = 1700L)
        val json = Json.encodeToString(InstallBlobBundle.serializer(), sampleBundle(debugGrant = envelope))
        assertTrue("a debug recipe must carry debugGrant", json.contains("debugGrant"))
    }

    private fun sampleBundle(debugGrant: String?) = InstallBlobBundle(
        blob = WireBlob(
            serverDomain = "home.harry.flagship.services",
            username = "harry",
            serverName = "home",
            phoneDelegatedPubKey = "00",
            authCode = WireAuthCode(
                serial = "S",
                username = "harry",
                serverName = "home",
                serverDomain = "home.harry.flagship.services",
                delegatedPubKey = "00",
                userPubKey = "00",
                issuedAt = 1L,
                expiresAt = 2L,
            ),
            authCodeUserSignature = "00",
            rckPubKey = "00",
        ),
        blobSignature = "00",
        debugGrant = debugGrant,
    )
}
